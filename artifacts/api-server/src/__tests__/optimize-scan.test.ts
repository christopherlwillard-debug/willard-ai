import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createConcurrencyLimiter,
  mapSettledWithConcurrency,
  readOptimizeScanCache,
  walkForConversion,
  walkForOptimize,
  writeOptimizeScanCache,
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
  assert.doesNotMatch(optimizeRouteSource, /\bfs\.(?:existsSync|statSync|lstatSync|readdirSync|readFileSync|writeFileSync|mkdirSync|rmSync|unlinkSync)\b/);
  assert.match(optimizeRouteSource, /readOptimizeScanCache/);
  assert.match(optimizeRouteSource, /writeOptimizeScanCache/);
  assert.match(optimizeScanSource, /ensureDirectoryWithinRoot/);
  assert.match(optimizeScanSource, /O_NOFOLLOW/);
  assert.match(optimizeScanSource, /sameFileIdentity/);
  assert.match(optimizeScanSource, /fs\.promises\.rename/);
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

test("Optimize scan route rejects a missing active library before using its NAS path", () => {
  const start = optimizeRouteSource.indexOf('router.get("/optimize/scan"');
  const end = optimizeRouteSource.indexOf('router.post("/optimize/ai-summary"', start);
  assert.ok(start >= 0 && end > start, "Optimize scan route boundaries must remain discoverable");
  const route = optimizeRouteSource.slice(start, end);
  const guard = route.indexOf("if (!library || !library.nasPath.trim())");
  assert.ok(guard >= 0, "missing active library must return before cache or filesystem access");
  assert.ok(guard < route.indexOf("await readScanCache(nasPath"), "library guard must precede cache access");
  assert.ok(guard < route.indexOf("await walkForOptimize(nasPath"), "library guard must precede NAS traversal");
  assert.match(route, /const nasPath = library\.nasPath;/);
});

function scanCachePath(root: string): string {
  return path.join(root, "WillardAI", "cache", "optimize-scan.json");
}

function scanCacheOptions(now: number, overrides: Partial<{
  expectedVersion: number;
  ttlMs: number;
  profile: string;
  rawConversionEnabled: boolean;
}> = {}) {
  return {
    expectedVersion: 8,
    ttlMs: 24 * 60 * 60 * 1000,
    profile: "ARCHIVE",
    rawConversionEnabled: false,
    now,
    ...overrides,
  };
}

test("Optimize scan cache accepts only the exact version and a valid non-future timestamp", async () => {
  const f = fixture();
  const now = Date.parse("2026-11-06T12:00:00.000Z");
  const cachePath = scanCachePath(f.root);
  try {
    await writeOptimizeScanCache(cachePath, f.root, {
      scannedAt: new Date(now - 60_000).toISOString(),
      profile: "ARCHIVE",
      rawConversionEnabled: false,
      groups: [],
    }, 8);
    const valid = await readOptimizeScanCache(cachePath, f.root, scanCacheOptions(now));
    assert.equal(valid?.cacheVersion, 8);

    for (const invalid of [
      { scannedAt: "not-a-date", cacheVersion: 8 },
      { scannedAt: new Date(now + 1).toISOString(), cacheVersion: 8 },
      { scannedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(), cacheVersion: 8 },
      { scannedAt: new Date(now - 60_000).toISOString(), cacheVersion: 7 },
      { scannedAt: new Date(now - 60_000).toISOString(), cacheVersion: 9 },
    ]) {
      await writeOptimizeScanCache(cachePath, f.root, {
        ...invalid,
        profile: "ARCHIVE",
        rawConversionEnabled: false,
      }, Number(invalid.cacheVersion));
      const cached = await readOptimizeScanCache(cachePath, f.root, scanCacheOptions(now));
      assert.equal(cached, null, `invalid cache should be rejected: ${JSON.stringify(invalid)}`);
    }

    await fs.promises.writeFile(cachePath, JSON.stringify({
      scannedAt: new Date(now - 60_000).toISOString(),
      profile: "ARCHIVE",
      rawConversionEnabled: false,
    }), "utf8");
    assert.equal(await readOptimizeScanCache(cachePath, f.root, scanCacheOptions(now)), null);
  } finally {
    f.cleanup();
  }
});

