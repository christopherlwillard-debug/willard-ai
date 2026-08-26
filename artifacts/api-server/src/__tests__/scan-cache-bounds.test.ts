import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MAX_PENDING_DIRECTORIES,
  ScanPriorityQueue,
  SCAN_QUEUE_CAPACITY,
  walkNasAsync,
  type FileEntry,
} from "../lib/library-engine/indexer.ts";
import {
  flushDirCacheInvalidations,
  invalidateDirMtimeCache,
  loadDirMtimeCache,
  saveDirMtimeCache,
} from "../lib/library-engine/job-engine.ts";
import { DEFAULT_SCANNER_SETTINGS } from "../lib/system-filter.ts";

function makeEntry(index: number): FileEntry {
  return {
    fullPath: `/tmp/file-${index}.jpg`,
    name: `file-${index}.jpg`,
    ext: "jpg",
    sizeBytes: index,
    modifiedAt: new Date(0),
  };
}

function invalidationMarkerFiles(cacheDir: string): string[] {
  return fs.readdirSync(cacheDir)
    .filter(name => name === "dir-scan-invalidations.json" ||
      (name.startsWith("dir-scan-invalidations.") && name.endsWith(".json")))
    .map(name => path.join(cacheDir, name))
    .sort();
}

test("scan priority queue applies backpressure at its bounded capacity", async () => {
  const queue = new ScanPriorityQueue();
  for (let i = 0; i < SCAN_QUEUE_CAPACITY; i++) {
    assert.equal(await queue.pushAsync(makeEntry(i)), true);
  }
  assert.equal(queue.size, SCAN_QUEUE_CAPACITY);

  let resolved = false;
  const pendingPush = queue.pushAsync(makeEntry(SCAN_QUEUE_CAPACITY)).then((result) => {
    resolved = true;
    return result;
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(resolved, false);
  assert.equal(queue.size, SCAN_QUEUE_CAPACITY);

  assert.ok(await queue.pop());
  assert.equal(await pendingPush, true);
  assert.equal(queue.size, SCAN_QUEUE_CAPACITY);
  queue.close();
});

test("closing a full queue releases a producer blocked by backpressure", async () => {
  const queue = new ScanPriorityQueue();
  for (let i = 0; i < SCAN_QUEUE_CAPACITY; i++) {
    assert.equal(await queue.pushAsync(makeEntry(i)), true);
  }
  const stopSignal = { stop: false };
  const blockedPush = queue.pushAsync(makeEntry(SCAN_QUEUE_CAPACITY), stopSignal);
  await new Promise<void>(resolve => setImmediate(resolve));
  stopSignal.stop = true;
  queue.close();
  assert.equal(await blockedPush, false);
});

test("async walker streams a large directory without queue fan-out", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-scan-bounds-"));
  const totalFiles = SCAN_QUEUE_CAPACITY + 257;
  try {
    for (let i = 0; i < totalFiles; i++) {
      fs.writeFileSync(path.join(root, `photo-${i}.jpg`), `photo-${i}`);
    }

    const queue = new ScanPriorityQueue();
    const seen: string[] = [];
    let maxQueueSize = 0;
    let draining = true;
    const drain = (async () => {
      while (draining || queue.size > 0) {
        const entry = await queue.pop();
        if (entry) {
          seen.push(entry.name);
          maxQueueSize = Math.max(maxQueueSize, queue.size);
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      }
    })();

    await walkNasAsync(root, new Set(), queue, undefined, undefined, undefined, undefined, undefined, undefined, root, DEFAULT_SCANNER_SETTINGS);
    draining = false;
    queue.close();
    await drain;

    assert.equal(seen.length, totalFiles);
    assert.ok(maxQueueSize <= SCAN_QUEUE_CAPACITY);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("async walker completes a directory-heavy tree beyond the pending-directory cap", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-dir-bounds-"));
  const totalDirectories = MAX_PENDING_DIRECTORIES + 129;
  try {
    for (let i = 0; i < totalDirectories; i++) {
      fs.mkdirSync(path.join(root, `album-${i}`));
    }
    const queue = new ScanPriorityQueue();
    let discoveredDirectories = 0;
    await walkNasAsync(
      root,
      new Set(),
      queue,
      undefined,
      () => { discoveredDirectories++; },
      undefined,
      undefined,
      undefined,
      undefined,
      root,
      DEFAULT_SCANNER_SETTINGS,
    );
    queue.close();
    assert.equal(discoveredDirectories, totalDirectories);
    assert.equal(queue.size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("watcher invalidations persist and remove the affected cache subtree", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-dir-cache-"));
  const cacheDir = path.join(root, "WillardAI", "cache");
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, "dir-scan-cache.json"),
      JSON.stringify({
        v: 4,
        root,
        updatedAt: new Date().toISOString(),
        dirs: {
          "albums": { m: 1, c: 2 },
          "albums/holiday": { m: 2, c: 3 },
          "documents": { m: 3, c: 4 },
        },
      }),
    );

    invalidateDirMtimeCache(root, "albums/holiday/new-photo.jpg");
    flushDirCacheInvalidations();

    const [firstMarkerPath] = invalidationMarkerFiles(cacheDir);
    assert.ok(firstMarkerPath);
    const marker = JSON.parse(fs.readFileSync(firstMarkerPath, "utf8"));
    assert.deepEqual(marker.dirs.sort(), ["albums/holiday", "albums/holiday/new-photo.jpg"]);

    const cache = await loadDirMtimeCache(root);
    assert.equal(cache.has("albums"), true);
    assert.equal(cache.has("albums/holiday"), false);
    assert.equal(cache.has("documents"), true);

    // Simulate a new watcher event after this scan consumed its marker but
    // before it publishes the updated cache. The new marker must not be erased.
    invalidateDirMtimeCache(root, "documents/renamed.pdf");
    flushDirCacheInvalidations();
    saveDirMtimeCache(root, cache, true);

    const markerFilesAfterSave = invalidationMarkerFiles(cacheDir);
    assert.equal(markerFilesAfterSave.length, 1);
    const markerAfterSave = JSON.parse(fs.readFileSync(markerFilesAfterSave[0]!, "utf8"));
    assert.equal(markerAfterSave.v, 3);
    assert.ok(markerAfterSave.dirs.includes("documents"));

    const nextCache = await loadDirMtimeCache(root);
    assert.equal(nextCache.has("documents"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable persisted invalidation marker forces a full reconciliation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-corrupt-marker-"));
  const cacheDir = path.join(root, "WillardAI", "cache");
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, "dir-scan-cache.json"),
      JSON.stringify({
        v: 4,
        root,
        updatedAt: new Date().toISOString(),
        dirs: { albums: { m: 1, c: 2 } },
      }),
    );
    fs.writeFileSync(path.join(cacheDir, "dir-scan-invalidations.json"), "{\"v\":");

    const cache = await loadDirMtimeCache(root);
    assert.equal(cache.size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});