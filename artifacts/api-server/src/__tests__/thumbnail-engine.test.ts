import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { generateThumbnail, getThumbnailDir, isThumbnailFileValid } from "../lib/thumbnail-engine.ts";

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
});