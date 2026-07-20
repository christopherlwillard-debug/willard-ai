/**
 * Regression tests for checkNasReachable() in lib/nas-storage.ts
 *
 * Runs with Node.js built-in test runner (no extra deps required):
 *   node --experimental-strip-types --test src/__tests__/nas-reachability.test.ts
 *
 * Guarantees:
 *  1. A server on Linux NEVER reports Windows-style paths (Z:\, \\server\share) as
 *     online. Before the platform gate, path.resolve("Z:") produced a local relative
 *     folder that could exist and falsely return online=true.
 *  2. A server on Windows MUST allow Windows drive letters and UNC paths through to
 *     the normal fs checks — NOT reject them at the platform-gate. Without this, any
 *     mapped drive (e.g. Z:\) is permanently reported offline regardless of
 *     whether it is actually mounted.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkNasReachable } from "../lib/nas-storage.ts";

const onPosix = process.platform !== "win32";

// ── Platform-spoof helpers ────────────────────────────────────────────────────
// Temporarily override process.platform so the function-under-test believes it
// is running on a different OS. The check in checkNasReachable reads
// `process.platform` at call time, so this is safe to patch and restore.
function spoofPlatform(value: string): () => void {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value, configurable: true });
  return () => Object.defineProperty(process, "platform", original);
}

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

// ── Windows platform gate — must ALLOW drive letters through to fs checks ────
//
// These tests spoof process.platform = "win32" so checkNasReachable believes it
// is running on a Windows host. The drive letters and UNC paths used here don't
// actually exist on this Linux test runner, so the fs-level check will return
// offline ("Library not found") — but crucially NOT the platform-gate rejection
// ("Windows drive letters are not reachable from this server").
//
// This is the core regression guard: on a real Windows machine, the function
// must reach the fs checks so that an accessible Z:\ returns online=true.
// If the platform gate fires, no mounted drive can ever be seen as online.

test("on win32: drive letter passes the platform gate (not rejected before fs check)", () => {
  const restore = spoofPlatform("win32");
  try {
    const r = checkNasReachable("Z:\\");
    assert.ok(
      !/drive letter/i.test(r.message),
      `Platform gate must not fire on win32 — got: "${r.message}"`,
    );
    assert.ok(
      !/not reachable from this server/i.test(r.message),
      `OS-rejection message must not appear on win32 — got: "${r.message}"`,
    );
  } finally {
    restore();
  }
});

test("on win32: drive letter with subfolder passes the platform gate", () => {
  const restore = spoofPlatform("win32");
  try {
    const r = checkNasReachable("Z:\\Media\\Photos");
    assert.ok(!/drive letter/i.test(r.message), `Got: "${r.message}"`);
    assert.ok(!/not reachable from this server/i.test(r.message), `Got: "${r.message}"`);
  } finally {
    restore();
  }
});

test("on win32: UNC share passes the platform gate (not rejected before fs check)", () => {
  const restore = spoofPlatform("win32");
  try {
    const r = checkNasReachable("\\\\192.168.1.100\\nas");
    assert.ok(
      !/network share/i.test(r.message),
      `Platform gate must not fire on win32 — got: "${r.message}"`,
    );
    assert.ok(!/not reachable from this server/i.test(r.message), `Got: "${r.message}"`);
  } finally {
    restore();
  }
});

test("on win32: accessible local dir is online (platform gate allows POSIX paths too)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "willard-win32-"));
  fs.writeFileSync(path.join(dir, "test.txt"), "hello");
  const restore = spoofPlatform("win32");
  try {
    const r = checkNasReachable(dir);
    assert.equal(r.online, true, "A real accessible directory must still be reported online when platform=win32");
    assert.equal(r.isDirectory, true);
    assert.equal(r.readable, true);
  } finally {
    restore();
    try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
  }
});
