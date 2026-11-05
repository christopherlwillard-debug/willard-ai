import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findEmptyDirectories } from "../lib/empty-folder-scan.ts";

test("empty folder scan includes empty descendants and parents that become empty", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-empty-folders-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parent = path.join(root, "parent");
  const child = path.join(parent, "child");
  fs.mkdirSync(child, { recursive: true });
  const found = await findEmptyDirectories(root);
  assert.deepEqual(found, [child, parent]);
  assert.equal(found.includes(root), false);
});

test("empty folder scan does not follow symlinks or call a directory containing one empty", async (t) => {
  if (process.platform === "win32") {
    t.skip("Symlink creation may require elevated Windows privileges.");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-empty-folders-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "willard-empty-outside-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
  const candidate = path.join(root, "candidate");
  fs.mkdirSync(candidate);
  fs.symlinkSync(outside, path.join(candidate, "linked"));
  assert.deepEqual(await findEmptyDirectories(root), []);
});

test("empty folder scan fails rather than silently returning a partial result", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-empty-folders-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(findEmptyDirectories(path.join(root, "missing")), /ENOENT/);
});
