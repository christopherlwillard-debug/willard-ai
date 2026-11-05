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

/**
 * Move without ever replacing an existing destination. Prefer an atomic
 * same-volume hard link; filesystems that do not support links fall back to an
 * exclusive copy. If source removal fails, remove only the destination we
 * created; if that cleanup also fails, preserve both errors and both files.
 */
export function moveFileNoReplace(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  let destinationCreated = false;
  try {
    try {
      fs.linkSync(from, to);
      destinationCreated = true;
    } catch (error: any) {
      if (error?.code === "EEXIST") throw error;
      if (!["EPERM", "EACCES", "EXDEV", "ENOTSUP", "EOPNOTSUPP", "EMLINK"].includes(error?.code)) {
        throw error;
      }
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      destinationCreated = true;
    }
    fs.unlinkSync(from);
  } catch (error) {
    if (destinationCreated) {
      try {
        fs.unlinkSync(to);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "No-replace move failed and its newly-created destination could not be rolled back",
        );
      }
    }
    throw error;
  }
}

/**
 * Enumerate regular files in a source directory without silently skipping
 * unreadable entries. A partial walk can make an organize plan appear complete
 * while leaving files behind, so any read/stat failure aborts the scan.
 * Symlinks and special filesystem entries are rejected rather than omitted.
 */
