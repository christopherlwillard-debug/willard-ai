import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createStorageMigrationService,
  type MigrationReference,
} from "../lib/storage-migration.ts";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-storage-migration-"));
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  const manifests = path.join(root, "manifests");
  fs.mkdirSync(path.join(source, "WillardAI/cache/thumbnails"), { recursive: true });
  fs.mkdirSync(path.join(source, "WillardAI/cache/faces"), { recursive: true });
  fs.mkdirSync(path.join(source, "WillardAI/ConversionBackups"), { recursive: true });
  fs.mkdirSync(destination, { recursive: true });
  return { root, source, destination, manifests };
}

function fakeDatabase() {
  const updates: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      updates.push({ text, values });
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  return { updates, connect: async () => client };
}

test("preview inventories derivative namespaces and counts database references", async () => {
  const paths = fixture();
  const thumbnail = path.join(paths.source, "WillardAI/cache/thumbnails/1.webp");
  const crop = path.join(paths.source, "WillardAI/cache/faces/1.webp");
  fs.writeFileSync(thumbnail, "thumbnail");
  fs.writeFileSync(crop, "crop");
  const references: MigrationReference[] = [
    { table: "media_files", column: "thumbnail_path", rowId: 12, value: thumbnail },
    { table: "faces", column: "crop_path", rowId: 4, value: crop },
  ];
  const service = createStorageMigrationService({ manifestDir: paths.manifests });
  const manifest = await service.preview({
    sourceRoot: paths.source,
    destinationRoot: paths.destination,
    referenceRows: references,
    sourceLabel: "Old NAS",
    destinationLabel: "New NAS",
  });

  assert.equal(manifest.sourceLabel, "Old NAS");
  assert.equal(manifest.destinationLabel, "New NAS");
  assert.equal(manifest.entries.filter((entry) => entry.state === "pending").length, 2);
  assert.equal(manifest.referenceCount, 2);
  assert.equal(manifest.entries.find((entry) => entry.sourcePath === thumbnail)?.referenceCount, 1);
  assert.equal(manifest.requiredBytes, Buffer.byteLength("thumbnail") + Buffer.byteLength("crop"));
  assert.equal(fs.existsSync(path.join(paths.manifests, `${manifest.id}.json`)), true);
});

test("dry-run does not create or modify the destination root", async () => {
  const paths = fixture();
  fs.rmSync(paths.destination, { recursive: true, force: true });
  const source = path.join(paths.source, "WillardAI/cache/thumbnails/noop.webp");
  fs.writeFileSync(source, "noop");
  const service = createStorageMigrationService({ manifestDir: paths.manifests });
  await service.preview({
    sourceRoot: paths.source,
    destinationRoot: paths.destination,
    referenceRows: [],
  });
  assert.equal(fs.existsSync(paths.destination), false);
});

test("copy is resumable after a new service instance and updates references only after verification", async () => {
  const paths = fixture();
  const thumbnail = path.join(paths.source, "WillardAI/cache/thumbnails/1.webp");
  const crop = path.join(paths.source, "WillardAI/cache/faces/1.webp");
  const report = path.join(paths.source, "WillardAI/reports/organize-1.json");
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(thumbnail, "thumbnail");
  fs.writeFileSync(crop, "crop");
  fs.writeFileSync(report, "report");
  const database = fakeDatabase();
  const references: MigrationReference[] = [
    { table: "media_files", column: "thumbnail_path", rowId: 12, value: thumbnail },
    { table: "faces", column: "crop_path", rowId: 4, value: crop },
    { table: "organization_jobs", column: "report_path", rowId: 8, value: report },
  ];
  const first = createStorageMigrationService({ manifestDir: paths.manifests });
  const manifest = await first.preview({
    sourceRoot: paths.source,
    destinationRoot: paths.destination,
    referenceRows: references,
  });
  const second = createStorageMigrationService({ manifestDir: paths.manifests, connect: database.connect });
  const copied = await second.copy(manifest.id);
  const target = path.join(paths.destination, "WillardAI/cache/thumbnails/1.webp");
  assert.equal(copied.state, "VERIFIED");
  assert.equal(fs.readFileSync(target, "utf8"), "thumbnail");
  assert.equal(fs.existsSync(thumbnail), true, "copy never removes originals");
  assert.equal(database.updates.some((update) => update.text === "BEGIN"), true);
  assert.equal(database.updates.some((update) => update.text.includes("UPDATE media_files SET thumbnail_path")), true);
  assert.equal(database.updates.some((update) => update.text.includes("UPDATE faces SET crop_path")), true);
  assert.equal(database.updates.some((update) => update.text.includes("UPDATE organization_jobs SET report_path")), true);
  assert.equal((await second.get(manifest.id)).state, "VERIFIED");
});

