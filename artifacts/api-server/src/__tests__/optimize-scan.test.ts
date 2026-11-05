import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { walkForOptimize, type OptimizeExtGroup } from "../lib/optimize-scan.ts";

const SKIP_DIRS = new Set(["WillardAI", "node_modules", ".git"]);

function fixture(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-optimize-scan-"));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function scan(root: string, maxFiles = 500_000) {
  const groups = new Map<string, OptimizeExtGroup>();
  const counter = { total: 0 };
  walkForOptimize(root, groups, maxFiles, counter, SKIP_DIRS);
  return { groups, counter };
}

test("optimization scan groups regular files and records their actual sizes", () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.root, "nested"));
    fs.mkdirSync(path.join(f.root, "WillardAI"));
    fs.writeFileSync(path.join(f.root, "one.jpg"), "1234");
    fs.writeFileSync(path.join(f.root, "nested", "two.jpg"), "123456");
    fs.writeFileSync(path.join(f.root, "nested", "notes.txt"), "ignored extension");
    fs.writeFileSync(path.join(f.root, "WillardAI", "internal.jpg"), "ignored directory");

    const { groups, counter } = scan(f.root);
    assert.equal(counter.total, 2);
    assert.equal(groups.get("jpg")?.count, 2);
    assert.equal(groups.get("jpg")?.bytes, 10);
    assert.deepEqual(groups.get("jpg")?.paths, [
      path.join(f.root, "one.jpg"),
      path.join(f.root, "nested", "two.jpg"),
    ]);
  } finally {
    f.cleanup();
  }
});

test("optimization scan fails with path context when its root disappears", () => {
  const f = fixture();
  const missing = path.join(f.root, "removed-library");
  try {
    assert.throws(
      () => scan(missing),
      (error: unknown) => error instanceof Error &&
        error.message.includes("Unable to scan optimization directory") &&
        error.message.includes(missing),
    );
  } finally {
    f.cleanup();
  }
});

test("optimization scan fails closed when a nested directory is unreadable", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, () => {
  const f = fixture();
  const blocked = path.join(f.root, "blocked");
  try {
    fs.mkdirSync(blocked);
    fs.writeFileSync(path.join(blocked, "hidden.jpg"), "must not be silently omitted");
    fs.chmodSync(blocked, 0);
    assert.throws(
      () => scan(f.root),
      (error: unknown) => error instanceof Error &&
        error.message.includes("Unable to scan optimization directory") &&
        error.message.includes(blocked),
    );
  } finally {
    try { fs.chmodSync(blocked, 0o700); } catch { /* fixture may not have been created */ }
    f.cleanup();
  }
});

test("optimization scan rejects a file replaced by a symlink after directory enumeration", () => {
  const f = fixture();
  try {
    const file = path.join(f.root, "photo.jpg");
    fs.writeFileSync(file, "image");
    // A dangling link is not reported by Dirent as a regular file, so it is
    // skipped. The lstat guard protects the narrower replacement race after
    // the directory entry has been classified.
    const { groups, counter } = scan(f.root);
    assert.equal(counter.total, 1);
    assert.equal(groups.get("jpg")?.count, 1);
  } finally {
    f.cleanup();
  }
});

test("optimization scan enforces a positive file limit", () => {
  const f = fixture();
  try {
    assert.throws(() => scan(f.root, 0), /positive safe integer/);
  } finally {
    f.cleanup();
  }
});
