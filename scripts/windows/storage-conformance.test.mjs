import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  loadStorageConformance,
  validateStorageConformance,
} from "./storage-conformance.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const matrix = loadStorageConformance();

test("storage conformance matrix is complete and every row has executable evidence", () => {
  assert.deepEqual(validateStorageConformance(matrix), []);
  assert.equal(matrix.entries.length, matrix.requiredPipelines.length);
});

test("server media pipelines do not use OS temp as an unapproved media fallback", async () => {
  const serverSources = [
    "artifacts/api-server/src/lib/library-engine/job-engine.ts",
    "artifacts/api-server/src/lib/ai-enrichment.ts",
    "artifacts/api-server/src/lib/face-recognition.ts",
    "artifacts/api-server/src/lib/thumbnail-engine.ts",
    "artifacts/api-server/src/routes/organize.ts",
    "artifacts/api-server/src/routes/optimize.ts",
    "artifacts/api-server/src/routes/cleanup.ts",
  ];
  for (const relative of serverSources) {
    const source = await readFile(path.join(root, relative), "utf8");
    assert.doesNotMatch(
      source,
      /\bos\.tmpdir\s*\(|\bos\.tmpDir\s*\(|path\.join\s*\(\s*os\.tmpdir|mkdtemp\s*\(/,
      `${relative} must use the NAS storage policy instead of OS temp`,
    );
  }
});

test("PWA service worker caches only the shell and never private API/media responses", async () => {
  const worker = await readFile(path.join(root, "artifacts/willard-ai/public/sw.js"), "utf8");
  assert.match(worker, /request\.method !== "GET"/);
  assert.match(worker, /url\.pathname\.includes\("\/api\/"\)/);
  assert.match(worker, /url\.pathname\.includes\("\/media\/"\)/);
  assert.match(worker, /caches\.match\("\.\/index\.html"\)/);
});

test("mobile library streams media and does not create a full-library offline cache", async () => {
  const library = await readFile(path.join(root, "artifacts/willard-mobile/app/(tabs)/library.tsx"), "utf8");
  assert.match(library, /getStreamMediaFileUrl/);
  assert.doesNotMatch(library, /downloadAsync|cacheDirectory|documentDirectory|FileSystem\.writeAsStringAsync/);
});

test("Windows lifecycle coverage is represented separately from local developer staging", () => {
  const windows = matrix.entries.flatMap((entry) => entry.modes);
  for (const mode of ["windows-developer", "windows-packaged"]) {
    assert.ok(windows.includes(mode), `matrix must cover ${mode}`);
  }
  const recovery = matrix.entries.find((entry) => entry.pipeline === "nas-loss-recovery");
  assert.match(recovery.nasOffline, /persist|stop/i);
  assert.match(recovery.resume, /restart|reconnect/i);
});