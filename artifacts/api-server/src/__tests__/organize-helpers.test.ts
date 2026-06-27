/**
 * Integration tests for organize-helpers.ts
 *
 * Runs with Node.js built-in test runner (no extra deps required):
 *   node --experimental-strip-types --test src/__tests__/organize-helpers.test.ts
 *
 * Tests cover:
 *   1.  sha256File — determinism and content sensitivity
 *   2.  sha256Buffer — determinism and content sensitivity
 *   3.  moveFile — same-device move, deep directory creation
 *   4.  verifiedMove — happy path with hash comparison
 *   5.  verifiedMove — throws on hash mismatch (via afterMoveHook corruption)
 *   6.  verifiedMove — throws when source file is unreadable
 *   7.  rollbackMoves — restores exactly 1 file after early failure
 *   8.  rollbackMoves — restores exactly N files after mid-batch failure
 *   9.  rollbackMoves — verifies restored checksums match originals
 *   10. rollbackMoves — tolerates missing destination (already cleaned up)
 *   11. rollbackMoves — restore ordering is LIFO
 */

import { test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

import {
  sha256File,
  sha256Buffer,
  moveFile,
  verifiedMove,
  rollbackMoves,
  type FileMoveRecord,
} from "../lib/organize-helpers.ts";

// ── Fixture helpers ───────────────────────────────────────────────────────────

let tmpRoot: string;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "willard-test-"));
});

