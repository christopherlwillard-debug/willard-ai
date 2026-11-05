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
  moveFileNoReplace,
  walkDirectoryFiles,
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

test("moveFileNoReplace: refuses to overwrite a destination created concurrently", () => {
  const src = writeFile(path.join(mkTmp("mv-noreplace-src"), "photo.jpg"), "original media");
  const dest = writeFile(path.join(mkTmp("mv-noreplace-dst"), "photo.jpg"), "new independent file");
  assert.throws(() => moveFileNoReplace(src, dest), /EEXIST/);
  assert.equal(fs.readFileSync(src, "utf8"), "original media");
  assert.equal(fs.readFileSync(dest, "utf8"), "new independent file");
});

test("moveFileNoReplace: moves when destination is absent", () => {
  const src = writeFile(path.join(mkTmp("mv-noreplace-ok-src"), "photo.jpg"), "restored media");
  const dest = path.join(mkTmp("mv-noreplace-ok-dst"), "photo.jpg");
  moveFileNoReplace(src, dest);
  assert.equal(fs.existsSync(src), false);
  assert.equal(fs.readFileSync(dest, "utf8"), "restored media");
});

test("walkDirectoryFiles: returns nested regular files with root-relative paths", () => {
  const root = mkTmp("walk-regular");
  writeFile(path.join(root, "nested", "photo.jpg"), "image-bytes");
  const files = walkDirectoryFiles(root);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.relativePath, path.join("nested", "photo.jpg"));
  assert.equal(files[0]?.sizeBytes, 11);
});

test("walkDirectoryFiles: rejects a missing or non-directory source", () => {
  assert.throws(() => walkDirectoryFiles(path.join(tmpRoot, "walk-missing")), /Unable to inspect source directory/);
  const file = writeFile(path.join(mkTmp("walk-not-dir"), "file.txt"), "x");
  assert.throws(() => walkDirectoryFiles(file), /not a regular directory/);
});

