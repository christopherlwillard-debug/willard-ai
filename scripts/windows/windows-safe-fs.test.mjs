import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const nativeSourcePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../artifacts/api-server/native/windows-safe-fs/windows_safe_fs.cc",
);

test("native file descriptors are created through Node's libuv runtime", () => {
  const source = fs.readFileSync(nativeSourcePath, "utf8");
  assert.match(source, /\buv_open_osfhandle\s*\(/);
  assert.doesNotMatch(source, /\b_open_osfhandle\s*\(/);
});

if (process.platform !== "win32") {
  test("native Windows safe-filesystem behavior", { skip: "Windows-only native handle test." }, () => {});
} else {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const addonPath = process.env.WILLARD_WINDOWS_SAFE_FS_ADDON ||
    path.join(root, "artifacts", "api-server", "native", "windows-safe-fs", "build", "Release", "windows_safe_fs.node");
  const require = createRequire(import.meta.url);
  const safeFs = require(addonPath);

  function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "willard-safe-fs-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const library = path.join(directory, "library");
    const outside = path.join(directory, "outside");
    fs.mkdirSync(library);
    fs.mkdirSync(outside);
    return { directory, library, outside };
  }

  test("opens a verified file handle and rejects paths outside the configured root", (t) => {
    const { library, outside } = fixture(t);
    const insideFile = path.join(library, "inside.txt");
    const outsideFile = path.join(outside, "secret.txt");
    fs.writeFileSync(insideFile, "inside-data");
    fs.writeFileSync(outsideFile, "outside-data");

    const descriptor = safeFs.openRegularFile(library, insideFile);
    try {
      assert.equal(fs.fstatSync(descriptor).isFile(), true);
      assert.equal(fs.readFileSync(descriptor, "utf8"), "inside-data");
    } finally {
      fs.closeSync(descriptor);
    }
    assert.throws(() => safeFs.openRegularFile(library, outsideFile));
  });

  test("does not list or open content through a junction beneath the library", (t) => {
    const { library, outside } = fixture(t);
    const junction = path.join(library, "outside-link");
    fs.writeFileSync(path.join(outside, "secret.txt"), "outside-data");
    fs.symlinkSync(outside, junction, "junction");

    assert.deepEqual(safeFs.readDirectory(library, library).entries, []);
    assert.throws(() => safeFs.readDirectory(library, junction));
    assert.throws(() => safeFs.openRegularFile(library, path.join(junction, "secret.txt")));
  });

  test("keeps a verified file safe if Windows blocks parent replacement", (t) => {
    const { library, outside } = fixture(t);
    const parent = path.join(library, "photos");
    const movedParent = path.join(library, "photos-original");
    const file = path.join(parent, "image.bin");
    fs.mkdirSync(parent);
    fs.writeFileSync(file, "verified-image");
    fs.writeFileSync(path.join(outside, "secret.bin"), "outside-secret");

    let replacementBlocked = false;
    const descriptor = safeFs.openRegularFile(library, file, () => {
      try {
        fs.renameSync(parent, movedParent);
      } catch (error) {
        // A Windows sharing lock that prevents replacement is also a safe outcome.
        if (error?.code !== "EPERM" && error?.code !== "EBUSY") throw error;
        replacementBlocked = true;
        return;
      }
      fs.symlinkSync(outside, parent, "junction");
    });
    try {
      assert.equal(fs.fstatSync(descriptor).isFile(), true);
      assert.equal(fs.readFileSync(descriptor, "utf8"), "verified-image");
      if (replacementBlocked) {
        assert.equal(fs.existsSync(parent), true);
        assert.equal(fs.existsSync(movedParent), false);
        assert.equal(fs.readFileSync(file, "utf8"), "verified-image");
        assert.equal(fs.readFileSync(path.join(outside, "secret.bin"), "utf8"), "outside-secret");
      } else {
        assert.equal(fs.readFileSync(path.join(parent, "secret.bin"), "utf8"), "outside-secret");
      }
    } finally {
      fs.closeSync(descriptor);
    }
  });

  test("enumerates the opened directory handle after its pathname is replaced", (t) => {
    const { library, outside } = fixture(t);
    const target = path.join(library, "album");
    const movedTarget = path.join(library, "album-original");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "photo.jpg"), "photo");
    fs.writeFileSync(path.join(outside, "secret.jpg"), "outside");

    const result = safeFs.readDirectory(library, target, () => {
      fs.renameSync(target, movedTarget);
      fs.symlinkSync(outside, target, "junction");
    });
    assert.deepEqual(result.entries.map((entry) => entry.name), ["photo.jpg"]);
    assert.equal(fs.readFileSync(path.join(target, "secret.jpg"), "utf8"), "outside");
  });

  test("removes only the opened empty directory when its pathname is replaced", (t) => {
    const { library, outside } = fixture(t);
    const target = path.join(library, "empty");
    const movedTarget = path.join(library, "empty-original");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(outside, "keep.txt"), "keep");

    assert.equal(safeFs.removeEmptyDirectory(library, target, () => {
      fs.renameSync(target, movedTarget);
      fs.symlinkSync(outside, target, "junction");
    }), true);
    assert.equal(fs.existsSync(target), true);
    assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "keep");
    assert.equal(fs.existsSync(movedTarget), false);
  });

  test("does not remove a non-empty directory", (t) => {
    const { library } = fixture(t);
    const target = path.join(library, "not-empty");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "keep.txt"), "keep");

    assert.equal(safeFs.removeEmptyDirectory(library, target), false);
    assert.equal(fs.existsSync(path.join(target, "keep.txt")), true);
  });
}
