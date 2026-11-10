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

  const result = readStaticFileWithinRoot(root, "index.html");
  assert.equal(result.status, "ok");
  assert.equal(result.content.toString("utf8"), "safe content");
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
