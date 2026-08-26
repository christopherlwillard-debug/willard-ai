import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { pool } from "@workspace/db";
import { appendTrashManifestEntry, manifestPath, purgeExpiredTrashEntries, readTrashManifest } from "../lib/cleanup-recovery.ts";
import { purgeDerivedDataForMedia, purgeOrphanedDerivedData } from "../lib/derived-cleanup.ts";

async function databaseAvailable(): Promise<boolean> {
  return (await pool.query("SELECT 1").catch(() => null)) !== null;
}

async function insertMedia(nasPath: string, relativePath: string, action: string | null = null): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO media_files
       (nas_path, relative_path, name, extension, mime_type, media_type, size_bytes, last_scan_action)
     VALUES ($1, $2, $3, 'jpg', 'image/jpeg', 'photo', 1, $4)
     RETURNING id`,
    [nasPath, relativePath, path.basename(relativePath), action],
  );
  return result.rows[0]!.id;
}

test("purge removes AI, faces, scan state, people, and face crops without crossing NAS scope", async (t) => {
  if (!(await databaseAvailable())) {
    t.skip("requires the configured PostgreSQL test database");
    return;
  }

  const nasPath = path.join(process.cwd(), `.tmp-derived-cleanup-${crypto.randomUUID()}`);
  const otherNasPath = path.join(process.cwd(), `.tmp-derived-cleanup-other-${crypto.randomUUID()}`);
  const cropDir = path.join(nasPath, "WillardAI", "cache", "faces");
  const cropPath = path.join(cropDir, "target.webp");
  fs.mkdirSync(cropDir, { recursive: true });
  fs.writeFileSync(cropPath, "crop");

  const targetId = await insertMedia(nasPath, "photo.jpg");
  const otherId = await insertMedia(otherNasPath, "photo.jpg");
  const person = await pool.query<{ id: number }>(
    "INSERT INTO people (nas_path, name, face_count) VALUES ($1, 'Target', 1) RETURNING id",
    [nasPath],
  );
  await pool.query(
    `INSERT INTO faces (media_file_id, person_id, box_x, box_y, box_w, box_h, score, crop_path)
     VALUES ($1, $2, 1, 1, 10, 10, 0.9, $3)`,
    [targetId, person.rows[0]!.id, cropPath],
  );
  await pool.query("INSERT INTO face_scan_state (media_file_id, face_count) VALUES ($1, 1)", [targetId]);
  await pool.query("INSERT INTO media_ai (media_file_id, description) VALUES ($1, 'target')", [targetId]);
  await pool.query("INSERT INTO media_ai (media_file_id, description) VALUES ($1, 'other')", [otherId]);

  try {
    const report = await purgeDerivedDataForMedia(nasPath, [targetId, otherId]);
    assert.equal(report.mediaAiRows, 1);
    assert.equal(report.faceRows, 1);
    assert.equal(report.faceScanStateRows, 1);
    assert.equal(report.peopleRows, 1);
    assert.equal(fs.existsSync(cropPath), false);

    const untouched = await pool.query<{ count: string }>(
      "SELECT count(*) FROM media_ai WHERE media_file_id = $1",
      [otherId],
    );
    assert.equal(Number(untouched.rows[0]!.count), 1);
  } finally {
    await pool.query("DELETE FROM media_ai WHERE media_file_id IN ($1, $2)", [targetId, otherId]);
    await pool.query("DELETE FROM faces WHERE media_file_id IN ($1, $2)", [targetId, otherId]);
    await pool.query("DELETE FROM face_scan_state WHERE media_file_id IN ($1, $2)", [targetId, otherId]);
    await pool.query("DELETE FROM media_files WHERE id IN ($1, $2)", [targetId, otherId]);
    await pool.query("DELETE FROM people WHERE nas_path IN ($1, $2)", [nasPath, otherNasPath]);
    fs.rmSync(nasPath, { recursive: true, force: true });
    fs.rmSync(otherNasPath, { recursive: true, force: true });
  }
});

test("orphan repair removes stale derived rows and crops while preserving another library", async (t) => {
  if (!(await databaseAvailable())) {
    t.skip("requires the configured PostgreSQL test database");
    return;
  }

  const nasPath = path.join(process.cwd(), `.tmp-derived-orphan-${crypto.randomUUID()}`);
  const otherNasPath = path.join(process.cwd(), `.tmp-derived-orphan-other-${crypto.randomUUID()}`);
  const faceDir = path.join(nasPath, "WillardAI", "cache", "faces");
  const cropPath = path.join(faceDir, "orphan.webp");
  const staleCropPath = path.join(faceDir, "stale.webp");
  fs.mkdirSync(faceDir, { recursive: true });
  fs.writeFileSync(cropPath, "orphan");
  fs.writeFileSync(staleCropPath, "stale");

  const otherId = await insertMedia(otherNasPath, "kept.jpg");
  const orphanMediaId = 2_000_000_000 + Math.floor(Math.random() * 1_000_000);
  const person = await pool.query<{ id: number }>(
    "INSERT INTO people (nas_path, name, face_count) VALUES ($1, 'Orphan', 1) RETURNING id",
    [nasPath],
  );
  await pool.query(
    `INSERT INTO faces (media_file_id, person_id, box_x, box_y, box_w, box_h, score, crop_path)
     VALUES ($1, $2, 1, 1, 10, 10, 0.9, $3)`,
    [orphanMediaId, person.rows[0]!.id, cropPath],
  );
  await pool.query("INSERT INTO face_scan_state (media_file_id) VALUES ($1)", [orphanMediaId]);
  await pool.query("INSERT INTO media_ai (media_file_id, description) VALUES ($1, 'orphan')", [orphanMediaId]);
  const otherAi = await pool.query<{ id: number }>(
    "INSERT INTO media_ai (media_file_id, description) VALUES ($1, 'kept') RETURNING id",
    [otherId],
  );

  try {
    const report = await purgeOrphanedDerivedData(nasPath);
    assert.ok(report.orphanRows >= 3, "the three rows created by this test must be repaired");
    assert.equal(report.peopleRows, 1);
    assert.equal(fs.existsSync(cropPath), false);
    assert.equal(fs.existsSync(staleCropPath), false);
    const kept = await pool.query<{ count: string }>("SELECT count(*) FROM media_ai WHERE id = $1", [otherAi.rows[0]!.id]);
    assert.equal(Number(kept.rows[0]!.count), 1);
  } finally {
    await pool.query("DELETE FROM media_ai WHERE media_file_id = $1", [orphanMediaId]);
    await pool.query("DELETE FROM faces WHERE media_file_id = $1", [orphanMediaId]);
    await pool.query("DELETE FROM face_scan_state WHERE media_file_id = $1", [orphanMediaId]);
    await pool.query("DELETE FROM media_files WHERE id = $1", [otherId]);
    await pool.query("DELETE FROM people WHERE nas_path IN ($1, $2)", [nasPath, otherNasPath]);
    fs.rmSync(nasPath, { recursive: true, force: true });
    fs.rmSync(otherNasPath, { recursive: true, force: true });
  }
});

test("expired local trash permanently removes its canonical row and derived data", async (t) => {
  if (!(await databaseAvailable())) {
    t.skip("requires the configured PostgreSQL test database");
    return;
  }

  const nasPath = path.join(process.cwd(), `.tmp-derived-expiry-${crypto.randomUUID()}`);
  const originalPath = path.join(nasPath, "old.jpg");
  const trashPath = path.join(nasPath, "WillardAI", ".Trash", "expired", "1_old.jpg");
  const cropPath = path.join(nasPath, "WillardAI", "cache", "faces", "expired.webp");
  fs.mkdirSync(path.dirname(trashPath), { recursive: true });
  fs.mkdirSync(path.dirname(cropPath), { recursive: true });
  fs.writeFileSync(trashPath, "old");
  fs.writeFileSync(cropPath, "crop");
  const mediaId = await insertMedia(nasPath, "old.jpg", "RECYCLED");
  await pool.query("INSERT INTO media_ai (media_file_id, description) VALUES ($1, 'old')", [mediaId]);
  await pool.query(
    `INSERT INTO faces (media_file_id, box_x, box_y, box_w, box_h, score, crop_path)
     VALUES ($1, 1, 1, 10, 10, 0.9, $2)`,
    [mediaId, cropPath],
  );
  await pool.query("INSERT INTO face_scan_state (media_file_id) VALUES ($1)", [mediaId]);
  appendTrashManifestEntry(nasPath, {
    nasPath,
    mediaFileId: mediaId,
    originalPath,
    trashPath,
    sizeBytes: 3,
    expiresAt: "2020-01-01T00:00:00.000Z",
  });

  try {
    const result = await purgeExpiredTrashEntries(nasPath);
    assert.equal(result.permanentlyRemoved, 1);
    assert.equal(fs.existsSync(trashPath), false);
    assert.equal(fs.existsSync(cropPath), false);
    assert.equal(readTrashManifest(nasPath).entries.length, 0);
    const canonical = await pool.query("SELECT 1 FROM media_files WHERE id = $1", [mediaId]);
    const derived = await pool.query("SELECT 1 FROM media_ai WHERE media_file_id = $1", [mediaId]);
    assert.equal(canonical.rows.length, 0);
    assert.equal(derived.rows.length, 0);
  } finally {
    await pool.query("DELETE FROM media_ai WHERE media_file_id = $1", [mediaId]);
    await pool.query("DELETE FROM faces WHERE media_file_id = $1", [mediaId]);
    await pool.query("DELETE FROM face_scan_state WHERE media_file_id = $1", [mediaId]);
    await pool.query("DELETE FROM media_files WHERE id = $1", [mediaId]);
    fs.rmSync(nasPath, { recursive: true, force: true });
  }
});