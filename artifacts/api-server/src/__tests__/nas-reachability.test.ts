/**
 * Regression tests for checkNasReachable() in lib/nas-storage.ts
 *
 * Runs with Node.js built-in test runner (no extra deps required):
 *   node --experimental-strip-types --test src/__tests__/nas-reachability.test.ts
 *
 * The central guarantee: a server running on Linux must NEVER report a
 * Windows-style location (e.g. "Z:") as online. Before the fix, path.resolve("Z:")
 * produced a local relative folder that could exist and falsely report "online".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkNasReachable } from "../lib/nas-storage.ts";

const onPosix = process.platform !== "win32";

test("bare Windows drive letter is offline on non-Windows", { skip: !onPosix }, () => {
  const r = checkNasReachable("Z:");
  assert.equal(r.online, false);
  assert.match(r.message, /drive letter/i);
});

test("Windows drive path with subfolders is offline on non-Windows", { skip: !onPosix }, () => {
  const r = checkNasReachable("Z:\\Media\\Photos");
  assert.equal(r.online, false);
  assert.match(r.message, /drive letter/i);
});

test("UNC network share is offline on non-Windows", { skip: !onPosix }, () => {
  const r = checkNasReachable("\\\\nas\\share");
  assert.equal(r.online, false);
  assert.match(r.message, /network share/i);
});

test("relative path is offline on non-Windows", { skip: !onPosix }, () => {
  const r = checkNasReachable("some/relative/dir");
  assert.equal(r.online, false);
  assert.match(r.message, /absolute path/i);
});

test("null / empty / whitespace is offline", () => {
  for (const p of [null, undefined, "", "   "]) {
    const r = checkNasReachable(p);
    assert.equal(r.online, false);
    assert.match(r.message, /No library location configured/i);
  }
});

test("nonexistent absolute path is offline", () => {
  const r = checkNasReachable(path.join(os.tmpdir(), "willard-does-not-exist-xyz"));
  assert.equal(r.online, false);
  assert.equal(r.exists, false);
});

test("a file (not a directory) is offline", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "willard-")), "file.txt");
  fs.writeFileSync(f, "hi");
  const r = checkNasReachable(f);
  assert.equal(r.online, false);
  assert.equal(r.isDirectory, false);
});

test("a readable absolute directory is online", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "willard-ok-"));
  fs.writeFileSync(path.join(dir, "a.txt"), "hi");
  const r = checkNasReachable(dir);
  assert.equal(r.online, true);
  assert.equal(r.isDirectory, true);
  assert.equal(r.readable, true);
});
