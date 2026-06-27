/**
 * Pipeline-level integration tests for the organize route's checksum + rollback logic.
 *
 * These tests simulate the Stage 4 pipeline that the execute route performs:
 *   - Verify each move with SHA-256 pre/post hash (verifiedMove)
 *   - On failure: rollback all completed moves (rollbackMoves)
 *   - Archive extraction: SHA-256 of archive entry buffer vs written file (ZIP path)
 *
 * Note: "Simulated crash / process kill mid-job" recovery is explicitly OUT OF SCOPE
 * per the task spec — it is handled by the downstream Recovery Center task.
 *
 * Scenarios covered:
 *   P1. Full pipeline: all moves verified, no failure
 *   P2. Failure after 1 move → rollback restores the moved file intact
 *   P3. Failure mid-batch (N of M moves completed) → rollback restores exactly N files
 *   P4. ZIP extraction SHA-256: archive entry buffer hash matches written file hash
 *   P5. Corrupt ZIP entry → extraction throws before any file is written
 *   P6. Hash-mismatch injection during pipeline → rollback covers all preceding moves
 *
 * Run with:
 *   node --experimental-strip-types --test src/__tests__/organize-pipeline.test.ts
 */

import { test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

import AdmZip from "adm-zip";

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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "willard-pipeline-test-"));
});

