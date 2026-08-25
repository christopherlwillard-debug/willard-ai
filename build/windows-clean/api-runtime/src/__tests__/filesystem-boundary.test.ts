import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertWithinRoot, resolveLibraryPath } from "../lib/nas-storage.ts";

const temporaryRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-boundary-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  while (temporaryRoots.length) {
    const root = temporaryRoots.pop()!;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolves a normal relative media path inside the configured root", () => {
  const root = makeRoot();
  const media = path.join(root, "photos", "one.jpg");
  fs.mkdirSync(path.dirname(media), { recursive: true });
  fs.writeFileSync(media, "media");

  assert.equal(resolveLibraryPath(root, "photos/one.jpg"), media);
  assert.doesNotThrow(() => assertWithinRoot(media, root));
});

test("rejects traversal and absolute database paths", () => {
  const root = makeRoot();
  const outside = path.join(path.dirname(root), "outside.txt");
  for (const relativePath of ["../outside.txt", "photos/../../outside.txt", outside, "/etc/passwd", "C:\\Windows\\win.ini", "\\\\server\\share\\file.jpg"]) {
    assert.throws(
      () => resolveLibraryPath(root, relativePath),
      /Path traversal rejected|must be relative/,
      relativePath,
    );
  }
});

test("rejects a symlinked directory that escapes the library", () => {
  const root = makeRoot();
  const outside = makeRoot();
  fs.writeFileSync(path.join(outside, "secret.jpg"), "secret");
  fs.symlinkSync(outside, path.join(root, "linked"), "dir");

  assert.throws(
    () => resolveLibraryPath(root, "linked/secret.jpg"),
    /Path traversal rejected/,
  );
});

test("rejects a symlink escape even when the requested child does not exist", () => {
  const root = makeRoot();
  const outside = makeRoot();
  fs.symlinkSync(outside, path.join(root, "linked"), "dir");

  assert.throws(
    () => resolveLibraryPath(root, "linked/new-folder/new-file.jpg"),
    /Path traversal rejected/,
  );
});

test("does not confuse a sibling with a valid path under the root", () => {
  const root = makeRoot();
  const sibling = `${root}-sibling`;
  fs.mkdirSync(sibling);
  try {
    assert.throws(
      () => assertWithinRoot(sibling, root),
      /Path traversal rejected/,
    );
  } finally {
    fs.rmSync(sibling, { recursive: true, force: true });
  }
});

test("rejects a poisoned root-relative path containing a null byte", () => {
  const root = makeRoot();
  assert.throws(
    () => resolveLibraryPath(root, "photos/\0secret.jpg"),
    /Invalid library-relative path/,
  );
});