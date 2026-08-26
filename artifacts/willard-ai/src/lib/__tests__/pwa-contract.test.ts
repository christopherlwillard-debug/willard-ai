import { test } from "node:test";
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const workerPath = resolve("artifacts/willard-ai/public/sw.js");

test("the service worker keeps private API/media traffic out of Cache Storage", async () => {
  const worker = await readFile(workerPath, "utf8");

  assert.match(worker, /request\.method !== "GET"/);
  assert.match(worker, /url\.origin !== self\.location\.origin/);
  assert.match(worker, /url\.pathname\.includes\("\/api\/"\)/);
  assert.match(worker, /request\.mode === "navigate"/);
  assert.match(worker, /fetch\(request\)/);
  assert.match(worker, /caches\.match\("\.\/index\.html"\)/);
});

test("the production stamp input changes when the shell or worker changes", () => {
  const first = createHash("sha256").update("shell-a").update("worker-a").digest("hex").slice(0, 16);
  const second = createHash("sha256").update("shell-b").update("worker-a").digest("hex").slice(0, 16);

  assert.notEqual(first, second);
});