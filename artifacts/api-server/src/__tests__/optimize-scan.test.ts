import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createConcurrencyLimiter,
  mapSettledWithConcurrency,
  walkForConversion,
  walkForOptimize,
  type OptimizeConversionFile,
  type OptimizeExtGroup,
} from "../lib/optimize-scan.ts";

const SKIP_DIRS = new Set(["WillardAI", "node_modules", ".git"]);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../");
const optimizeRouteSource = fs.readFileSync(path.join(repoRoot, "artifacts/api-server/src/routes/optimize.ts"), "utf8");
const optimizeScanSource = fs.readFileSync(path.join(repoRoot, "artifacts/api-server/src/lib/optimize-scan.ts"), "utf8");
const optimizePageSource = fs.readFileSync(path.join(repoRoot, "artifacts/willard-ai/src/pages/optimize.tsx"), "utf8");

function fixture(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-optimize-scan-"));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

async function scan(root: string, maxFiles = 500_000) {
  const groups = new Map<string, OptimizeExtGroup>();
  const counter = { total: 0, limitReached: false };
  await walkForOptimize(root, groups, maxFiles, counter, SKIP_DIRS);
  return { groups, counter };
}

test("optimization scan groups regular files and records their actual sizes", async () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.root, "nested"));
    fs.mkdirSync(path.join(f.root, "WillardAI"));
    fs.writeFileSync(path.join(f.root, "one.jpg"), "1234");
    fs.writeFileSync(path.join(f.root, "nested", "two.jpg"), "123456");
    fs.writeFileSync(path.join(f.root, "nested", "notes.txt"), "ignored extension");
    fs.writeFileSync(path.join(f.root, "WillardAI", "internal.jpg"), "ignored directory");

    const { groups, counter } = await scan(f.root);
    assert.equal(counter.total, 3, "all files with a recognized extension are included in the scan total");
    assert.equal(groups.get("jpg")?.count, 2);
    assert.equal(groups.get("jpg")?.bytes, 10);
    assert.equal(groups.get("txt")?.count, 1);
    assert.deepEqual(
      [...(groups.get("jpg")?.paths ?? [])].sort(),
      [path.join(f.root, "one.jpg"), path.join(f.root, "nested", "two.jpg")].sort(),
    );
  } finally {
    f.cleanup();
  }
});

test("optimization scan fails with path context when its root disappears", async () => {
  const f = fixture();
  const missing = path.join(f.root, "removed-library");
  try {
    await assert.rejects(
      scan(missing),
      (error: unknown) => error instanceof Error &&
        error.message.includes("Unable to scan optimization directory") &&
        error.message.includes(missing),
    );
  } finally {
    f.cleanup();
  }
});

test("optimization scan fails closed when a nested directory is unreadable", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async () => {
  const f = fixture();
  const blocked = path.join(f.root, "blocked");
  try {
    fs.mkdirSync(blocked);
    fs.writeFileSync(path.join(blocked, "hidden.jpg"), "must not be silently omitted");
    fs.chmodSync(blocked, 0);
    await assert.rejects(
      scan(f.root),
      (error: unknown) => error instanceof Error &&
        error.message.includes("Unable to scan optimization directory") &&
        error.message.includes(blocked),
    );
  } finally {
    try { fs.chmodSync(blocked, 0o700); } catch { /* fixture may not have been created */ }
    f.cleanup();
  }
});

test("optimization scan does not follow symlinks as regular media files or directories", {
  skip: process.platform === "win32",
}, async () => {
  const f = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "willard-optimize-link-target-"));
  try {
    const target = path.join(outside, "private.jpg");
    fs.writeFileSync(target, "outside library");
    fs.symlinkSync(target, path.join(f.root, "linked.jpg"));
    fs.symlinkSync(outside, path.join(f.root, "linked-directory"), "dir");

    const { groups, counter } = await scan(f.root);
    assert.equal(counter.total, 0);
    assert.equal(groups.has("jpg"), false);
  } finally {
    f.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("optimization scan enforces a positive file limit", async () => {
  const f = fixture();
  try {
    await assert.rejects(scan(f.root, 0), /positive safe integer/);
  } finally {
    f.cleanup();
  }
});

test("optimization scan marks the safety limit when it reaches the configured maximum", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, "one.jpg"), "1");
    fs.writeFileSync(path.join(f.root, "two.jpg"), "22");
    fs.writeFileSync(path.join(f.root, "three.jpg"), "333");

    const { groups, counter } = await scan(f.root, 2);
    assert.equal(counter.total, 2);
    assert.equal(counter.limitReached, true);
    assert.equal(groups.get("jpg")?.count, 2);
  } finally {
    f.cleanup();
  }
});

test("optimization scan leaves the safety-limit flag clear below the configured maximum", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, "one.jpg"), "1");
    fs.writeFileSync(path.join(f.root, "two.jpg"), "22");

    const { counter } = await scan(f.root, 3);
    assert.equal(counter.total, 2);
    assert.equal(counter.limitReached, false);
  } finally {
    f.cleanup();
  }
});

test("Optimize filesystem walks yield to the event loop", async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 150; index++) {
      fs.writeFileSync(path.join(f.root, `photo-${index}.jpg`), "image");
    }
    let ticked = false;
    let completed = false;
    const tick = new Promise<void>((resolve) => setImmediate(() => { ticked = true; resolve(); }));
    const scanPromise = scan(f.root).then((result) => {
      completed = true;
      return result;
    });
    await tick;
    assert.equal(ticked, true);
    assert.equal(completed, false, "the scan must yield while filesystem work is still in progress");
    await scanPromise;
  } finally {
    f.cleanup();
  }
});

