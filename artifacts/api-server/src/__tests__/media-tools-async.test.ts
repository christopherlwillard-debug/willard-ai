import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  formatMediaToolExecutionError,
  runMediaToolAsync,
  stopActiveMediaTools,
} from "../lib/media-tools.ts";
import { markShuttingDown } from "../lib/shutdown-state.ts";

const optimizePath = fileURLToPath(new URL("../routes/optimize.ts", import.meta.url));
const optimizeSource = readFileSync(optimizePath, "utf8");
const thumbnailPath = fileURLToPath(new URL("../lib/thumbnail-engine.ts", import.meta.url));
const thumbnailSource = readFileSync(thumbnailPath, "utf8");
const runtimePath = fileURLToPath(new URL("../lib/conversion-runtime.ts", import.meta.url));
const runtimeSource = readFileSync(runtimePath, "utf8");

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

test("conversion and thumbnail routes await FFmpeg instead of running it synchronously", () => {
  assert.doesNotMatch(optimizeSource, /spawnSync\s*\(\s*"ffmpeg"/);
  assert.match(optimizeSource, /runMediaToolAsync\(\s*"ffmpeg"/);
  assert.match(optimizeSource, /convertError = await convertVideo\(fullPath, stagedPath\)/);
  assert.doesNotMatch(thumbnailSource, /spawnSync\s*\(\s*"ffmpeg"/);
  assert.match(thumbnailSource, /await runMediaToolAsync\("ffmpeg"/);
  assert.match(thumbnailSource, /error = await generateVideoThumbnail/);
});

test("shutdown terminates owned media subprocesses before the server exits", async () => {
  const pending = runMediaToolAsync(
    process.execPath,
    ["-e", "setInterval(() => {}, 1_000)"],
    { timeoutMs: 10_000 },
  );
  const rejected = assert.rejects(pending, (error: NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null }) => {
    assert.ok(error.killed || error.signal === "SIGTERM" || error.signal === "SIGKILL");
    return true;
  });

  await stopActiveMediaTools(500);
  await rejected;
  assert.match(runtimeSource, /await stopActiveMediaTools/);

  markShuttingDown();
  await assert.rejects(
    runMediaToolAsync("willard-audit-must-not-spawn", [], { timeoutMs: 1_000 }),
    (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, "ERR_SERVER_SHUTTING_DOWN");
      return true;
    },
  );
});