test("conflicting destinations and missing sources block copy without touching the database", async () => {
  const paths = fixture();
  const conflict = path.join(paths.source, "WillardAI/cache/thumbnails/conflict.webp");
  const missing = path.join(paths.source, "WillardAI/cache/thumbnails/missing.webp");
  fs.writeFileSync(conflict, "source");
  fs.writeFileSync(path.join(paths.source, "WillardAI/cache/thumbnails/needs-space.webp"), "needs space");
  fs.mkdirSync(path.dirname(path.join(paths.destination, "WillardAI/cache/thumbnails/conflict.webp")), { recursive: true });
  fs.writeFileSync(path.join(paths.destination, "WillardAI/cache/thumbnails/conflict.webp"), "different");
  const database = fakeDatabase();
  const service = createStorageMigrationService({ manifestDir: paths.manifests, connect: database.connect });
  const manifest = await service.preview({
    sourceRoot: paths.source,
    destinationRoot: paths.destination,
    referenceRows: [],
  });
  fs.writeFileSync(missing, "will disappear");
  fs.rmSync(missing);
  const reloaded = await service.get(manifest.id);
  assert.equal(reloaded.conflicts, 1);
  await assert.rejects(() => service.copy(manifest.id), /Resolve conflicts/);
  assert.equal(database.updates.length, 0);
});

test("corrupt copies remove the partial destination and pause the manifest", async () => {
  const paths = fixture();
  const source = path.join(paths.source, "WillardAI/cache/thumbnails/corrupt.webp");
  fs.writeFileSync(source, "good");
  let hashCalls = 0;
  const service = createStorageMigrationService({
    manifestDir: paths.manifests,
    hashFile: async (filePath) => {
      hashCalls++;
      if (hashCalls === 2) return "corrupted-destination";
      return filePath === source ? "expected-source" : "expected-source";
    },
  });
  const manifest = await service.preview({
    sourceRoot: paths.source,
    destinationRoot: paths.destination,
    referenceRows: [],
  });
  await assert.rejects(() => service.copy(manifest.id), /verification failed/);
  const target = path.join(paths.destination, "WillardAI/cache/thumbnails/corrupt.webp");
  assert.equal(fs.existsSync(`${target}.${manifest.id}.partial`), false);
  assert.equal((await service.get(manifest.id)).state, "PAUSED");
});

test("cleanup requires a separate confirmation and never removes protected conversion backups", async () => {
  const paths = fixture();
  const thumbnail = path.join(paths.source, "WillardAI/cache/thumbnails/keep.webp");
  const backup = path.join(paths.source, "WillardAI/ConversionBackups/original.jpg");
  fs.writeFileSync(thumbnail, "thumbnail");
  fs.writeFileSync(backup, "original");
  const service = createStorageMigrationService({ manifestDir: paths.manifests });
  const manifest = await service.preview({
    sourceRoot: paths.source,
    destinationRoot: paths.destination,
    referenceRows: [],
  });
  await service.copy(manifest.id);
  await assert.rejects(() => service.cleanup(manifest.id), /separate explicit confirmation/);
  await service.confirmCleanup(manifest.id);
  const cleaned = await service.cleanup(manifest.id);
  assert.equal(cleaned.state, "CLEANED");
  assert.equal(fs.existsSync(thumbnail), false);
  assert.equal(fs.existsSync(backup), true);
});

test("preview records missing database-referenced artifacts and refuses insufficient destinations", async () => {
  const paths = fixture();
  const missing = path.join(paths.source, "WillardAI/cache/thumbnails/no-longer-present.webp");
  fs.writeFileSync(path.join(paths.source, "WillardAI/cache/thumbnails/needs-space.webp"), "needs space");
  const service = createStorageMigrationService({
    manifestDir: paths.manifests,
    freeBytesAt: async () => 0,
  });
  const manifest = await service.preview({
    sourceRoot: paths.source,
    destinationRoot: paths.destination,
    referenceRows: [{ table: "media_files", column: "thumbnail_path", rowId: 22, value: missing }],
  });
  assert.equal(manifest.missingFiles, 1);
  assert.equal(manifest.referenceCount, 1);
  assert.equal(manifest.capacitySafe, false);
  await assert.rejects(() => service.copy(manifest.id), /Resolve conflicts/);
});

test("directory-valued job references move as prefixes and destination orphans are reported", async () => {
  const paths = fixture();
  const backup = path.join(paths.source, "WillardAI/ConversionBackups/job-7/original.jpg");
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.writeFileSync(backup, "original");
  const orphan = path.join(paths.destination, "WillardAI/ConversionBackups/old/orphan.jpg");
  fs.mkdirSync(path.dirname(orphan), { recursive: true });
  fs.writeFileSync(orphan, "orphan");
  const database = fakeDatabase();
  const backupReference = path.join(paths.source, "WillardAI/ConversionBackups/job-7");
  const service = createStorageMigrationService({ manifestDir: paths.manifests, connect: database.connect });
  const manifest = await service.preview({
    sourceRoot: paths.source,
    destinationRoot: paths.destination,
    referenceRows: [{ table: "conversion_jobs", column: "backup_dir", rowId: 7, value: backupReference }],
  });
  assert.equal(manifest.missingFiles, 0);
  assert.deepEqual(manifest.orphanedFiles, ["WillardAI/ConversionBackups/old/orphan.jpg"]);
  await service.copy(manifest.id);
  const update = database.updates.find((item) => item.text.includes("UPDATE conversion_jobs SET backup_dir"));
  assert.equal(update?.values[0], path.join(paths.destination, "WillardAI/ConversionBackups/job-7"));
  assert.equal(fs.existsSync(backup), true);
});