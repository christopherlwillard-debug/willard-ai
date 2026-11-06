import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  formatMediaToolExecutionError,
  assertMediaProcessStartAllowed,
  runMediaToolAsync,
  stopActiveMediaTools,
  trackActiveMediaProcess,
} from "../lib/media-tools.ts";
import { createTrackedSevenZipStream } from "../lib/sevenzip.ts";
import { markShuttingDown } from "../lib/shutdown-state.ts";

const optimizePath = fileURLToPath(new URL("../routes/optimize.ts", import.meta.url));
const optimizeSource = readFileSync(optimizePath, "utf8");
const thumbnailPath = fileURLToPath(new URL("../lib/thumbnail-engine.ts", import.meta.url));
const thumbnailSource = readFileSync(thumbnailPath, "utf8");
const runtimePath = fileURLToPath(new URL("../lib/conversion-runtime.ts", import.meta.url));
const runtimeSource = readFileSync(runtimePath, "utf8");
const mediaToolsPath = fileURLToPath(new URL("../lib/media-tools.ts", import.meta.url));
const mediaToolsSource = readFileSync(mediaToolsPath, "utf8");
const archiveRoutesSource = readFileSync(new URL("../routes/archives.ts", import.meta.url), "utf8");
const organizeRoutesSource = readFileSync(new URL("../routes/organize.ts", import.meta.url), "utf8");

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

test("media tool timeout escalates when a child ignores SIGTERM", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows terminates this child directly when SIGTERM is sent");
    return;
  }

  const startedAt = Date.now();
  await assert.rejects(
    runMediaToolAsync(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 8_000); setInterval(() => {}, 1_000)",
      ],
      { timeoutMs: 100 },
    ),
    (error: NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null }) => {
      assert.ok(error.code === "ETIMEDOUT" || error.killed || error.signal === "SIGKILL");
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 4_000, "timeout escalation should not wait for the child’s own 8-second timer");
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

test("Optimize Center and media health probes use the shared shutdown-owned process runner", () => {
  assert.match(optimizeSource, /runMediaToolAsync\(\s*"ffprobe"/);
  assert.doesNotMatch(optimizeSource, /execFileAsync\s*\(/);
  assert.match(mediaToolsSource, /function probeTool[\s\S]*?runMediaToolAsync\(/);
  assert.doesNotMatch(mediaToolsSource, /execFile\(bin,\s*\["-version"\]/);
});

test("directly spawned archive helpers share the shutdown process registry", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const unregister = trackActiveMediaProcess(child);

  await stopActiveMediaTools(500);
  await closed;
  unregister();
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test("node-7z archive operations register their child processes with the shared shutdown owner", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const stream = createTrackedSevenZipStream(() => ({ _childProcess: child }));

  assert.equal(stream._childProcess, child);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
  await stopActiveMediaTools(500);
  await closed;
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test("aborting a read-only 7-Zip operation stops only its owned child", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const controller = new AbortController();
  createTrackedSevenZipStream(() => ({ _childProcess: child }), controller.signal);

  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
  controller.abort();
  await closed;
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test("every node-7z archive route uses tracked process ownership and early validation stops", () => {
  const routes = `${archiveRoutesSource}\\n${organizeRoutesSource}`;
  const node7zCalls = routes.match(/Seven\\.(?:list|extractFull)\\(/g) ?? [];
  const trackedCalls = routes.match(/createTrackedSevenZipStream\\(\\(\\) => Seven\\.(?:list|extractFull)\\(/g) ?? [];
  assert.equal(node7zCalls.length, 5);
  assert.equal(trackedCalls.length, node7zCalls.length);
  assert.match(archiveRoutesSource, /peek7z\\(filePath: string, signal\\?: AbortSignal\\)/);
  assert.match(archiveRoutesSource, /res\\.once\\("close", abortPreviewIfDisconnected\\)/);
  assert.match(archiveRoutesSource, /stopTrackedSevenZipStream\\(stream\\)/);
  assert.match(organizeRoutesSource, /stopTrackedSevenZipStream\\(s\\)/);
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
  assert.throws(assertMediaProcessStartAllowed, (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, "ERR_SERVER_SHUTTING_DOWN");
    return true;
  });
  await assert.rejects(
    runMediaToolAsync("willard-audit-must-not-spawn", [], { timeoutMs: 1_000 }),
    (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, "ERR_SERVER_SHUTTING_DOWN");
      return true;
    },
  );
});
