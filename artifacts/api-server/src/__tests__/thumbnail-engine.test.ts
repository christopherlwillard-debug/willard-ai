import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
  generateThumbnail,
  getThumbnailDir,
  isThumbnailFileValid,
  getThumbnailCacheStats,
  enforceThumbnailCacheQuota,
  cleanStaleThumbnailPartials,
  clearThumbnailCache,
  removeOrphanedThumbnail,
  ensureThumbnailDir,
  findValidThumbnailPath,
  findReusableThumbnailPaths,
  THUMBNAIL_REUSE_PROBE_MAX_FILES,
} from "../lib/thumbnail-engine.ts";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});


async function createSource(root: string): Promise<string> {
  const sharp = (await import("sharp")).default;
  const source = path.join(root, "source.jpg");
  await sharp(crypto.randomBytes(96 * 64 * 3), {
    raw: { width: 96, height: 64, channels: 3 },
  }).jpeg({ quality: 90 }).toFile(source);
  return source;
}

describe("thumbnail publication", { concurrency: false }, () => {
  test("serializes concurrent requests and publishes one valid WebP", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-thumbnail-"));
    roots.push(root);
    const source = await createSource(root);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => generateThumbnail(41, source, "jpg", root)),
    );

    assert.ok(results.every(result => result.error === null));
    assert.ok(results.every(result => result.destPath === results[0]!.destPath));
    const dest = results[0]!.destPath;
    assert.ok(dest && isThumbnailFileValid(dest));
    const files = fs.readdirSync(getThumbnailDir(root));
    assert.deepEqual(files, ["41.webp"]);
  });

  test("does not steal an aged thumbnail lock while another worker may still own it", () => {
    const source = fs.readFileSync(new URL("../lib/thumbnail-engine.ts", import.meta.url), "utf8");
    assert.match(source, /Never steal a lock based only on age/);
    assert.match(source, /Timed out waiting for thumbnail generation lock/);
    assert.doesNotMatch(source, /THUMBNAIL_LOCK_STALE_MS/);
    assert.doesNotMatch(source, /ageMs > THUMBNAIL_LOCK_STALE_MS/);
  });

  test("replaces a corrupt legacy cache file instead of serving it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-thumbnail-"));
    roots.push(root);
    const source = await createSource(root);
    const dir = getThumbnailDir(root);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "42.webp"), Buffer.alloc(2048, 7));

    const result = await generateThumbnail(42, source, "jpg", root);

    assert.equal(result.error, null);
    assert.ok(isThumbnailFileValid(result.destPath));
  });

  test("does not leave a final or temporary file after generation fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-thumbnail-"));
    roots.push(root);

    const result = await generateThumbnail(43, path.join(root, "missing.jpg"), "jpg", root);

    assert.ok(result.error);
    assert.equal(result.destPath, "");
    assert.deepEqual(fs.readdirSync(getThumbnailDir(root)), []);
  });

  test("excludes locks, partials, and invalid files from durable cache accounting", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-thumbnail-"));
    roots.push(root);
    const source = await createSource(root);
    const result = await generateThumbnail(44, source, "jpg", root);
    assert.equal(result.error, null);

    const dir = getThumbnailDir(root);
    fs.writeFileSync(path.join(dir, "45.webp.lock"), "lock");
    fs.writeFileSync(path.join(dir, "45.webp.1.tmp.webp"), Buffer.alloc(400));
    fs.writeFileSync(path.join(dir, "45.webp.frame.png"), Buffer.alloc(500));
    fs.writeFileSync(path.join(dir, "invalid.webp"), Buffer.alloc(500));

    const stats = getThumbnailCacheStats(root);
    assert.equal(stats.files, 1);
    assert.equal(stats.bytes, fs.statSync(result.destPath!).size);
    assert.equal(stats.incompleteFiles, 3);
    assert.equal(stats.incompleteBytes, 904);
  });

  test("does not remove a stale partial while its destination publisher lock exists", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-thumbnail-"));
    roots.push(root);
    const dir = ensureThumbnailDir(root);
    const partial = path.join(dir, "54.webp.123.456.1.tmp.webp");
    const lock = path.join(dir, "54.webp.lock");
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.writeFileSync(partial, Buffer.alloc(17));
    fs.utimesSync(partial, old, old);
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));

    assert.deepEqual(await cleanStaleThumbnailPartials(root), { files: 0, bytes: 0 });
    assert.equal(fs.existsSync(partial), true, "an active publisher's partial must be preserved");

    fs.unlinkSync(lock);
    assert.deepEqual(await cleanStaleThumbnailPartials(root), { files: 1, bytes: 17 });
    assert.equal(fs.existsSync(partial), false);
  });

  test("removes abandoned partials and evicts oldest valid files over quota", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-thumbnail-"));
    roots.push(root);
    const source = await createSource(root);
    const first = await generateThumbnail(51, source, "jpg", root);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await generateThumbnail(52, source, "jpg", root);
    assert.equal(first.error, null);
    assert.equal(second.error, null);

    const dir = getThumbnailDir(root);
    const stale = path.join(dir, "old.webp.123.456.1.tmp.webp");
    fs.writeFileSync(stale, Buffer.alloc(17));
    const oldTime = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(stale, oldTime, oldTime);
    assert.deepEqual(await cleanStaleThumbnailPartials(root), { files: 1, bytes: 17 });

    const kept = await enforceThumbnailCacheQuota(root, fs.statSync(second.destPath!).size, second.destPath!);
    assert.equal(fs.existsSync(second.destPath!), true);
    assert.equal(fs.existsSync(first.destPath!), false);
    assert.equal(kept.files, 1);
  });

  test("quota eviction preserves a thumbnail with an active publisher lock", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-thumbnail-"));
    roots.push(root);
    const source = await createSource(root);
    const first = await generateThumbnail(71, source, "jpg", root);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await generateThumbnail(72, source, "jpg", root);
    assert.equal(first.error, null);
    assert.equal(second.error, null);

    const lock = `${first.destPath}.lock`;
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
    const maxBytes = fs.statSync(second.destPath!).size;
    const whileLocked = await enforceThumbnailCacheQuota(root, maxBytes, second.destPath!);
    assert.equal(fs.existsSync(first.destPath!), true);
    assert.equal(whileLocked.files, 2);

    fs.unlinkSync(lock);
    const afterRelease = await enforceThumbnailCacheQuota(root, maxBytes, second.destPath!);
    assert.equal(fs.existsSync(first.destPath!), false);
    assert.equal(fs.existsSync(second.destPath!), true);
    assert.equal(afterRelease.files, 1);
  });

  test("cache clearing preserves active thumbnail locks and partial outputs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-thumbnail-"));
    roots.push(root);
    const source = await createSource(root);
    const generated = await generateThumbnail(53, source, "jpg", root);
    assert.equal(generated.error, null);

    const dir = getThumbnailDir(root);
    const lock = path.join(dir, "54.webp.lock");
    const partial = path.join(dir, "54.webp.123.456.1.tmp.webp");
    const frame = path.join(dir, "54.webp.frame.png");
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
    fs.writeFileSync(partial, Buffer.alloc(128));
    fs.writeFileSync(frame, Buffer.alloc(128));

    assert.equal(await clearThumbnailCache(root), 1);
    assert.equal(fs.existsSync(generated.destPath), false);
    assert.equal(fs.existsSync(lock), true);
    assert.equal(fs.existsSync(partial), true);
    assert.equal(fs.existsSync(frame), true);
  });

  test("waits for an active thumbnail publisher lock before removing its final WebP", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-thumbnail-"));
    roots.push(root);
    const source = await createSource(root);
    const generated = await generateThumbnail(54, source, "jpg", root);
    assert.equal(generated.error, null);

    const lock = `${generated.destPath}.lock`;
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
    const clearing = clearThumbnailCache(root);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const remainedWhileLocked = fs.existsSync(generated.destPath);
    fs.unlinkSync(lock);

    assert.equal(await clearing, 1);
    assert.equal(remainedWhileLocked, true, "cache cleanup must wait while a publisher owns the same thumbnail lock");
    assert.equal(fs.existsSync(generated.destPath), false);
  });

  test("rejects symlinked thumbnail cache directories before stats, writes, or cleanup", async (t) => {
    if (process.platform === "win32") {
      t.skip("creating directory symlinks requires elevated privileges on some Windows runners");
      return;
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-thumbnail-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "willard-thumbnail-outside-"));
    roots.push(root, outside);
    fs.mkdirSync(path.dirname(getThumbnailDir(root)), { recursive: true });
    const sentinel = path.join(outside, "preserve.webp");
    fs.writeFileSync(sentinel, Buffer.alloc(128));
    fs.symlinkSync(outside, getThumbnailDir(root), "dir");

    assert.throws(() => getThumbnailCacheStats(root), /symlink/i);
    assert.throws(() => ensureThumbnailDir(root), /symlink/i);
    await assert.rejects(clearThumbnailCache(root), /symlink/i);
    assert.equal(fs.existsSync(sentinel), true, "cleanup must never follow a cache-directory symlink");
  });

  test("reuses a real-size thumbnail cache after restart without rewriting completed files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-thumbnail-"));
    roots.push(root);
    const source = await createSource(root);
    const fileCount = 128;

    const buildStarted = process.hrtime.bigint();
    const firstPass = await Promise.all(
      Array.from({ length: fileCount }, (_, index) =>
        generateThumbnail(10_000 + index, source, "jpg", root)),
    );
    const buildMs = Number(process.hrtime.bigint() - buildStarted) / 1_000_000;
    assert.ok(firstPass.every((result) => result.error === null && result.reused === false));

    const mtimes = firstPass.map((result) => fs.statSync(result.destPath).mtimeMs);
    const reuseStarted = process.hrtime.bigint();
    const secondPass = await Promise.all(
      Array.from({ length: fileCount }, (_, index) =>
        generateThumbnail(10_000 + index, source, "jpg", root)),
    );
    const reuseMs = Number(process.hrtime.bigint() - reuseStarted) / 1_000_000;
    const reuseThroughput = fileCount / Math.max(reuseMs / 1000, 0.001);

    assert.ok(secondPass.every((result) => result.error === null && result.reused === true));
    assert.deepEqual(
      secondPass.map((result) => fs.statSync(result.destPath).mtimeMs),
      mtimes,
    );
    assert.equal(getThumbnailCacheStats(root).files, fileCount);
    assert.equal(findValidThumbnailPath(10_000, root, null), secondPass[0]!.destPath);
    assert.ok(reuseMs < buildMs, `expected cache reuse (${reuseMs}ms) to beat generation (${buildMs}ms)`);
    assert.ok(reuseThroughput >= 64, `cache reuse throughput regressed to ${reuseThroughput}/s`);

    console.info("[thumbnail-regression]", {
      files: fileCount,
      buildMs: Math.round(buildMs),
      reuseMs: Math.round(reuseMs),
      reuseThroughputFilesPerSec: Math.round(reuseThroughput),
      cacheReuse: `${fileCount}/${fileCount}`,
    });

    const oversizedIds = Array.from(
      { length: THUMBNAIL_REUSE_PROBE_MAX_FILES + 100 },
      (_, index) => 20_000 + index,
    );
    for (const id of oversizedIds) {
      fs.copyFileSync(secondPass[0]!.destPath, path.join(getThumbnailDir(root), `${id}.webp`));
    }
    const boundedReuse = findReusableThumbnailPaths(oversizedIds, root);
    assert.equal(boundedReuse.size, THUMBNAIL_REUSE_PROBE_MAX_FILES);
    assert.equal(boundedReuse.has(oversizedIds[THUMBNAIL_REUSE_PROBE_MAX_FILES]!), false);

    const stalePointer = path.join(root, ".willard-ai", "thumbnails", "stale.webp");
    fs.mkdirSync(path.dirname(stalePointer), { recursive: true });
    fs.writeFileSync(stalePointer, "not a webp");
    const invalidStored = findReusableThumbnailPaths(
      [99_999],
      root,
      1,
      new Map([[99_999, stalePointer]]),
    );
    assert.equal(invalidStored.size, 0, "an invalid stored pointer must remain pending");
  });

  test("cache clearing waits for catalog persistence after a new thumbnail publication", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-thumbnail-"));
    roots.push(root);
    const source = await createSource(root);
    let signalReady!: () => void;
    let releaseReady!: () => void;
    const callbackStarted = new Promise<void>((resolve) => { signalReady = resolve; });
    const callbackGate = new Promise<void>((resolve) => { releaseReady = resolve; });

    const generation = generateThumbnail(901, source, "jpg", root, undefined, async ({ destPath, reused }) => {
      assert.equal(reused, false);
      assert.equal(isThumbnailFileValid(destPath), true);
      signalReady();
      await callbackGate;
    });
    await callbackStarted;

    const clearing = clearThumbnailCache(root);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(path.join(getThumbnailDir(root), "901.webp")), true,
      "cache clearing must wait for the in-flight catalog pointer write");

    releaseReady();
    const generated = await generation;
    assert.equal(generated.error, null);
    assert.equal(await clearing, 1);
    assert.equal(fs.existsSync(generated.destPath), false);
  });

  test("cache clearing waits for catalog persistence when a valid thumbnail is reused", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-thumbnail-"));
    roots.push(root);
    const source = await createSource(root);
    const first = await generateThumbnail(902, source, "jpg", root);
    assert.equal(first.error, null);

    let signalReady!: () => void;
    let releaseReady!: () => void;
    const callbackStarted = new Promise<void>((resolve) => { signalReady = resolve; });
    const callbackGate = new Promise<void>((resolve) => { releaseReady = resolve; });

    const reuse = generateThumbnail(902, source, "jpg", root, undefined, async ({ destPath, reused }) => {
      assert.equal(reused, true);
      assert.equal(isThumbnailFileValid(destPath), true);
      signalReady();
      await callbackGate;
    });
    await callbackStarted;

    const clearing = clearThumbnailCache(root);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(first.destPath), true,
      "cache clearing must wait for the reused thumbnail's catalog pointer write");

    releaseReady();
    const reused = await reuse;
    assert.equal(reused.error, null);
    assert.equal(reused.reused, true);
    assert.equal(await clearing, 1);
    assert.equal(fs.existsSync(first.destPath), false);
  });


  test("orphan cleanup waits for a publisher and rechecks active catalog membership", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-thumbnail-"));
    roots.push(root);
    const source = await createSource(root);
    let signalReady!: () => void;
    let releaseReady!: () => void;
    const callbackStarted = new Promise<void>((resolve) => { signalReady = resolve; });
    const callbackGate = new Promise<void>((resolve) => { releaseReady = resolve; });

    const generation = generateThumbnail(903, source, "jpg", root, undefined, async ({ destPath }) => {
      assert.equal(isThumbnailFileValid(destPath), true);
      signalReady();
      await callbackGate;
    });
    await callbackStarted;

    let checkedCatalog = false;
    const cleanup = removeOrphanedThumbnail(root, path.join(getThumbnailDir(root), "903.webp"), async () => {
      checkedCatalog = true;
      return false;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(checkedCatalog, false, "orphan status must be rechecked only after the publisher lock is released");
    releaseReady();
    assert.equal((await generation).error, null);
    assert.equal(await cleanup, false);
    assert.equal(checkedCatalog, true);
    assert.equal(fs.existsSync(path.join(getThumbnailDir(root), "903.webp")), true);
  });

  test("orphan cleanup removes only a regular canonical thumbnail still confirmed orphaned", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-thumbnail-"));
    roots.push(root);
    const source = await createSource(root);
    const generated = await generateThumbnail(904, source, "jpg", root);
    assert.equal(generated.error, null);

    assert.equal(await removeOrphanedThumbnail(root, generated.destPath, async () => true), true);
    assert.equal(fs.existsSync(generated.destPath), false);
    assert.equal(await removeOrphanedThumbnail(root, path.join(getThumbnailDir(root), "../904.webp"), async () => true), false);
  });

});