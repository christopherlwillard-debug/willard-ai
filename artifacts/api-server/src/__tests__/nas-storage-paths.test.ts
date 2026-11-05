import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getTempDir } from "../lib/nas-storage.ts";

function makeTempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("getTempDir creates a private canonical directory inside the configured library", () => {
  const root = makeTempRoot("willard-nas-root-");
  try {
    const tempDir = getTempDir(root, "org-123");
    assert.equal(path.relative(root, tempDir).startsWith(".."), false);
    assert.ok(fs.statSync(tempDir).isDirectory());
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(tempDir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.dirname(tempDir)).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.dirname(path.dirname(tempDir))).mode & 0o777, 0o700);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("getTempDir rejects a WillardAI directory symlink escaping the library", () => {
  const root = makeTempRoot("willard-nas-root-");
  const outside = makeTempRoot("willard-nas-outside-");
  try {
    fs.symlinkSync(outside, path.join(root, "WillardAI"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => getTempDir(root, "org-123"), /symlink/);
    assert.equal(fs.existsSync(path.join(outside, "temp", "org-123")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("getTempDir rejects a temp-directory symlink escaping the library", () => {
  const root = makeTempRoot("willard-nas-root-");
  const outside = makeTempRoot("willard-nas-outside-");
  try {
    fs.mkdirSync(path.join(root, "WillardAI"));
    fs.symlinkSync(outside, path.join(root, "WillardAI", "temp"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => getTempDir(root, "org-123"), /symlink/);
    assert.equal(fs.existsSync(path.join(outside, "org-123")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("getTempDir keeps empty and dot-segment job IDs inside unique temp children", () => {
  const root = makeTempRoot("willard-nas-root-");
  try {
    const tempParent = path.join(root, "WillardAI", "temp");
    const invalidIds = ["", ".", ".."];
    const paths = invalidIds.map((jobId) => getTempDir(root, jobId));
    for (const tempDir of paths) {
      assert.equal(path.dirname(tempDir), tempParent);
      assert.ok(fs.statSync(tempDir).isDirectory());
    }
    assert.equal(new Set(paths).size, invalidIds.length);
    assert.equal(fs.existsSync(path.join(root, "WillardAI", "default")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("getTempDir rejects an existing job-directory symlink", () => {
  const root = makeTempRoot("willard-nas-root-");
  const outside = makeTempRoot("willard-nas-outside-");
  try {
    fs.mkdirSync(path.join(root, "WillardAI", "temp"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, "WillardAI", "temp", "org-123"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => getTempDir(root, "org-123"), /symlink/);
    assert.equal(fs.readdirSync(outside).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("getTempDir rejects an in-root job symlink without touching another job", () => {
  const root = makeTempRoot("willard-nas-root-");
  try {
    const tempRoot = path.join(root, "WillardAI", "temp");
    const otherJob = path.join(tempRoot, "org-456");
    fs.mkdirSync(otherJob, { recursive: true });
    fs.writeFileSync(path.join(otherJob, "keep.txt"), "other job data");
    fs.symlinkSync(otherJob, path.join(tempRoot, "org-123"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => getTempDir(root, "org-123"), /symlink/);
    assert.equal(fs.readFileSync(path.join(otherJob, "keep.txt"), "utf8"), "other job data");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
