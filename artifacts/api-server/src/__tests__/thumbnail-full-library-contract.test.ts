import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const engine = readFileSync(
  new URL("../lib/library-engine/job-engine.ts", import.meta.url),
  "utf8",
);

test("thumbnail backfill pages through the full active library", () => {
  const start = engine.indexOf("async function runThumbnailJob");
  const end = engine.indexOf("// ── Fail a job", start);
  const job = engine.slice(start, end);

  assert.match(job, /while \(prepared\.examined > 0\)/);
  assert.match(job, /reconcileThumbnailPointers\(nasPath, THUMBNAIL_JOB_MAX_FILES, cursor\)/);
  assert.doesNotMatch(job, /state\.filesProcessed >= THUMBNAIL_JOB_MAX_FILES/);
  assert.match(job, /paged: true/);
});

test("thumbnail reconciliation accepts a durable page cursor", () => {
  const start = engine.indexOf("export async function reconcileThumbnailPointers");
  const end = engine.indexOf("async function runThumbnailJob", start);
  const reconciler = engine.slice(start, end);

  assert.match(reconciler, /afterId = 0/);
  assert.match(reconciler, /gt\(mediaFilesTable\.id, afterId\)/);
  assert.match(reconciler, /nextCursor: rows\.at\(-1\)\?\.id \?\? afterId/);
});