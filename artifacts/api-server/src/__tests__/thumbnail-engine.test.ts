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
    const stale = path.join(dir, "old.1.tmp.webp");
    fs.writeFileSync(stale, Buffer.alloc(17));
    const oldTime = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(stale, oldTime, oldTime);
    assert.deepEqual(cleanStaleThumbnailPartials(root), { files: 1, bytes: 17 });

    const kept = enforceThumbnailCacheQuota(root, fs.statSync(second.destPath!).size, second.destPath!);
    assert.equal(fs.existsSync(second.destPath!), true);
    assert.equal(fs.existsSync(first.destPath!), false);
    assert.equal(kept.files, 1);
  });
});