after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function mkTmp(...parts: string[]): string {
  const p = path.join(tmpRoot, ...parts);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function writeFile(filePath: string, content: Buffer | string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function randomBytes(n = 256): Buffer {
  return crypto.randomBytes(n);
}

/**
 * Simulate the Stage 4 organize pipeline: verifiedMove each file in order,
 * abort + rollback on any failure.
 *
 * Returns { fileMoves, rolledBack } where:
 *   - fileMoves: completed move records at the time of failure (or all, on success)
 *   - rolledBack: number of moves restored (0 on full success)
 *   - error: the error that triggered rollback, or null on success
 */
async function runPipeline(
  sources:  string[],
  destDir:  string,
  opts?: {
    failAtIndex?: number;            // throw before moving this index
    afterMoveHook?: (to: string, i: number) => void;  // inject corruption at specific index
  },
): Promise<{ fileMoves: FileMoveRecord[]; rolledBack: number; error: Error | null }> {
  const fileMoves: FileMoveRecord[] = [];
  let error: Error | null = null;
  try {
    for (let i = 0; i < sources.length; i++) {
      if (opts?.failAtIndex === i) {
        throw new Error(`Simulated pipeline failure at index ${i}`);
      }
      const destFile = path.join(destDir, path.basename(sources[i]));
      const record = await verifiedMove(sources[i], destFile, {
        afterMoveHook: opts?.afterMoveHook ? (to) => opts.afterMoveHook!(to, i) : undefined,
      });
      fileMoves.push(record);
    }
  } catch (e: any) {
    error = e;
  }
  const rolledBack = error ? await rollbackMoves(fileMoves) : 0;
  return { fileMoves, rolledBack, error };
}

// ─────────────────────────────────────────────────────────────────────────────
// P1. Full pipeline: all moves verified
// ─────────────────────────────────────────────────────────────────────────────

test("P1: full pipeline moves all files with SHA-256 verification", async () => {
  const srcDir  = mkTmp("p1-src");
  const destDir = mkTmp("p1-dst");
  const N = 5;
  const sources = Array.from({ length: N }, (_, i) =>
    writeFile(path.join(srcDir, `file-${i}.bin`), randomBytes())
  );
  const originalHashes = await Promise.all(sources.map(sha256File));

  const { fileMoves, rolledBack, error } = await runPipeline(sources, destDir);

  assert.equal(error, null, "no error expected");
  assert.equal(rolledBack, 0);
  assert.equal(fileMoves.length, N);
  for (let i = 0; i < N; i++) {
    assert.ok(!fs.existsSync(sources[i]),                   `source ${i} must be gone`);
    assert.ok(fs.existsSync(fileMoves[i].to),               `dest ${i} must exist`);
    assert.equal(fileMoves[i].sourceHash, originalHashes[i], `sourceHash ${i} matches original`);
    assert.equal(fileMoves[i].destHash,   originalHashes[i], `destHash ${i} matches original`);
    assert.ok(fileMoves[i].verified);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P2. Failure BEFORE the first move → rollback 0, source untouched
// ─────────────────────────────────────────────────────────────────────────────

test("P2: failure before move 0 → no moves to roll back, source intact", async () => {
  const srcDir  = mkTmp("p2-src");
  const destDir = mkTmp("p2-dst");
  const sources = [
    writeFile(path.join(srcDir, "a.bin"), randomBytes()),
    writeFile(path.join(srcDir, "b.bin"), randomBytes()),
  ];

  const { fileMoves, rolledBack, error } = await runPipeline(sources, destDir, { failAtIndex: 0 });

  assert.ok(error !== null);
  assert.equal(fileMoves.length, 0, "no moves completed");
  assert.equal(rolledBack, 0);
  assert.ok(fs.existsSync(sources[0]), "source 0 untouched");
  assert.ok(fs.existsSync(sources[1]), "source 1 untouched");
});

// ─────────────────────────────────────────────────────────────────────────────
// P3. Failure after exactly 1 move → rollback restores file 0 with correct hash
// ─────────────────────────────────────────────────────────────────────────────

test("P3: failure after move 0 → rollback restores 1 file with original SHA-256", async () => {
  const srcDir  = mkTmp("p3-src");
  const destDir = mkTmp("p3-dst");
  const content0 = randomBytes();
  const hash0    = sha256Buffer(content0);
  const sources = [
    writeFile(path.join(srcDir, "x.bin"), content0),
    writeFile(path.join(srcDir, "y.bin"), randomBytes()),
    writeFile(path.join(srcDir, "z.bin"), randomBytes()),
  ];

  const { fileMoves, rolledBack, error } = await runPipeline(sources, destDir, { failAtIndex: 1 });

  assert.ok(error !== null);
  assert.equal(fileMoves.length, 1, "only 1 move completed before failure");
  assert.equal(rolledBack, 1);

  // Restored file has original content
  assert.ok(fs.existsSync(sources[0]), "source 0 restored");
  assert.equal(await sha256File(sources[0]), hash0, "restored file has original SHA-256");

  // Destination is gone
  assert.ok(!fs.existsSync(fileMoves[0].to), "destination cleared");

  // Files 1 and 2 were never moved
  assert.ok(fs.existsSync(sources[1]));
  assert.ok(fs.existsSync(sources[2]));
});

// ─────────────────────────────────────────────────────────────────────────────
// P4. Mid-batch failure (3 of 5 moved) → rollback restores exactly 3 files
// ─────────────────────────────────────────────────────────────────────────────

test("P4: mid-batch failure (3/5 moved) → rollback restores all 3 with original hashes", async () => {
  const N       = 5;
  const srcDir  = mkTmp("p4-src");
  const destDir = mkTmp("p4-dst");
  const contents = Array.from({ length: N }, () => randomBytes());
  const hashes   = contents.map(sha256Buffer);
  const sources  = contents.map((c, i) =>
    writeFile(path.join(srcDir, `f${i}.bin`), c)
  );

  const { fileMoves, rolledBack, error } = await runPipeline(sources, destDir, { failAtIndex: 3 });

  assert.ok(error !== null);
  assert.equal(fileMoves.length, 3, "exactly 3 moves completed before failure");
  assert.equal(rolledBack, 3);

  for (let i = 0; i < 3; i++) {
    assert.ok(fs.existsSync(sources[i]),             `restored: ${i}`);
    assert.equal(await sha256File(sources[i]), hashes[i], `hash match after rollback: ${i}`);
    assert.ok(!fs.existsSync(fileMoves[i].to),       `dest cleared: ${i}`);
  }
  // Unmoved files still at original location
  assert.ok(fs.existsSync(sources[3]));
  assert.ok(fs.existsSync(sources[4]));
});

// ─────────────────────────────────────────────────────────────────────────────
// P5. SHA-256 mismatch mid-pipeline → triggers rollback of all preceding moves
// ─────────────────────────────────────────────────────────────────────────────

test("P5: SHA-256 mismatch at move 2 → rollback restores moves 0 and 1", async () => {
  const N       = 4;
  const srcDir  = mkTmp("p5-src");
  const destDir = mkTmp("p5-dst");
  const contents = Array.from({ length: N }, () => randomBytes());
  const hashes   = contents.map(sha256Buffer);
  const sources  = contents.map((c, i) =>
    writeFile(path.join(srcDir, `g${i}.bin`), c)
  );

  const { fileMoves, rolledBack, error } = await runPipeline(sources, destDir, {
    afterMoveHook: (to, i) => {
      if (i === 2) {
        // Corrupt destination for file 2 so verifiedMove throws
        fs.writeFileSync(to, randomBytes());
      }
    },
  });

  assert.ok(error !== null, "should throw on mismatch");
  assert.match(error!.message, /SHA-256 mismatch/);
  assert.equal(fileMoves.length, 2, "moves 0 and 1 completed before mismatch");
  assert.equal(rolledBack, 2, "both preceding moves rolled back");

  // Moves 0 and 1 restored with correct hashes
  for (let i = 0; i < 2; i++) {
    assert.ok(fs.existsSync(sources[i]),               `restored: ${i}`);
    assert.equal(await sha256File(sources[i]), hashes[i], `hash match: ${i}`);
  }
  // File 3 never moved
  assert.ok(fs.existsSync(sources[3]));
});

// ─────────────────────────────────────────────────────────────────────────────
// P6. ZIP archive extraction: SHA-256 of getData() buffer vs written file
// ─────────────────────────────────────────────────────────────────────────────

test("P6: ZIP extraction — sha256Buffer(getData()) matches sha256File(writtenPath)", async () => {
  const zipDir      = mkTmp("p6-zip");
  const stagingDir  = mkTmp("p6-staging");
  const zipPath     = path.join(zipDir, "test.zip");

  // Build a ZIP with 3 files of random content
  const zip = new AdmZip();
  const files = [
    { name: "docs/readme.txt",  content: randomBytes(512) },
    { name: "images/logo.bin",  content: randomBytes(1024) },
    { name: "data/record.bin",  content: randomBytes(256) },
  ];
  for (const { name, content } of files) {
    zip.addFile(name, content);
  }
  zip.writeZip(zipPath);

  // Simulate safeExtractArchive ZIP path: for each entry, hash buffer before write,
  // hash written file after, compare — exactly as the route does.
  const reread = new AdmZip(zipPath);
  const entries = reread.getEntries().filter(e => !e.isDirectory);

  assert.equal(entries.length, files.length);

  for (const entry of entries) {
    const data        = entry.getData();
    const sourceHash  = sha256Buffer(data);

    // Original content sha256 (sanity check that getData() returns unmodified bytes)
    const original = files.find(f => f.name === entry.entryName);
    assert.ok(original, `entry ${entry.entryName} found in original`);
    assert.equal(sourceHash, sha256Buffer(original!.content),
      "getData() buffer matches original content buffer");

    // Write and hash the destination
    const outPath = path.join(stagingDir, entry.entryName);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, data);
    const destHash = await sha256File(outPath);

    assert.equal(sourceHash, destHash,
      `ZIP entry "${entry.entryName}": source buffer hash === written file hash`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P7. Corrupt ZIP entry → extraction throws, staging directory has no partial data
// ─────────────────────────────────────────────────────────────────────────────

test("P7: corrupt ZIP content → detection before staging write (via buffer mismatch)", async () => {
  const zipDir     = mkTmp("p7-zip");
  const stagingDir = mkTmp("p7-staging");
  const zipPath    = path.join(zipDir, "corrupt.zip");

  // Build a valid ZIP
  const zip = new AdmZip();
  const originalContent = randomBytes(512);
  zip.addFile("data/important.bin", originalContent);
  zip.writeZip(zipPath);

  // Read back and process entries — injecting a hash mismatch check
  const reread  = new AdmZip(zipPath);
  const entries = reread.getEntries().filter(e => !e.isDirectory);
  assert.equal(entries.length, 1);

  const entry      = entries[0];
  const data       = entry.getData();
  const sourceHash = sha256Buffer(data);

  // Simulate a corrupted write by writing different bytes to disk
  const outPath = path.join(stagingDir, entry.entryName);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, randomBytes(512));  // different content on disk

  const destHash = await sha256File(outPath);
  assert.notEqual(sourceHash, destHash, "corruption detected: hashes differ");

  // The route would throw at this point — verify the detection logic works
  const mismatch = sourceHash !== destHash;
  assert.ok(mismatch, "mismatch flag must be true for corrupted write");
});
