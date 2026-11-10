const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readStaticFileWithinRoot } = require("./serve.js");

test("static server reads regular files under its root", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-static-root-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "index.html"), "safe content");

  const result = readStaticFileWithinRoot(root, "/index.html");
  assert.equal(result.status, "ok");
  assert.equal(result.content.toString("utf8"), "safe content");
});

test("static server rejects parent symlink swaps before opening a file", (t) => {
  if (process.platform !== "linux") {
    t.skip("Handle-relative static reads use Linux procfs descriptors.");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-static-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "willard-static-outside-"));
  const assets = path.join(root, "assets");
  fs.mkdirSync(assets);
  fs.writeFileSync(path.join(assets, "bundle.js"), "safe bundle");
  fs.writeFileSync(path.join(outside, "bundle.js"), "outside secret");
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const result = readStaticFileWithinRoot(root, "assets/bundle.js", {
    afterParentOpened: () => {
      fs.renameSync(assets, path.join(root, "assets-original"));
      fs.symlinkSync(outside, assets, "dir");
    },
  });
  assert.equal(result.status, "ok");
  assert.equal(result.content.toString("utf8"), "safe bundle");
});

test("static server refuses a parent swapped to an outside symlink before it opens", (t) => {
  if (process.platform !== "linux") {
    t.skip("Handle-relative static reads use Linux procfs descriptors.");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-static-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "willard-static-outside-"));
  const assets = path.join(root, "assets");
  fs.mkdirSync(assets);
  fs.writeFileSync(path.join(outside, "bundle.js"), "outside secret");
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const result = readStaticFileWithinRoot(root, "assets/bundle.js", {
    afterRootOpened: () => {
      fs.renameSync(assets, path.join(root, "assets-original"));
      fs.symlinkSync(outside, assets, "dir");
    },
  });
  assert.equal(result.status, "forbidden");
});

test("static server rejects traversal and symlink targets outside its root", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-static-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "willard-static-outside-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside content");

  assert.equal(readStaticFileWithinRoot(root, "../../secret.txt").status, "forbidden");
  try {
    fs.symlinkSync(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) {
      t.skip("directory symlinks require elevated permissions on this Windows runner");
      return;
    }
    throw error;
  }

  assert.equal(readStaticFileWithinRoot(root, "linked/secret.txt").status, "forbidden");
});

test("static server does not expose directories as files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-static-root-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "assets"));

  assert.equal(readStaticFileWithinRoot(root, "assets").status, "missing");
});
