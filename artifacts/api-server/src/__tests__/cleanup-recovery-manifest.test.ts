import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://cleanup-recovery-test.invalid/willard";

const {
  appendTrashManifestEntry,
  manifestPath,
  readTrashManifest,
  removeTrashManifestEntry,
  reconcileCleanupOperations,
} = await import("../lib/cleanup-recovery.ts");
const { pool } = await import("@workspace/db");

test("trash manifest preserves library identity and integrity metadata", () => {
  const nasPath = fs.mkdtempSync(path.join(os.tmpdir(), "willard-trash-manifest-"));
  const trashPath = path.join(nasPath, "WillardAI", ".Trash", "session", "7_photo.jpg");
  try {
    appendTrashManifestEntry(nasPath, {
      ts: "2026-08-26T00:00:00.000Z",
      nasPath,
      mediaFileId: 7,
      relativePath: "photos/photo.jpg",
      originalPath: path.join(nasPath, "photos", "photo.jpg"),
      trashPath,
      sizeBytes: 1234,
      contentHash: "a".repeat(64),
      expiresAt: "2026-09-25T00:00:00.000Z",
    });

    const { entries } = readTrashManifest(nasPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.nasPath, nasPath);
    assert.equal(entries[0]?.mediaFileId, 7);
    assert.equal(entries[0]?.contentHash, "a".repeat(64));
    assert.equal(entries[0]?.sizeBytes, 1234);
  } finally {
    fs.rmSync(nasPath, { recursive: true, force: true });
  }
});

test("removing one manifest entry is idempotent and preserves unknown lines", () => {
  const nasPath = fs.mkdtempSync(path.join(os.tmpdir(), "willard-trash-manifest-"));
  const trashRoot = path.join(nasPath, "WillardAI", ".Trash", "session");
  const firstTrashPath = path.join(trashRoot, "1_first.jpg");
  const secondTrashPath = path.join(trashRoot, "2_second.jpg");
  try {
    appendTrashManifestEntry(nasPath, {
      nasPath,
      originalPath: path.join(nasPath, "first.jpg"),
      trashPath: firstTrashPath,
      sizeBytes: 1,
    });
    appendTrashManifestEntry(nasPath, {
      nasPath,
      originalPath: path.join(nasPath, "second.jpg"),
      trashPath: secondTrashPath,
      sizeBytes: 2,
    });
    fs.appendFileSync(manifestPath(nasPath), "{not-json}\n");

    assert.equal(removeTrashManifestEntry(nasPath, firstTrashPath, "restore-one"), true);
    assert.equal(removeTrashManifestEntry(nasPath, firstTrashPath, "restore-two"), false);

    const raw = fs.readFileSync(manifestPath(nasPath), "utf8");
    assert.match(raw, /2_second\.jpg/);
    assert.match(raw, /\{not-json\}/);
    assert.doesNotMatch(raw, /1_first\.jpg/);
  } finally {
    fs.rmSync(nasPath, { recursive: true, force: true });
  }
});

test("manifest removal cannot target a path outside the active trash root", () => {
  const nasPath = fs.mkdtempSync(path.join(os.tmpdir(), "willard-trash-manifest-"));
  const outsidePath = path.join(nasPath, "outside.txt");
  try {
    appendTrashManifestEntry(nasPath, {
      nasPath,
      originalPath: path.join(nasPath, "photo.jpg"),
      trashPath: outsidePath,
      sizeBytes: 1,
    });

    assert.equal(removeTrashManifestEntry(nasPath, outsidePath, "restore-outside"), false);
    assert.match(fs.readFileSync(manifestPath(nasPath), "utf8"), /outside\.txt/);
  } finally {
    fs.rmSync(nasPath, { recursive: true, force: true });
  }
});

