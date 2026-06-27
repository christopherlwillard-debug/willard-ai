/**
 * Core file-move helpers shared between the organize route and its test suite.
 * All functions are pure filesystem operations — no DB, no Express dependencies.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

/** Files ≤ this size receive a full SHA-256; larger files use a size-sentinel. */
export const SHA256_LIMIT = 100 * 1024 * 1024; // 100 MB

/**
 * Streaming SHA-256 — memory-safe for large files.
 * Returns a 64-character lowercase hex string.
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
 * Returns a comparable integrity token for a file:
 * - Files ≤ SHA256_LIMIT: full SHA-256 hex string.
 * - Files > SHA256_LIMIT: "size:<bytes>" sentinel — still catches truncation and
 *   partial writes, which are the dominant failure modes on NAS cross-device copies.
 * - Unreadable files: empty string (verification will be skipped for that file).
 */
export async function integrityToken(filePath: string): Promise<string> {
  try {
    const s = fs.statSync(filePath);
    return s.size <= SHA256_LIMIT
      ? await sha256File(filePath)
      : `size:${s.size}`;
  } catch {
    return "";
  }
}

/**
 * Returns the hash method used for a given token string.
 */
export function hashMethod(token: string): "sha256" | "size-sentinel" | "unknown" {
  if (!token) return "unknown";
  if (token.startsWith("size:")) return "size-sentinel";
  return "sha256";
}

/**
 * Move a file from `from` to `to`, creating parent directories as needed.
 * Falls back to copy+unlink when the source and destination are on different
 * filesystems (EXDEV — cross-device link not permitted).
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

/**
 * Result of verifying a single file move.
 */
export interface FileMoveRecord {
  from: string;
  to: string;
  sourceHash: string;
  destHash: string;
  verified: boolean;
  hashMethod: "sha256" | "size-sentinel" | "unknown";
}

/**
 * Move a file and verify its integrity at the destination.
 *
 * Throws an Error (with both hashes) if the destination hash differs from the
 * source hash — the caller must then roll back any completed moves.
 *
 * @param from    Absolute source path (must exist).
 * @param to      Absolute destination path (parent dirs created automatically).
 * @returns       A FileMoveRecord with source/dest hashes and verification result.
 */
export async function verifiedMove(from: string, to: string): Promise<FileMoveRecord> {
  const sourceHash = await integrityToken(from);
  moveFile(from, to);
  const destHash = await integrityToken(to);

  const method = hashMethod(sourceHash);

  // Two empty tokens means both stat() calls failed — treat as unverifiable but not a failure
  const verified = sourceHash === "" && destHash === ""
    ? false
    : sourceHash === destHash;

  if (sourceHash !== "" && destHash !== "" && sourceHash !== destHash) {
    throw new Error(
      `Integrity mismatch: ${path.basename(from)} ` +
      `sourceHash=${sourceHash} destHash=${destHash} — ` +
      `file may have been corrupted during the move. Rolling back.`
    );
  }

  return { from, to, sourceHash, destHash, verified, hashMethod: method };
}

/**
 * Roll back a list of completed moves (in reverse order).
 * Each restored file is verified against its original sourceHash.
 *
 * @param moves     FileMoveRecords from completed moves (in forward order).
 * @param logFn     Optional callback for each rollback event.
 * @returns         Count of successfully restored files.
 */
export async function rollbackMoves(
  moves: FileMoveRecord[],
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

      if (mv.sourceHash) {
        const restoredHash = await integrityToken(mv.from);
        const ok = restoredHash === mv.sourceHash;
        log(
          ok
            ? `ROLLBACK_VERIFY_OK: ${mv.from}`
            : `ROLLBACK_VERIFY_FAIL: ${mv.from} expected=${mv.sourceHash} got=${restoredHash}`,
        );
      } else {
        log(`ROLLBACK: ${mv.to} → ${mv.from}`);
      }
    } catch (re: any) {
      log(`ROLLBACK_FAIL: ${mv.to} — ${re.message}`);
    }
  }

  return rolledBack;
}