test("conversion scan filters extensions and skips hidden, internal, and backup directories", async () => {
  const f = fixture();
  try {
    const backup = path.join(f.root, "backup");
    fs.mkdirSync(backup);
    fs.mkdirSync(path.join(f.root, ".hidden"));
    fs.mkdirSync(path.join(f.root, "WillardAI"));
    fs.mkdirSync(path.join(f.root, "nested"));
    fs.writeFileSync(path.join(f.root, "keep.MP4"), "video");
    fs.writeFileSync(path.join(f.root, "ignore.txt"), "text");
    fs.writeFileSync(path.join(backup, "backup.mp4"), "backup");
    fs.writeFileSync(path.join(f.root, ".hidden", "hidden.mov"), "hidden");
    fs.writeFileSync(path.join(f.root, "WillardAI", "internal.mov"), "internal");
    fs.writeFileSync(path.join(f.root, "nested", "keep.mov"), "video");

    const results: OptimizeConversionFile[] = [];
    await walkForConversion(
      f.root,
      new Set(["mp4", "mov"]),
      results,
      SKIP_DIRS,
      new Set([backup]),
    );

    assert.deepEqual(new Set(results.map((item) => item.fullPath)), new Set([
      path.join(f.root, "keep.MP4"),
      path.join(f.root, "nested", "keep.mov"),
    ]));
    assert.deepEqual(new Set(results.map((item) => item.ext)), new Set(["mp4", "mov"]));
    assert.deepEqual(results.map((item) => item.sizeBytes), [5, 5]);
  } finally {
    f.cleanup();
  }
});

test("conversion scan fails closed when a nested directory is unreadable", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async () => {
  const f = fixture();
  const blocked = path.join(f.root, "blocked");
  try {
    fs.mkdirSync(blocked);
    fs.writeFileSync(path.join(blocked, "hidden.mp4"), "must not be silently omitted");
    fs.chmodSync(blocked, 0);
    await assert.rejects(
      walkForConversion(f.root, new Set(["mp4"]), [], SKIP_DIRS),
      (error: unknown) => error instanceof Error &&
        error.message.includes("Unable to scan conversion directory") &&
        error.message.includes(blocked),
    );
  } finally {
    try { fs.chmodSync(blocked, 0o700); } catch { /* fixture may not have been created */ }
    f.cleanup();
  }
});

test("bounded settled mapping preserves order and limits per-scan work", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapSettledWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (value) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 4));
    active--;
    if (value === 3) throw new Error("expected probe failure");
    return value * 10;
  });

  assert.equal(peak, 2);
  assert.deepEqual(results.map((result) => result.status), [
    "fulfilled", "fulfilled", "fulfilled", "rejected", "fulfilled", "fulfilled",
  ]);
  assert.deepEqual(results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []), [0, 10, 20, 40, 50]);
});

test("process-wide concurrency limiter caps probes across independent scans", async () => {
  const limit = createConcurrencyLimiter(3);
  let active = 0;
  let peak = 0;
  const results = await Promise.all(Array.from({ length: 15 }, (_, index) => limit(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 3));
    active--;
    return index;
  })));

  assert.equal(peak, 3);
  assert.deepEqual(results, Array.from({ length: 15 }, (_, index) => index));
});

test("concurrency helpers reject invalid limits", async () => {
  assert.throws(() => createConcurrencyLimiter(0), /positive safe integer/);
  await assert.rejects(
    mapSettledWithConcurrency([1], -1, async (value) => value),
    /positive safe integer/,
  );
});

test("Optimize scan and conversion routes use asynchronous traversal and bounded ffprobe probes", () => {
  assert.match(optimizeRouteSource, /await walkForOptimize\(/);
  assert.match(optimizeRouteSource, /await walkForConversion\(/);
  assert.match(optimizeRouteSource, /const withVideoProbeSlot = createConcurrencyLimiter\(4\)/);
  assert.match(optimizeRouteSource, /await withVideoProbeSlot\(\(\) => runMediaToolAsync\(/);
  assert.match(optimizeRouteSource, /mapSettledWithConcurrency\(videoProbeTasks, 4/);
  assert.doesNotMatch(optimizeScanSource, /readdirSync|lstatSync/);
  assert.doesNotMatch(optimizeRouteSource, /\\bfs\\.(?:existsSync|statSync|lstatSync|readdirSync|readFileSync|writeFileSync|mkdirSync|rmSync|unlinkSync)\\b/);
  assert.match(optimizeRouteSource, /async function readScanCache/);
  assert.match(optimizeRouteSource, /await fs\\.promises\\.readFile/);
  assert.match(optimizeRouteSource, /await fs\\.promises\\.writeFile/);
});

test("scan-limit state is cached, returned by the API, and warned about in Optimize Center", () => {
  assert.match(optimizeRouteSource, /const CACHE_VERSION\s*=\s*8/);
  assert.match(optimizeRouteSource, /scanLimitReached:\s*counter\.limitReached/);
  assert.match(optimizeRouteSource, /scanLimit:\s*OPTIMIZE_SCAN_MAX_FILES/);
  assert.match(optimizePageSource, /scanLimitReached\?:\s*boolean/);
  assert.match(optimizePageSource, /scanResult\.scanLimitReached/);
  assert.match(optimizePageSource, /Scan limit reached/);
  assert.match(optimizePageSource, /Videos outside the scan window are safely skipped during conversion/);
});