test("walkDirectoryFiles: rejects symlinks instead of silently omitting them", (t) => {
  const root = mkTmp("walk-symlink");
  const outside = writeFile(path.join(mkTmp("walk-symlink-target"), "outside.txt"), "outside");
  try {
    fs.symlinkSync(outside, path.join(root, "linked.txt"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      t.skip("symlink creation is not permitted on this runner");
      return;
    }
    throw error;
  }
  assert.throws(() => walkDirectoryFiles(root), /Symbolic links are not supported/);
});

test("walkDirectoryFiles: surfaces unreadable nested directories instead of returning a partial scan", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX directory permissions are required for this regression");
    return;
  }
  const root = mkTmp("walk-unreadable");
  writeFile(path.join(root, "visible.txt"), "visible");
  const blocked = path.join(root, "blocked");
  fs.mkdirSync(blocked);
  fs.chmodSync(blocked, 0);

  try {
    try {
      fs.readdirSync(blocked);
      t.skip("runner can read a mode-000 directory");
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EACCES" && code !== "EPERM") throw error;
    }
    assert.throws(() => walkDirectoryFiles(root), /Unable to read source directory/);
  } finally {
    fs.chmodSync(blocked, 0o700);
  }
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

test("verifiedMove: restores a failed hash-mismatch move to staging", async () => {
  const src  = writeFile(path.join(mkTmp("vm-mismatch-src"), "data.bin"), randomBytes(128));
  const dest = path.join(mkTmp("vm-mismatch-dst"), "data.bin");

  await assert.rejects(
    () => verifiedMove(src, dest, {
      afterMoveHook: (to) => {
        // Corrupt destination after the move but before the post-hash runs.
        fs.writeFileSync(to, randomBytes(128));
      },
    }),
    /SHA-256 mismatch/,
    "verifiedMove must throw when source and destination hashes differ",
  );

  assert.equal(fs.existsSync(src), true, "the failed move must be restored to its source path");
  assert.equal(fs.existsSync(dest), false, "an unverified file must not remain at its final destination");
});

test("verifiedMove: never overwrites a destination created after conflict checking", async () => {
  const src = writeFile(path.join(mkTmp("vm-race-src"), "photo.jpg"), "source media");
  const dest = writeFile(path.join(mkTmp("vm-race-dst"), "photo.jpg"), "independent concurrent file");

  await assert.rejects(() => verifiedMove(src, dest), /EEXIST/);

  assert.equal(fs.readFileSync(src, "utf8"), "source media");
  assert.equal(fs.readFileSync(dest, "utf8"), "independent concurrent file");
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

test("organization execution is claimed atomically before capacity reservation", () => {
  const routePath = new URL("../routes/organize.ts", import.meta.url);
  const source = fs.readFileSync(routePath, "utf8");
  const claimAt = source.indexOf("const [claimedJob] = await db.update(organizationJobsTable)");
  const reserveAt = source.indexOf("capacityReservation = await reserveCapacity", claimAt);
  assert.ok(claimAt >= 0, "execution route must use a conditional database claim");
  assert.ok(reserveAt > claimAt, "the claim must happen before capacity reservation and staging");
  const claimBlock = source.slice(claimAt, reserveAt);
  assert.match(claimBlock, /eq\(organizationJobsTable\.id, id\)/);
  assert.match(claimBlock, /eq\(organizationJobsTable\.nasPath, nasPath\)/);
  assert.match(claimBlock, /eq\(organizationJobsTable\.status, "verified"\)/);
  assert.match(claimBlock, /\.returning\(\{ id: organizationJobsTable\.id \}\)/);
  assert.match(source, /\.set\(\{ status: "verified", error: message, stageUpdatedAt: new Date\(\) \}\)/);
});

test("rollbackMoves: preserves a new file at the original path instead of overwriting it", async () => {
  const originalPath = writeFile(path.join(mkTmp("rb-conflict-src"), "important.txt"), "original moved content");
  const destinationPath = path.join(mkTmp("rb-conflict-dest"), "important.txt");
  const record = await verifiedMove(originalPath, destinationPath);

  writeFile(originalPath, "new independent file");
  const logs: string[] = [];
  const rolledBack = await rollbackMoves([record], message => logs.push(message));

  assert.equal(rolledBack, 0, "a conflicting original path must not be overwritten");
  assert.equal(fs.readFileSync(originalPath, "utf8"), "new independent file");
  assert.equal(fs.readFileSync(destinationPath, "utf8"), "original moved content");
  assert.ok(logs.some(message => message.includes("ROLLBACK_FAIL") && message.includes("EEXIST")));
});

test("organization resume and reset require a stale execution lease", () => {
  const routePath = new URL("../routes/organize.ts", import.meta.url);
  const source = fs.readFileSync(routePath, "utf8");
  assert.match(source, /ORGANIZATION_EXECUTION_LEASE_MS = 5 \* 60 \* 1000/);
  assert.match(source, /ORGANIZATION_EXECUTION_HEARTBEAT_MS = 30 \* 1000/);
  assert.match(source, /startOrganizationJobHeartbeat\(id, nasPath\)/);
  assert.match(source, /lt\(organizationJobsTable\.stageUpdatedAt, staleBefore\)/);

  const resetStart = source.indexOf('router.post("/organize/jobs/:id/reset"');
  const resetEnd = source.indexOf('router.post("/organize/jobs/:id/resume-token"', resetStart);
  const resetRoute = source.slice(resetStart, resetEnd);
  assert.match(resetRoute, /eq\(organizationJobsTable\.status, "failed"\)/);
  assert.match(resetRoute, /lt\(organizationJobsTable\.stageUpdatedAt, staleBefore\)/);
  assert.match(resetRoute, /\.returning\(\{ id: organizationJobsTable\.id \}\)/);

  const rollbackStart = source.indexOf('router.post("/organize/jobs/:id/rollback"');
  const rollbackEnd = source.indexOf('router.post("/organize/jobs/:id/reset"', rollbackStart);
  const rollbackRoute = source.slice(rollbackStart, rollbackEnd);
  assert.match(rollbackRoute, /status: "rolling_back"/);
  assert.match(rollbackRoute, /startOrganizationJobHeartbeat\(id, nasPath, "rolling_back"\)/);
  assert.match(rollbackRoute, /lt\(organizationJobsTable\.stageUpdatedAt, staleBefore\)/);

  const helperSource = fs.readFileSync(new URL("../lib/organize-helpers.ts", import.meta.url), "utf8");
  const rollbackMovesStart = helperSource.indexOf("export async function rollbackMoves");
  const rollbackMovesSource = helperSource.slice(rollbackMovesStart);
  assert.match(rollbackMovesSource, /moveFileNoReplace\(mv\.to, mv\.from\)/);
  assert.doesNotMatch(rollbackMovesSource, /moveFile\(mv\.to, mv\.from\)/);

  const recoveryStart = source.indexOf('router.get("/organize/recovery"');
  const rollbackRouteStart = source.indexOf('router.post("/organize/jobs/:id/rollback"', recoveryStart);
  const recoveryRoute = source.slice(recoveryStart, rollbackRouteStart);
  assert.match(recoveryRoute, /eq\(organizationJobsTable\.nasPath, nasPath\)/);
  assert.match(recoveryRoute, /inArray\(organizationJobsTable\.status, \["executing", "rolling_back"\]\)/);
  assert.match(recoveryRoute, /lt\(organizationJobsTable\.stageUpdatedAt, staleBefore\)/);
});

test("rollbackMoves: repeated recovery recognizes a file already restored", async () => {
  const src = writeFile(path.join(mkTmp("rb-idempotent-src"), "repeat.txt"), "recover once");
  const dest = path.join(mkTmp("rb-idempotent-dest"), "repeat.txt");
  const record = await verifiedMove(src, dest);

  assert.equal(await rollbackMoves([record]), 1);
  const logs: string[] = [];
  assert.equal(await rollbackMoves([record], message => logs.push(message)), 1);
  assert.equal(fs.readFileSync(src, "utf8"), "recover once");
  assert.ok(logs.some(message => message.includes("ROLLBACK_ALREADY_RESTORED")));
});

test("rollbackMoves: completes an interrupted same-volume hard-link restore", async () => {
  const src = writeFile(path.join(mkTmp("rb-hardlink-src"), "linked.txt"), "hardlink recovery");
  const dest = path.join(mkTmp("rb-hardlink-dest"), "linked.txt");
  const record = await verifiedMove(src, dest);

  fs.linkSync(dest, src); // simulate a crash after link creation but before unlinking the destination
  const logs: string[] = [];
  const rolledBack = await rollbackMoves([record], message => logs.push(message));

  assert.equal(rolledBack, 1);
  assert.equal(fs.readFileSync(src, "utf8"), "hardlink recovery");
  assert.equal(fs.existsSync(dest), false);
  assert.ok(logs.some(message => message.includes("hard-link finalized")));
});

test("processed archive dispositions never overwrite an existing archive", () => {
  const routeSource = fs.readFileSync(new URL("../routes/organize.ts", import.meta.url), "utf8");
  const noReplaceMoves = routeSource.match(/moveFileNoReplace\(job\.sourcePath,\s*dest\)/g) ?? [];
  assert.equal(noReplaceMoves.length, 2, "both automatic and manual dispositions must use no-replace moves");
  assert.doesNotMatch(routeSource, /moveFile\(job\.sourcePath,\s*dest\)/);
});


test("rollbackMoves: does not count or restore a destination whose bytes changed after the forward move", async () => {
  const sourcePath = writeFile(path.join(mkTmp("rb-tampered-src"), "important.bin"), "original verified bytes");
  const destinationPath = path.join(mkTmp("rb-tampered-dest"), "important.bin");
  const record = await verifiedMove(sourcePath, destinationPath);

  fs.writeFileSync(destinationPath, "tampered destination bytes");
  const logs: string[] = [];
  const rolledBack = await rollbackMoves([record], message => logs.push(message));

  assert.equal(rolledBack, 0, "a checksum-mismatched file is not a successful rollback");
  assert.equal(fs.existsSync(sourcePath), false, "the unverified file must not be written over the source path");
  assert.equal(fs.readFileSync(destinationPath, "utf8"), "tampered destination bytes", "the only remaining copy must be preserved");
  assert.ok(logs.some(message => message.includes("ROLLBACK_VERIFY_FAIL") && message.includes("destination preserved")));
});


test("organization execute does not claim success when rollback is incomplete", () => {
  const routePath = new URL("../routes/organize.ts", import.meta.url);
  const source = fs.readFileSync(routePath, "utf8");
  assert.ok(source.includes("const rollbackComplete = rolledBack === fileMoves.length"));
  assert.ok(source.includes('status: rollbackComplete ? "rolled_back" : "failed"'));
  assert.ok(source.includes("Rollback incomplete:"));
  assert.ok(source.includes("File-move recovery checkpoint failed:"));
});


test("organization resume retains its journal when rollback is incomplete", () => {
  const routePath = new URL("../routes/organize.ts", import.meta.url);
  const source = fs.readFileSync(routePath, "utf8");
  assert.ok(source.includes("const resumeRollbackComplete = rolledBack === newMoves.length"));
  assert.ok(source.includes("const retainedMoves = resumeRollbackComplete ? existingMoves : [...existingMoves, ...newMoves]"));
  assert.ok(source.includes("Resume file-move recovery checkpoint failed:"));
  assert.ok(source.includes("the full move journal was retained for manual recovery"));
});


test("organization completion re-hashes destination files in execute and resume", () => {
  const routePath = new URL("../routes/organize.ts", import.meta.url);
  const source = fs.readFileSync(routePath, "utf8");
  const hashReads = source.match(/const actualHash = await sha256File\(mv\.to\)/g) ?? [];
  assert.equal(hashReads.length, 2, "both execute and resume completion paths must hash destinations");
  assert.equal((source.match(/actualHash !== mv\.sourceHash/g) ?? []).length, 2);
  assert.ok(source.includes("missing or checksum-mismatched at destination"));
});


test("organization reset refuses to discard a non-empty recovery journal", () => {
  const routePath = new URL("../routes/organize.ts", import.meta.url);
  const source = fs.readFileSync(routePath, "utf8");
  const resetStart = source.indexOf('router.post("/organize/jobs/:id/reset"');
  const resetEnd = source.indexOf('router.post("/organize/jobs/:id/resume-token"', resetStart);
  const resetRoute = source.slice(resetStart, resetEnd);
  assert.match(resetRoute, /job\.fileMoves !== null/);
  assert.match(resetRoute, /Array\.isArray\(job\.fileMoves\) \|\| job\.fileMoves\.length > 0/);
  assert.match(resetRoute, /Resume it or complete rollback in Recovery Center before resetting/);
  assert.match(resetRoute, /isNull\(organizationJobsTable\.fileMoves\)/);
  assert.match(resetRoute, /CASE WHEN jsonb_typeof\(\$\{organizationJobsTable\.fileMoves\}\) = 'array' THEN jsonb_array_length\(\$\{organizationJobsTable\.fileMoves\}\) = 0 ELSE false END/);
});