test("Optimize scan cache rejects profile and raw-conversion mismatches", async () => {
  const f = fixture();
  const now = Date.now();
  const cachePath = scanCachePath(f.root);
  try {
    await writeOptimizeScanCache(cachePath, f.root, {
      scannedAt: new Date(now - 1_000).toISOString(),
      profile: "ARCHIVE",
      rawConversionEnabled: false,
    }, 8);
    assert.equal(await readOptimizeScanCache(cachePath, f.root, scanCacheOptions(now, { profile: "BALANCED" })), null);
    assert.equal(await readOptimizeScanCache(cachePath, f.root, scanCacheOptions(now, { rawConversionEnabled: true })), null);
  } finally {
    f.cleanup();
  }
});

test("Optimize scan cache never reads or writes through a symlinked cache directory", {
  skip: process.platform === "win32",
}, async () => {
  const f = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "willard-optimize-cache-outside-"));
  const outsideCache = path.join(outside, "optimize-scan.json");
  const cacheDir = path.join(f.root, "WillardAI", "cache");
  try {
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
    fs.writeFileSync(outsideCache, "outside sentinel");
    fs.symlinkSync(outside, cacheDir, "dir");

    assert.equal(await readOptimizeScanCache(
      scanCachePath(f.root), f.root, scanCacheOptions(Date.now()),
    ), null);
    await writeOptimizeScanCache(scanCachePath(f.root), f.root, {
      scannedAt: new Date().toISOString(),
    }, 8);
    assert.equal(fs.readFileSync(outsideCache, "utf8"), "outside sentinel");
  } finally {
    f.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("Optimize scan cache never follows a symlinked cache file", {
  skip: process.platform === "win32",
}, async () => {
  const f = fixture();
  const outside = path.join(f.root, "outside-cache-target.json");
  const cachePath = scanCachePath(f.root);
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(outside, "outside sentinel");
    fs.symlinkSync(outside, cachePath);

    assert.equal(await readOptimizeScanCache(cachePath, f.root, scanCacheOptions(Date.now())), null);
    await writeOptimizeScanCache(cachePath, f.root, {
      scannedAt: new Date().toISOString(),
      profile: "ARCHIVE",
      rawConversionEnabled: false,
    }, 8);
    assert.equal(fs.readFileSync(outside, "utf8"), "outside sentinel");

    const finalEntry = fs.lstatSync(cachePath);
    assert.ok(finalEntry.isSymbolicLink() || finalEntry.isFile());
    if (!finalEntry.isSymbolicLink()) {
      assert.equal(finalEntry.isFile(), true, "atomic publication must leave a regular cache file");
    }
  } finally {
    f.cleanup();
  }
});

test("Optimize scan cache rejects a regular file replaced between lstat and open", async () => {
  const f = fixture();
  const now = Date.now();
  const cachePath = scanCachePath(f.root);
  const displacedPath = `${cachePath}.displaced`;
  try {
    await writeOptimizeScanCache(cachePath, f.root, {
      scannedAt: new Date(now - 1_000).toISOString(),
      profile: "ARCHIVE",
      rawConversionEnabled: false,
    }, 8);

    const promises = fs.promises as unknown as { open: typeof fs.promises.open };
    const originalOpen = promises.open;
    let replaced = false;
    promises.open = async (...args: Parameters<typeof fs.promises.open>) => {
      const [target] = args;
      if (!replaced && path.resolve(String(target)) === path.resolve(cachePath)) {
        fs.renameSync(cachePath, displacedPath);
        fs.writeFileSync(cachePath, JSON.stringify({
          scannedAt: new Date(now - 1_000).toISOString(),
          cacheVersion: 8,
          profile: "ARCHIVE",
          rawConversionEnabled: false,
        }), "utf8");
        replaced = true;
      }
      return originalOpen(...args);
    };
    try {
      const cached = await readOptimizeScanCache(cachePath, f.root, scanCacheOptions(now));
      assert.equal(replaced, true, "the test must replace the path after the initial lstat");
      assert.equal(cached, null, "a different file identity must not be accepted as the opened cache entry");
    } finally {
      promises.open = originalOpen;
    }
  } finally {
    f.cleanup();
  }
});