test("recovery resumes a filesystem-complete restore and converges all durable state", async (t) => {
  let activeRoot: string | undefined;
  try {
    await pool.query("SELECT 1");
    const settings = await pool.query<{ nas_path: string }>(
      "SELECT nas_path FROM app_settings WHERE nas_path IS NOT NULL LIMIT 1",
    );
    activeRoot = settings.rows[0]?.nas_path;
  } catch {
    t.skip("requires the configured PostgreSQL test database");
    return;
  }
  if (!activeRoot) {
    t.skip("requires an active library root");
    return;
  }

  const relativePath = `__restore-recovery-test__/${crypto.randomUUID()}.txt`;
  const destination = path.join(activeRoot, relativePath);
  const trashPath = path.join(activeRoot, "WillardAI", ".Trash", "recovery-session", path.basename(destination));
  const content = "restore recovery integrity";
  const contentHash = crypto.createHash("sha256").update(content).digest("hex");
  let mediaId = 0;
  const operationId = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
    const media = await pool.query<{ id: number }>(
      `INSERT INTO media_files
        (nas_path, relative_path, name, extension, mime_type, media_type, size_bytes, content_hash, last_scan_action)
       VALUES ($1, $2, $3, 'txt', 'text/plain', 'document', $4, $5, 'RECYCLED')
       RETURNING id`,
      [activeRoot, relativePath, path.basename(destination), Buffer.byteLength(content), contentHash],
    );
    mediaId = media.rows[0]!.id;
    appendTrashManifestEntry(activeRoot, {
      nasPath: activeRoot,
      mediaFileId: mediaId,
      originalPath: destination,
      trashPath,
      sizeBytes: Buffer.byteLength(content),
      contentHash,
    });
    await pool.query(
      `INSERT INTO cleanup_operations
        (operation_id, nas_path, media_file_id, operation_type, source_path, trash_path, size_bytes, status)
       VALUES ($1, $2, $3, 'RESTORE', $4, $5, $6, 'FILESYSTEM_MOVED')`,
      [operationId, activeRoot, mediaId, trashPath, destination, Buffer.byteLength(content)],
    );

    await reconcileCleanupOperations();

    const operation = await pool.query<{ status: string }>(
      "SELECT status FROM cleanup_operations WHERE operation_id = $1",
      [operationId],
    );
    const row = await pool.query<{ last_scan_action: string | null }>(
      "SELECT last_scan_action FROM media_files WHERE id = $1",
      [mediaId],
    );
    assert.equal(operation.rows[0]?.status, "RECORDED");
    assert.equal(row.rows[0]?.last_scan_action, null);
    assert.equal(readTrashManifest(activeRoot).entries.some((entry) => entry.trashPath === trashPath), false);
    assert.equal(fs.existsSync(destination), true);
    assert.equal(fs.existsSync(trashPath), false);
  } finally {
    if (operationId) await pool.query("DELETE FROM cleanup_operations WHERE operation_id = $1", [operationId]);
    if (mediaId) await pool.query("DELETE FROM media_files WHERE id = $1", [mediaId]);
    fs.rmSync(path.join(activeRoot, "__restore-recovery-test__"), { recursive: true, force: true });
    fs.rmSync(path.join(activeRoot, "WillardAI", ".Trash", "recovery-session"), { recursive: true, force: true });
  }
});

test("recovery quarantines a restore manifest with no canonical row", async (t) => {
  let activeRoot: string | undefined;
  try {
    await pool.query("SELECT 1");
    const settings = await pool.query<{ nas_path: string }>(
      "SELECT nas_path FROM app_settings WHERE nas_path IS NOT NULL LIMIT 1",
    );
    activeRoot = settings.rows[0]?.nas_path;
  } catch {
    t.skip("requires the configured PostgreSQL test database");
    return;
  }
  if (!activeRoot) {
    t.skip("requires an active library root");
    return;
  }

  const operationId = crypto.randomUUID();
  const trashPath = path.join(activeRoot, "WillardAI", ".Trash", "stale-session", `${operationId}.txt`);
  const destination = path.join(activeRoot, "__stale-restore-test__", `${operationId}.txt`);
  try {
    fs.mkdirSync(path.dirname(trashPath), { recursive: true });
    fs.writeFileSync(trashPath, "stale manifest");
    appendTrashManifestEntry(activeRoot, {
      nasPath: activeRoot,
      originalPath: destination,
      trashPath,
      sizeBytes: 14,
    });
    await pool.query(
      `INSERT INTO cleanup_operations
        (operation_id, nas_path, media_file_id, operation_type, source_path, trash_path, size_bytes, status)
       VALUES ($1, $2, NULL, 'RESTORE', $3, $4, 14, 'MOVING')`,
      [operationId, activeRoot, trashPath, destination],
    );

    await reconcileCleanupOperations();

    const operation = await pool.query<{ status: string; error: string | null }>(
      "SELECT status, error FROM cleanup_operations WHERE operation_id = $1",
      [operationId],
    );
    assert.equal(operation.rows[0]?.status, "NEEDS_REVIEW");
    assert.match(operation.rows[0]?.error ?? "", /canonical media row/i);
    assert.equal(fs.existsSync(trashPath), true);
    assert.equal(fs.existsSync(destination), false);
  } finally {
    await pool.query("DELETE FROM cleanup_operations WHERE operation_id = $1", [operationId]);
    fs.rmSync(path.join(activeRoot, "WillardAI", ".Trash", "stale-session"), { recursive: true, force: true });
    fs.rmSync(path.join(activeRoot, "__stale-restore-test__"), { recursive: true, force: true });
  }
});