import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
      assert.equal(fs.readFileSync(descriptor, "utf8"), "inside-data");
    } finally {
      fs.closeSync(descriptor);
    }
    assert.throws(() => safeFs.openRegularFile(library, outsideFile));
  });

  test("keeps a verified file handle safe when its parent path is replaced", (t) => {
    const { library, outside } = fixture(t);
    const parent = path.join(library, "photos");
    const movedParent = path.join(library, "photos-original");
    const file = path.join(parent, "image.bin");
    fs.mkdirSync(parent);
    fs.writeFileSync(file, "verified-image");
    fs.writeFileSync(path.join(outside, "secret.bin"), "outside-secret");

    const descriptor = safeFs.openRegularFile(library, file, () => {
      fs.renameSync(parent, movedParent);
      fs.symlinkSync(outside, parent, "junction");
    });
    try {
      assert.equal(fs.readFileSync(descriptor, "utf8"), "verified-image");
      assert.equal(fs.readFileSync(path.join(parent, "secret.bin"), "utf8"), "outside-secret");
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
