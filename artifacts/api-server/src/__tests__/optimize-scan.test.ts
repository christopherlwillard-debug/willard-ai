import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { walkForOptimize, type OptimizeExtGroup } from "../lib/optimize-scan.ts";

const SKIP_DIRS = new Set(["WillardAI", "node_modules", ".git"]);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../");
const optimizeRouteSource = fs.readFileSync(path.join(repoRoot, "artifacts/api-server/src/routes/optimize.ts"), "utf8");
const optimizePageSource = fs.readFileSync(path.join(repoRoot, "artifacts/willard-ai/src/pages/optimize.tsx"), "utf8");

function fixture(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-optimize-scan-"));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function scan(root: string, maxFiles = 500_000) {
  const groups = new Map<string, OptimizeExtGroup>();
  const counter = { total: 0, limitReached: false };
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
    assert.equal(counter.total, 3, "all files with a recognized extension are included in the scan total");
    assert.equal(groups.get("jpg")?.count, 2);
    assert.equal(groups.get("jpg")?.bytes, 10);
    assert.equal(groups.get("txt")?.count, 1);
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

test("optimization scan marks the safety limit when it reaches the configured maximum", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, "one.jpg"), "1");
    fs.writeFileSync(path.join(f.root, "two.jpg"), "22");
    fs.writeFileSync(path.join(f.root, "three.jpg"), "333");

    const { groups, counter } = scan(f.root, 2);
    assert.equal(counter.total, 2);
    assert.equal(counter.limitReached, true);
    assert.equal(groups.get("jpg")?.count, 2);
  } finally {
    f.cleanup();
  }
});

test("optimization scan leaves the safety-limit flag clear below the configured maximum", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, "one.jpg"), "1");
    fs.writeFileSync(path.join(f.root, "two.jpg"), "22");

    const { counter } = scan(f.root, 3);
    assert.equal(counter.total, 2);
    assert.equal(counter.limitReached, false);
  } finally {
    f.cleanup();
  }
});

test("scan-limit state is cached, returned by the API, and warned about in Optimize Center", () => {
  assert.match(optimizeRouteSource, /const CACHE_VERSION\s*=\s*8/);
  assert.match(optimizeRouteSource, /scanLimitReached:\s*counter\.limitReached/);
  assert.match(optimizeRouteSource, /scanLimit:\s*OPTIMIZE_SCAN_MAX_FILES/);
  assert.match(optimizePageSource, /scanLimitReached\?:\s*boolean/);
  assert.match(optimizePageSource, /scanResult\.scanLimitReached/);
  assert.match(optimizePageSource, /Scan limit reached/);
  assert.match(optimizePageSource, /Videos outside the scan window are safely skipped during conversion/);
});
