/**
 * Core file-move helpers shared between the organize route and its test suite.
 * All functions are pure filesystem operations — no DB, no Express dependencies.
 *
 * Integrity policy:
 *   Every file move computes SHA-256 of the source BEFORE moving and the
 *   destination AFTER moving.  If the hashes differ, `verifiedMove` throws
 *   immediately — the caller must roll back all completed moves.
 *   Hash computation failures (unreadable file, I/O error) are also fatal:
 *   an empty token means we cannot verify integrity and is treated as an error.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// ── SHA-256 ──────────────────────────────────────────────────────────────────

/**
 * Streaming SHA-256 — memory-safe for large files.
 * Returns a 64-character lowercase hex string.
 * Throws on I/O error.
 */
export async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data",  chunk => hash.update(chunk));
    stream.on("end",   () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * SHA-256 of an in-memory buffer — used to hash archive entry data before it
 * is written to disk, enabling source-vs-destination comparison for extraction.
 */
export function sha256Buffer(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// ── File move helpers ─────────────────────────────────────────────────────────

/**
 * Move a file from `from` to `to`, creating parent directories as needed.
 * Falls back to copy+unlink on EXDEV (cross-device) errors.
 * Throws on any other I/O error.
 */
export function moveFile(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err: any) {
    if (err.code === "EXDEV") {
      fs.copyFileSync(from, to);
      fs.unlinkSync(from);
    } else {
      throw err;
    }
  }
}

// ── Verified move ─────────────────────────────────────────────────────────────

/**
 * Result of verifying a single file move.
 */
export interface FileMoveRecord {
  from:       string;
  to:         string;
  sourceHash: string;
  destHash:   string;
  verified:   boolean;
}

/**
 * Move a file and verify its SHA-256 integrity at the destination.
 *
 * Steps:
 *   1. Compute SHA-256 of the source.
 *   2. Move the file.
 *   3. Compute SHA-256 of the destination.
 *   4. If hashes differ, or if either hash is empty (I/O failure), throw.
 *
 * Any thrown error propagates to the caller so the outer try/catch can
 * trigger rollback immediately.
 *
 * @param from          Absolute source path (must exist).
 * @param to            Absolute destination path (parents created automatically).
 * @param afterMoveHook Optional callback invoked between step 2 and step 3 —
 *                      used ONLY in tests to inject corruption or latency.
 * @returns             FileMoveRecord with source/dest hashes and verified=true.
 */
export async function verifiedMove(
  from: string,
  to:   string,
  opts?: { afterMoveHook?: (to: string) => void | Promise<void> },
): Promise<FileMoveRecord> {
  // Step 1: hash source (throws on I/O error)
  const sourceHash = await sha256File(from);

  // Step 2: move file
  moveFile(from, to);

  // Optional hook (test-only) — e.g. corrupt destination before re-hashing
  if (opts?.afterMoveHook) await opts.afterMoveHook(to);

  // Step 3: hash destination (throws on I/O error)
  const destHash = await sha256File(to);

  // Step 4: compare — throw on mismatch so the caller can roll back
  if (sourceHash !== destHash) {
    throw new Error(
      `SHA-256 mismatch after moving ${path.basename(from)}: ` +
      `source=${sourceHash} dest=${destHash}. ` +
      `File may be corrupted — rolling back.`
    );
  }

  return { from, to, sourceHash, destHash, verified: true };
}

// ── Rollback ─────────────────────────────────────────────────────────────────

/**
 * Roll back a list of completed moves in reverse (LIFO) order.
 * After each file is restored, its SHA-256 is compared against the
 * `sourceHash` stored in the record.  Mismatches are logged but do not
 * prevent the remaining rollbacks from running.
 *
 * @param moves    FileMoveRecords produced during the forward move phase.
 * @param logFn    Optional callback for per-file log messages.
 * @returns        Number of files successfully restored.
 */
export async function rollbackMoves(
  moves:  FileMoveRecord[],
  logFn?: (msg: string) => void,
): Promise<number> {
  const log = logFn ?? (() => {});
  let rolledBack = 0;

  for (const mv of [...moves].reverse()) {
    try {
      if (!fs.existsSync(mv.to)) {
        log(`ROLLBACK_SKIP: ${mv.to} not found (already removed?)`);
        continue;
      }
      moveFile(mv.to, mv.from);
      rolledBack++;

      // Verify the restored file matches the original source hash
      try {
        const restoredHash = await sha256File(mv.from);
        const ok = restoredHash === mv.sourceHash;
        log(
          ok
            ? `ROLLBACK_VERIFY_OK: ${path.basename(mv.from)} hash=${restoredHash.slice(0, 16)}…`
            : `ROLLBACK_VERIFY_FAIL: ${path.basename(mv.from)} expected=${mv.sourceHash} got=${restoredHash}`,
        );
      } catch (he: any) {
        log(`ROLLBACK_HASH_ERR: ${mv.from} — ${he.message}`);
      }
    } catch (re: any) {
      log(`ROLLBACK_FAIL: ${mv.to} — ${re.message}`);
    }
  }

  return rolledBack;
}
