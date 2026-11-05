import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
const { isTrashEntryExpired } = await import("../lib/cleanup-retention.ts");

test("manual restore and startup recovery use no-replace moves", () => {
  const sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cleanupRoute = fs.readFileSync(path.join(sourceDir, "routes", "cleanup.ts"), "utf8");
  const recoverySource = fs.readFileSync(path.join(sourceDir, "lib", "cleanup-recovery.ts"), "utf8");
  assert.match(cleanupRoute, /moveFileNoReplace\(resolvedTrashPath, resolvedOriginalPath\)/);
  assert.match(cleanupRoute, /moveFileNoReplace\(resolvedOriginalPath, resolvedTrashPath\)/);
  assert.match(cleanupRoute, /resolveLibraryTrashPath\(trashPath, nasPath\)/);
  assert.match(cleanupRoute, /resolveLibraryTrashPath\(e\.trashPath, nasPath\)/);
  assert.match(recoverySource, /moveFileNoReplace\(sourceTrash, destination\)/);
});

test("trash retention fails closed when expiration metadata is missing or malformed", () => {
  const now = Date.parse("2026-11-04T12:00:00.000Z");
  assert.equal(isTrashEntryExpired(undefined, now), false);
  assert.equal(isTrashEntryExpired("", now), false);
  assert.equal(isTrashEntryExpired("not-a-date", now), false);
  assert.equal(isTrashEntryExpired("2026-11-04T13:00:00.000Z", now), false);
  assert.equal(isTrashEntryExpired("2026-11-04T11:59:59.000Z", now), true);
});

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

test("trash manifest refuses a symlinked logs directory outside the library", () => {
  const nasPath = fs.mkdtempSync(path.join(os.tmpdir(), "willard-trash-manifest-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "willard-trash-outside-"));
  try {
    fs.mkdirSync(path.join(nasPath, "WillardAI"));
    fs.symlinkSync(outside, path.join(nasPath, "WillardAI", "logs"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => manifestPath(nasPath), /symlink/);
    assert.equal(fs.existsSync(path.join(outside, "trash-manifest.jsonl")), false);
  } finally {
    fs.rmSync(nasPath, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("trash manifest refuses a symlinked manifest file outside the library", (context) => {
  const nasPath = fs.mkdtempSync(path.join(os.tmpdir(), "willard-trash-manifest-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "willard-trash-outside-"));
  try {
    const filePath = manifestPath(nasPath);
    const outsideFile = path.join(outside, "external.jsonl");
    fs.writeFileSync(outsideFile, "preserve external data\n");
    try {
      fs.symlinkSync(outsideFile, filePath, "file");
    } catch (error: any) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        context.skip("file symlink creation is not permitted on this runner");
        return;
      }
      throw error;
    }
    assert.throws(() => manifestPath(nasPath), /private, unlinked regular file inside the configured library/);
    assert.throws(() => appendTrashManifestEntry(nasPath, {
      nasPath,
      originalPath: path.join(nasPath, "original.jpg"),
      trashPath: path.join(nasPath, "WillardAI", ".Trash", "external.jpg"),
      sizeBytes: 1,
    }), /private, unlinked regular file inside the configured library/);
    assert.equal(fs.readFileSync(outsideFile, "utf8"), "preserve external data\n");
  } finally {
    fs.rmSync(nasPath, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("trash root refuses a symlink outside the configured library during manifest removal", () => {
  const nasPath = fs.mkdtempSync(path.join(os.tmpdir(), "willard-trash-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "willard-trash-outside-"));
  try {
    appendTrashManifestEntry(nasPath, {
      nasPath,
      originalPath: path.join(nasPath, "original.jpg"),
      trashPath: path.join(nasPath, "WillardAI", ".Trash", "session", "original.jpg"),
      sizeBytes: 1,
    });
    fs.writeFileSync(path.join(outside, "preserve.txt"), "preserve");
    fs.symlinkSync(outside, path.join(nasPath, "WillardAI", ".Trash"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () => removeTrashManifestEntry(nasPath, path.join(outside, "preserve.txt"), "restore-outside"),
      /symlink/,
    );
    assert.equal(fs.readFileSync(path.join(outside, "preserve.txt"), "utf8"), "preserve");
  } finally {
    fs.rmSync(nasPath, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("trash tombstones match entries through a configured NAS mount alias", (context) => {
  const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), "willard-trash-real-root-"));
  const aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), "willard-trash-alias-parent-"));
  const aliasRoot = path.join(aliasParent, "library");
  const trashPath = path.join(aliasRoot, "WillardAI", ".Trash", "session", "photo.jpg");
  try {
    try {
      fs.symlinkSync(realRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (process.platform === "win32") {
        context.skip("directory symlink creation is not permitted on this runner");
        return;
      }
      throw error;
    }
    appendTrashManifestEntry(aliasRoot, {
      nasPath: aliasRoot,
      originalPath: path.join(aliasRoot, "photo.jpg"),
      trashPath,
      sizeBytes: 1,
    });
    assert.equal(readTrashManifest(aliasRoot).entries.length, 1);
    assert.equal(removeTrashManifestEntry(aliasRoot, trashPath, "restore-alias"), true);
    assert.equal(readTrashManifest(aliasRoot).entries.length, 0);
  } finally {
    fs.rmSync(aliasParent, { recursive: true, force: true });
    fs.rmSync(realRoot, { recursive: true, force: true });
  }
});

test("trash manifest removal refuses symlinked entries inside the trash root", (context) => {
  const nasPath = fs.mkdtempSync(path.join(os.tmpdir(), "willard-trash-manifest-"));
  const trashRoot = path.join(nasPath, "WillardAI", ".Trash", "session");
  const target = path.join(trashRoot, "keep.jpg");
  const link = path.join(trashRoot, "expired.jpg");
  try {
    fs.mkdirSync(trashRoot, { recursive: true });
    fs.writeFileSync(target, "preserve target");
    try {
      fs.symlinkSync(target, link, "file");
    } catch (error) {
      if (process.platform === "win32") {
        context.skip("file symlink creation is not permitted on this runner");
        return;
      }
      throw error;
    }
    fs.appendFileSync(manifestPath(nasPath), JSON.stringify({
      originalPath: path.join(nasPath, "original.jpg"),
      trashPath: link,
      sizeBytes: 15,
    }) + "\n");
    assert.throws(() => removeTrashManifestEntry(nasPath, link, "remove-symlink"), /symlink/);
    assert.equal(fs.readFileSync(target, "utf8"), "preserve target");
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
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
    assert.match(raw, /"recordType":"REMOVE"/);
    assert.match(raw, /1_first\.jpg/, "append-only journal retains original record for crash recovery");
    const active = readTrashManifest(nasPath).entries;
    assert.equal(active.some((entry) => entry.trashPath === firstTrashPath), false);
    assert.equal(active.some((entry) => entry.trashPath === secondTrashPath), true);
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