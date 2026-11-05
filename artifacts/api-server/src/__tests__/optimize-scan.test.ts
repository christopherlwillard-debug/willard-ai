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
    assert.deepEqual(
      [...(groups.get("jpg")?.paths ?? [])].sort(),
      [path.join(f.root, "one.jpg"), path.join(f.root, "nested", "two.jpg")].sort(),
    );
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

test("optimization scan does not follow symlinks as regular media files", {
  skip: process.platform === "win32",
}, () => {
  const f = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "willard-optimize-link-target-"));
  try {
    const target = path.join(outside, "private.jpg");
    fs.writeFileSync(target, "outside library");
    fs.symlinkSync(target, path.join(f.root, "linked.jpg"));

    const { groups, counter } = scan(f.root);
    assert.equal(counter.total, 0);
    assert.equal(groups.has("jpg"), false);
  } finally {
    f.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
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