after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function mkTmp(...parts: string[]): string {
  const p = path.join(tmpRoot, ...parts);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function writeFile(filePath: string, content: string | Buffer): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function randomBytes(n = 512): Buffer {
  return crypto.randomBytes(n);
}

// ── 1. sha256File ─────────────────────────────────────────────────────────────

test("sha256File: returns deterministic 64-char hex digest", async () => {
  const src = writeFile(path.join(mkTmp("sha256-det"), "f.txt"), "hello world");
  const h1 = await sha256File(src);
  const h2 = await sha256File(src);
  assert.equal(h1.length, 64);
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test("sha256File: different content produces different digest", async () => {
  const dir = mkTmp("sha256-diff");
  const a = writeFile(path.join(dir, "a.bin"), randomBytes());
  const b = writeFile(path.join(dir, "b.bin"), randomBytes());
  assert.notEqual(await sha256File(a), await sha256File(b));
});

test("sha256File: throws for a missing file", async () => {
  await assert.rejects(
    () => sha256File("/nonexistent/path/file.bin"),
    /ENOENT/,
  );
});

// ── 2. sha256Buffer ───────────────────────────────────────────────────────────

test("sha256Buffer: consistent with sha256File for same content", async () => {
  const content = randomBytes(256);
  const src = writeFile(path.join(mkTmp("sha256-buf"), "x.bin"), content);
  const fromBuf  = sha256Buffer(content);
  const fromFile = await sha256File(src);
  assert.equal(fromBuf, fromFile, "buffer hash must equal file hash for same bytes");
});

test("sha256Buffer: different buffers produce different hashes", () => {
  assert.notEqual(sha256Buffer(randomBytes()), sha256Buffer(randomBytes()));
});

// ── 3. moveFile ───────────────────────────────────────────────────────────────

test("moveFile: moves file and removes source", () => {
  const src  = writeFile(path.join(mkTmp("mv-src"), "file.txt"), "payload");
  const dest = path.join(mkTmp("mv-dst"), "file.txt");
  moveFile(src, dest);
  assert.ok(fs.existsSync(dest));
  assert.ok(!fs.existsSync(src));
  assert.equal(fs.readFileSync(dest, "utf-8"), "payload");
});

test("moveFile: creates deep intermediate directories", () => {
  const src  = writeFile(path.join(mkTmp("mv-mkd-src"), "f.txt"), "abc");
  const dest = path.join(tmpRoot, "mv-mkd-dst", "a", "b", "c", "f.txt");
  moveFile(src, dest);
  assert.ok(fs.existsSync(dest));
});

// ── 4. verifiedMove — happy path ──────────────────────────────────────────────

test("verifiedMove: returns verified FileMoveRecord on success", async () => {
  const content = randomBytes(256);
  const src  = writeFile(path.join(mkTmp("vm-ok-src"), "data.bin"), content);
  const dest = path.join(mkTmp("vm-ok-dst"), "data.bin");

  const rec = await verifiedMove(src, dest);

  assert.ok(!fs.existsSync(src),  "source must be gone");
  assert.ok(fs.existsSync(dest),  "dest must exist");
  assert.equal(rec.from, src);
  assert.equal(rec.to,   dest);
  assert.equal(rec.sourceHash, rec.destHash);
  assert.ok(rec.verified, "verified must be true");
  assert.match(rec.sourceHash, /^[0-9a-f]{64}$/);
});

test("verifiedMove: source hash equals sha256 of original content", async () => {
  const content = randomBytes(128);
  const expectedHash = sha256Buffer(content);
  const src  = writeFile(path.join(mkTmp("vm-hash-src"), "f.bin"), content);
  const dest = path.join(mkTmp("vm-hash-dst"), "f.bin");

  const rec = await verifiedMove(src, dest);
  assert.equal(rec.sourceHash, expectedHash);
  assert.equal(rec.destHash,   expectedHash);
});

// ── 5. verifiedMove — mismatch detection (real throw) ────────────────────────

test("verifiedMove: throws on destination hash mismatch (afterMoveHook corruption)", async () => {
  const src  = writeFile(path.join(mkTmp("vm-mismatch-src"), "data.bin"), randomBytes(128));
  const dest = path.join(mkTmp("vm-mismatch-dst"), "data.bin");

  await assert.rejects(
    () => verifiedMove(src, dest, {
      afterMoveHook: (to) => {
        // Corrupt destination after the move but before the post-hash runs
        fs.writeFileSync(to, randomBytes(128));
      },
    }),
    /SHA-256 mismatch/,
    "verifiedMove must throw when source and destination hashes differ",
  );
});

// ── 6. verifiedMove — unreadable source ──────────────────────────────────────

test("verifiedMove: throws when source file does not exist", async () => {
  await assert.rejects(
    () => verifiedMove(
      path.join(tmpRoot, "nonexistent-src", "x.bin"),
      path.join(tmpRoot, "nonexistent-dst", "x.bin"),
    ),
    /ENOENT/,
  );
});

// ── 7. rollbackMoves — 1 file restored after early failure ────────────────────

test("rollbackMoves: restores 1 file after failure before second move", async () => {
  const srcDir  = mkTmp("rb1-src");
  const destDir = mkTmp("rb1-dst");

  const files = ["a.txt", "b.txt", "c.txt"].map(n =>
    writeFile(path.join(srcDir, n), `content-${n}-${randomBytes(16).toString("hex")}`)
  );

  // Only file[0] was moved before the simulated failure
  const logs: string[] = [];
  const record0 = await verifiedMove(files[0], path.join(destDir, "a.txt"));
  const rolledBack = await rollbackMoves([record0], msg => logs.push(msg));

  assert.equal(rolledBack, 1);
  assert.ok(fs.existsSync(files[0]),  "original file must be restored");
  assert.ok(!fs.existsSync(path.join(destDir, "a.txt")), "dest must be gone");
  assert.ok(logs.some(l => l.includes("ROLLBACK_VERIFY_OK")));
  // Unmoved files untouched
  assert.ok(fs.existsSync(files[1]));
  assert.ok(fs.existsSync(files[2]));
});

// ── 8. rollbackMoves — mid-batch (3 of 5 moved) ──────────────────────────────

test("rollbackMoves: restores exactly the moved files in a mid-batch failure", async () => {
  const srcDir  = mkTmp("rb-mid-src");
  const destDir = mkTmp("rb-mid-dst");

  const names = ["f0.txt", "f1.txt", "f2.txt", "f3.txt", "f4.txt"];
  const srcFiles = names.map(n =>
    writeFile(path.join(srcDir, n), `payload-${n}-${randomBytes(16).toString("hex")}`)
  );

  const logs: string[] = [];
  const fileMoves: FileMoveRecord[] = [];
  for (let i = 0; i < 3; i++) {
    fileMoves.push(await verifiedMove(srcFiles[i], path.join(destDir, names[i])));
  }

  const rolledBack = await rollbackMoves(fileMoves, msg => logs.push(msg));
  assert.equal(rolledBack, 3, "exactly 3 moves must roll back");

  for (let i = 0; i < 3; i++) {
    assert.ok(fs.existsSync(srcFiles[i]),              `${names[i]} must be restored`);
    assert.ok(!fs.existsSync(path.join(destDir, names[i])), `dest ${names[i]} must be gone`);
  }
  assert.ok(fs.existsSync(srcFiles[3]));
  assert.ok(fs.existsSync(srcFiles[4]));

  const okCount = logs.filter(l => l.includes("ROLLBACK_VERIFY_OK")).length;
  assert.equal(okCount, 3, "3 ROLLBACK_VERIFY_OK entries expected");
});

// ── 9. rollbackMoves — restored checksums match originals ─────────────────────

test("rollbackMoves: restored file has the exact original SHA-256", async () => {
  const content = randomBytes(1024);
  const originalHash = sha256Buffer(content);
  const src  = writeFile(path.join(mkTmp("rb-chk-src"), "important.bin"), content);
  const dest = path.join(mkTmp("rb-chk-dst"), "important.bin");

  const record = await verifiedMove(src, dest);
  assert.ok(record.verified);

  await rollbackMoves([record]);

  const restoredHash = await sha256File(src);
  assert.equal(restoredHash, originalHash, "restored file must have original hash");
});

// ── 10. rollbackMoves — missing destination tolerated ─────────────────────────

test("rollbackMoves: skips entry when destination is already gone", async () => {
  const src    = writeFile(path.join(mkTmp("rb-miss-src"), "g.txt"), "gone");
  const record = await verifiedMove(src, path.join(mkTmp("rb-miss-dst"), "g.txt"));

  fs.unlinkSync(record.to); // destination already cleaned up

  const logs: string[] = [];
  const count = await rollbackMoves([record], msg => logs.push(msg));

  assert.equal(count, 0, "nothing rolled back when dest is gone");
  assert.ok(logs.some(l => l.includes("ROLLBACK_SKIP")));
});

// ── 11. rollbackMoves — LIFO ordering ────────────────────────────────────────

test("rollbackMoves: restores files in last-in-first-out order", async () => {
  const srcDir  = mkTmp("rb-lifo-src");
  const destDir = mkTmp("rb-lifo-dst");

  const names = ["first.txt", "second.txt", "third.txt"];
  const srcs = names.map((n, i) =>
    writeFile(path.join(srcDir, n), `order=${i}`)
  );

  const fileMoves: FileMoveRecord[] = [];
  for (let i = 0; i < names.length; i++) {
    fileMoves.push(await verifiedMove(srcs[i], path.join(destDir, names[i])));
  }

  const restoredOrder: string[] = [];
  await rollbackMoves(fileMoves, msg => {
    // Log format: "ROLLBACK_VERIFY_OK: third.txt hash=…"
    const m = msg.match(/ROLLBACK_VERIFY_OK: (\S+)/);
    if (m) restoredOrder.push(m[1]);
  });

  // LIFO: third restored first, first restored last
  assert.equal(restoredOrder[0], "third.txt",  "third should be restored first (LIFO)");
  assert.equal(restoredOrder[1], "second.txt");
  assert.equal(restoredOrder[2], "first.txt",  "first should be restored last (LIFO)");
});
