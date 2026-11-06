import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  formatMediaToolExecutionError,
  runMediaToolAsync,
} from "../lib/media-tools.ts";

const optimizePath = fileURLToPath(new URL("../routes/optimize.ts", import.meta.url));
const optimizeSource = readFileSync(optimizePath, "utf8");

test("long-running media tools leave the API event loop responsive", async () => {
  let eventLoopTicked = false;
  const tick = new Promise<void>((resolve) => {
    setImmediate(() => {
      eventLoopTicked = true;
      resolve();
    });
  });

  const result = await runMediaToolAsync(
    process.execPath,
    ["-e", "setTimeout(() => process.stdout.write('finished'), 120)"],
    { timeoutMs: 5_000 },
  );
  await tick;

  assert.equal(eventLoopTicked, true);
  assert.equal(result.stdout, "finished");
});

test("media tool timeout is enforced and missing binaries stay actionable", async () => {
  await assert.rejects(
    runMediaToolAsync(
      process.execPath,
      ["-e", "setTimeout(() => {}, 10_000)"],
      { timeoutMs: 100 },
    ),
    (error: NodeJS.ErrnoException & { killed?: boolean }) => {
      assert.ok(error.code === "ETIMEDOUT" || error.killed);
      return true;
    },
  );

  const missing = formatMediaToolExecutionError(
    "ffmpeg",
    Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" }),
    300_000,
  );
  assert.match(missing, /Install FFmpeg/);
});

test("conversion route awaits FFmpeg instead of running it synchronously", () => {
  assert.doesNotMatch(optimizeSource, /spawnSync\s*\(\s*"ffmpeg"/);
  assert.match(optimizeSource, /runMediaToolAsync\(\s*"ffmpeg"/);
  assert.match(optimizeSource, /convertError = await convertVideo\(fullPath, stagedPath\)/);
});