export function walkDirectoryFiles(
  directoryPath: string,
): Array<{ fullPath: string; relativePath: string; sizeBytes: number }> {
  const root = path.resolve(directoryPath);
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(root);
  } catch (error) {
    const detail = error as NodeJS.ErrnoException;
    throw new Error(`Unable to inspect source directory "${root}": ${detail.code ?? detail.message ?? String(error)}`, { cause: error });
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Source path is not a regular directory: "${root}"`);
  }

  const results: Array<{ fullPath: string; relativePath: string; sizeBytes: number }> = [];
  const walk = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      const detail = error as NodeJS.ErrnoException;
      throw new Error(`Unable to read source directory "${directory}": ${detail.code ?? detail.message ?? String(error)}`, { cause: error });
    }

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(fullPath);
      } catch (error) {
        const detail = error as NodeJS.ErrnoException;
        throw new Error(`Unable to inspect source entry "${fullPath}": ${detail.code ?? detail.message ?? String(error)}`, { cause: error });
      }

      if (stat.isSymbolicLink()) {
        throw new Error(`Symbolic links are not supported in organize source folders: "${fullPath}"`);
      }
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        results.push({
          fullPath,
          relativePath: path.relative(root, fullPath),
          sizeBytes: stat.size,
        });
      } else {
        throw new Error(`Unsupported filesystem entry in organize source folder: "${fullPath}"`);
      }
    }
  };

  walk(root);
  return results;
}

// ── Verified move ─────────────────────────────────────────────────────────────

/**
 * Result of verifying a single file move.
 */
export interface FileMoveRecord {
  from:          string;
  to:            string;
  sourceHash:    string;
  destHash:      string;
  verified:      boolean;
  /** Relative path of the source file within the staging area / source folder.
   *  Stored so resume can identify already-moved files by source identity,
   *  not by recomputed destination filename (which differs under rename-conflict policy). */
  sourceRelPath?: string;
}

/**
 * Move a file without replacing an existing destination, then verify its
 * SHA-256 integrity. If verification fails after the move, restore the file
 * to its source path with a no-replace operation before propagating the error.
 * This keeps an unverified partial result out of the final destination and
 * prevents a retry from silently treating it as a completed move.
 */
export async function verifiedMove(
  from: string,
  to:   string,
  opts?: { afterMoveHook?: (to: string) => void | Promise<void>; sourceRelPath?: string },
): Promise<FileMoveRecord> {
  // Hash before moving; an unreadable source must never be moved.
  const sourceHash = await sha256File(from);
  let destinationCreated = false;

  try {
    // A concurrent job may have created the destination after its conflict
    // check. Never let rename semantics overwrite that independent file.
    moveFileNoReplace(from, to);
    destinationCreated = true;

    // Optional hook (test-only) — e.g. corrupt destination before re-hashing.
    if (opts?.afterMoveHook) await opts.afterMoveHook(to);

    const destHash = await sha256File(to);
    if (sourceHash !== destHash) {
      throw new Error(
        `SHA-256 mismatch after moving ${path.basename(from)}: ` +
        `source=${sourceHash} dest=${destHash}. File may be corrupted.`,
      );
    }

    return { from, to, sourceHash, destHash, verified: true, sourceRelPath: opts?.sourceRelPath };
  } catch (error) {
    // verifiedMove has not yet returned a FileMoveRecord, so the caller cannot
    // include this file in its normal batch rollback. Restore it here. The
    // no-replace helper refuses to overwrite a source path recreated by
    // another actor; if restoration fails, preserve both errors and the
    // destination rather than deleting the only remaining copy.
    if (destinationCreated && !fs.existsSync(from) && fs.existsSync(to)) {
      try {
        moveFileNoReplace(to, from);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Verified move failed and the file could not be restored to its source path; it remains at ${to}`,
        );
      }
    }
    throw error;
  }
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
        // A previous rollback attempt may already have restored this file.
        // Count it only when the source is a regular file with the expected
        // original hash; a new or altered file is never treated as recovered.
        if (fs.existsSync(mv.from)) {
          try {
            const sourceStat = fs.lstatSync(mv.from);
            if (sourceStat.isFile() && !sourceStat.isSymbolicLink()) {
              const restoredHash = await sha256File(mv.from);
              if (restoredHash === mv.sourceHash) {
                rolledBack++;
                log(`ROLLBACK_ALREADY_RESTORED: ${path.basename(mv.from)} hash=${restoredHash.slice(0, 16)}…`);
                continue;
              }
            }
          } catch { /* report the missing destination below */ }
        }
        log(`ROLLBACK_SKIP: ${mv.to} not found and original path is not verified`);
        continue;
      }

      // A crash can occur after the no-replace hard-link step but before the
      // original destination link is removed. If both names are the same
      // regular-file inode and the content is correct, finish that move.
      if (fs.existsSync(mv.from)) {
        try {
          const sourceStat = fs.lstatSync(mv.from);
          const destinationStat = fs.lstatSync(mv.to);
          if (
            sourceStat.isFile() && destinationStat.isFile() &&
            !sourceStat.isSymbolicLink() && !destinationStat.isSymbolicLink() &&
            sourceStat.dev === destinationStat.dev && sourceStat.ino === destinationStat.ino
          ) {
            const restoredHash = await sha256File(mv.from);
            if (restoredHash === mv.sourceHash) {
              fs.unlinkSync(mv.to);
              rolledBack++;
              log(`ROLLBACK_ALREADY_RESTORED: ${path.basename(mv.from)} hard-link finalized`);
              continue;
            }
          }
        } catch { /* normal no-replace move below will preserve any conflict */ }
      }

      // Verify the destination still contains the exact original bytes before
      // restoring it. A file changed after the forward move must not be counted
      // as successfully rolled back or silently replace the original source.
      const destinationHash = await sha256File(mv.to);
      if (destinationHash !== mv.sourceHash) {
        log(`ROLLBACK_VERIFY_FAIL: ${path.basename(mv.to)} expected=${mv.sourceHash} got=${destinationHash}; destination preserved`);
        continue;
      }

      moveFileNoReplace(mv.to, mv.from);

      // Count only checksum-verified restores. If bytes change between the
      // preflight hash and the move, put the unverified file back at its
      // destination when possible and leave this move incomplete for recovery.
      const restoredHash = await sha256File(mv.from);
      if (restoredHash !== mv.sourceHash) {
        try {
          moveFileNoReplace(mv.from, mv.to);
          log(`ROLLBACK_VERIFY_FAIL: ${path.basename(mv.from)} expected=${mv.sourceHash} got=${restoredHash}; unverified file returned to destination`);
        } catch (preserveError: any) {
          log(`ROLLBACK_VERIFY_FAIL: ${path.basename(mv.from)} expected=${mv.sourceHash} got=${restoredHash}; could not return unverified file to destination: ${preserveError.message}`);
        }
        continue;
      }

      rolledBack++;
      log(`ROLLBACK_VERIFY_OK: ${path.basename(mv.from)} hash=${restoredHash.slice(0, 16)}…`);
    } catch (re: any) {
      log(`ROLLBACK_FAIL: ${mv.to} — ${re.message}`);
    }
  }

  return rolledBack;
}
