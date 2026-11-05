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
  /** Existing destination held aside until the organization job commits. */
  replacement?: {
    backupPath: string;
    previousHash: string;
  };
  /** Relative path of the source file within the staging area / source folder.
   *  Stored so resume can identify already-moved files by source identity,
   *  not by recomputed destination filename (which differs under rename-conflict policy). */
  sourceRelPath?: string;
}

/**
 * A job may be deleted only when no active worker or unresolved file-move
 * journal depends on it. Completed and fully rolled-back jobs retain history
 * only; failed jobs with moves must remain available for recovery.
 */
export function canDeleteOrganizationJob(status: string, fileMoves: unknown): boolean {
  if (fileMoves !== null && fileMoves !== undefined && !Array.isArray(fileMoves)) return false;
  if (status === "completed" || status === "rolled_back") return true;
  if (!["pending", "planned", "verified", "failed"].includes(status)) return false;
  return fileMoves == null || fileMoves.length === 0;
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
  opts?: { afterMoveHook?: (to: string) => void | Promise<void>; sourceRelPath?: string; expectedSourceHash?: string },
): Promise<FileMoveRecord> {
  // Hash before moving; an unreadable source must never be moved.
  const sourceHash = await sha256File(from);
  if (opts?.expectedSourceHash && sourceHash !== opts.expectedSourceHash) {
    throw new Error(`Source changed after its recovery intent was recorded: ${path.basename(from)}`);
  }
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

/**
 * Replace an existing regular file without discarding it before the incoming
 * file has been published and verified. The caller persists the replacement
 * metadata in its move intent before calling this function.
 */
export async function verifiedReplace(
  from: string,
  to: string,
  opts: {
    backupPath: string;
    expectedPreviousHash: string;
    expectedSourceHash?: string;
    sourceRelPath?: string;
    afterBackupHook?: (backupPath: string) => void | Promise<void>;
    afterMoveHook?: (to: string) => void | Promise<void>;
    afterPublishHook?: (to: string) => void | Promise<void>;
  },
): Promise<FileMoveRecord> {
  const destinationStat = fs.lstatSync(to);
  if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) {
    throw new Error(`Replacement destination is not a regular file: ${path.basename(to)}`);
  }
  const previousHash = await sha256File(to);
  if (previousHash !== opts.expectedPreviousHash) {
    throw new Error(`Replacement destination changed after its recovery intent was recorded: ${path.basename(to)}`);
  }

  let backupMoved = false;
  let publishedRecord: FileMoveRecord | null = null;
  try {
    moveFileNoReplace(to, opts.backupPath);
    backupMoved = true;
    const backupStat = fs.lstatSync(opts.backupPath);
    if (!backupStat.isFile() || backupStat.isSymbolicLink()) {
      throw new Error(`Replacement backup is not a regular file: ${path.basename(opts.backupPath)}`);
    }
    const backupHash = await sha256File(opts.backupPath);
    if (backupHash !== opts.expectedPreviousHash) {
      throw new Error(`Replacement backup verification failed for ${path.basename(to)}`);
    }
    if (opts.afterBackupHook) await opts.afterBackupHook(opts.backupPath);

    publishedRecord = await verifiedMove(from, to, {
      expectedSourceHash: opts.expectedSourceHash,
      sourceRelPath: opts.sourceRelPath,
      afterMoveHook: opts.afterMoveHook,
    });
    if (opts.afterPublishHook) await opts.afterPublishHook(to);

    return {
      ...publishedRecord,
      replacement: {
        backupPath: opts.backupPath,
        previousHash: opts.expectedPreviousHash,
      },
    };
  } catch (error) {
    // If publication completed but a later checkpoint hook failed, put the
    // incoming file back only when it is still the verified payload and the
    // source path is free. Never overwrite a competing source or destination.
    if (publishedRecord && !fs.existsSync(from) && fs.existsSync(to)) {
      try {
        const publishedHash = await regularFileHash(to);
        if (publishedHash !== publishedRecord.sourceHash) {
          throw new Error("Published destination changed before it could be restored");
        }
        moveFileNoReplace(to, from);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Replacement failed and the verified incoming file could not be restored; preserve ${to} and ${opts.backupPath} for manual recovery`,
        );
      }
    }

    if (backupMoved && fs.existsSync(opts.backupPath)) {
      if (fs.existsSync(to)) {
        throw new AggregateError(
          [error],
          `Replacement failed and the prior destination remains preserved at ${opts.backupPath}; ${to} is occupied, so manual recovery is required`,
        );
      }
      try {
        const backupHash = await regularFileHash(opts.backupPath);
        if (backupHash !== opts.expectedPreviousHash) {
          throw new Error("Prior destination backup no longer matches its recorded checksum");
        }
        moveFileNoReplace(opts.backupPath, to);
        const restoredHash = await regularFileHash(to);
        if (restoredHash !== opts.expectedPreviousHash) {
          throw new Error("Restored prior destination failed checksum verification");
        }
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Replacement failed and the prior destination could not be restored; its copy remains at ${opts.backupPath} for manual recovery`,
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
      if (mv.replacement) {
        const replacementResult = await rollbackReplacementMove(mv, log);
        if (replacementResult) rolledBack++;
        continue;
      }

      // A malformed or stale journal must never be allowed to unlink a file
      // when both sides resolve to the same path. On Windows, compare paths
      // case-insensitively because differently-cased paths can name one file.
      const resolvedFrom = path.resolve(mv.from);
      const resolvedTo = path.resolve(mv.to);
      const normalizedFrom = process.platform === "win32" ? resolvedFrom.toLowerCase() : resolvedFrom;
      const normalizedTo = process.platform === "win32" ? resolvedTo.toLowerCase() : resolvedTo;
      if (normalizedFrom === normalizedTo) {
        log(`ROLLBACK_SKIP: source and destination resolve to the same path; refusing destructive rollback: ${resolvedFrom}`);
        continue;
      }
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

      // Never hash or move a symlink/FIFO/device as though it were the
      // original regular file. In particular, hashing a symlink follows its
      // target and could falsely report that an external file was restored.
      const destinationStat = fs.lstatSync(mv.to);
      if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) {
        log(`ROLLBACK_VERIFY_FAIL: ${path.basename(mv.to)} is not a regular file; destination preserved`);
        continue;
      }

      // A durable pre-move intent can survive a crash before the source
      // leaves staging. If the original source is still intact, the move never
      // completed (or a previous rollback already restored it); preserve any
      // destination that appeared independently and close this journal entry.
      if (fs.existsSync(mv.from)) {
        try {
          const sourceStat = fs.lstatSync(mv.from);
          if (sourceStat.isFile() && !sourceStat.isSymbolicLink()) {
            const sourceHash = await sha256File(mv.from);
            if (sourceHash === mv.sourceHash) {
              rolledBack++;
              log(`ROLLBACK_SOURCE_INTACT: ${path.basename(mv.from)} remains at source; destination preserved`);
              continue;
            }
          }
        } catch { /* a later no-replace restore will preserve any source conflict */ }
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

      // Re-check the restored path without following links. This closes the
      // ordinary symlink replacement window between destination inspection
      // and the no-replace move; an unverified entry is returned when possible.
      const restoredStat = fs.lstatSync(mv.from);
      if (!restoredStat.isFile() || restoredStat.isSymbolicLink()) {
        try {
          moveFileNoReplace(mv.from, mv.to);
          log(`ROLLBACK_VERIFY_FAIL: ${path.basename(mv.from)} is not a regular file; entry returned to destination`);
        } catch (preserveError: any) {
          log(`ROLLBACK_VERIFY_FAIL: ${path.basename(mv.from)} is not a regular file; could not return it to destination: ${preserveError.message}`);
        }
        continue;
      }

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

async function regularFileHash(filePath: string): Promise<string | null> {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return await sha256File(filePath);
  } catch {
    return null;
  }
}

async function rollbackReplacementMove(
  mv: FileMoveRecord,
  log: (message: string) => void,
): Promise<boolean> {
  const replacement = mv.replacement!;
  const sourceHash = await regularFileHash(mv.from);
  let destinationHash = await regularFileHash(mv.to);

  // If the incoming file reached the final path, move it back only when the
  // original source path is free. A competing source is never overwritten.
  if (destinationHash === mv.sourceHash && sourceHash === null) {
    moveFileNoReplace(mv.to, mv.from);
    const restoredSourceHash = await regularFileHash(mv.from);
    if (restoredSourceHash !== mv.sourceHash) {
      log(`ROLLBACK_REPLACEMENT_MANUAL: incoming file did not verify at source; preserved ${mv.from} and ${replacement.backupPath}`);
      return false;
    }
    destinationHash = null;
  } else if (
    destinationHash === mv.sourceHash && sourceHash === mv.sourceHash &&
    fs.existsSync(mv.to) && fs.existsSync(mv.from)
  ) {
    try {
      const sourceStat = fs.lstatSync(mv.from);
      const destinationStat = fs.lstatSync(mv.to);
      if (sourceStat.dev === destinationStat.dev && sourceStat.ino === destinationStat.ino) {
        fs.unlinkSync(mv.to);
        destinationHash = null;
      }
    } catch {
      // Leave both paths intact and report a manual recovery requirement below.
    }
  }

  const currentSourceHash = await regularFileHash(mv.from);
  if (currentSourceHash !== mv.sourceHash) {
    log(`ROLLBACK_REPLACEMENT_MANUAL: incoming source is missing or changed; preserve ${mv.to} and ${replacement.backupPath}`);
    return false;
  }

  const backupHash = await regularFileHash(replacement.backupPath);
  if (backupHash !== null) {
    if (backupHash !== replacement.previousHash) {
      log(`ROLLBACK_REPLACEMENT_MANUAL: prior destination backup checksum mismatch; preserved ${replacement.backupPath}`);
      return false;
    }
    destinationHash = await regularFileHash(mv.to);
    if (destinationHash === null) {
      moveFileNoReplace(replacement.backupPath, mv.to);
      destinationHash = await regularFileHash(mv.to);
      if (destinationHash !== replacement.previousHash) {
        log(`ROLLBACK_REPLACEMENT_MANUAL: restored prior destination failed verification; preserved ${mv.to}`);
        return false;
      }
    } else if (destinationHash === replacement.previousHash) {
      // Both copies are verified old bytes; removing only the redundant backup
      // cannot remove the last remaining copy.
      try { fs.unlinkSync(replacement.backupPath); } catch { /* a harmless duplicate remains */ }
    } else {
      log(`ROLLBACK_REPLACEMENT_MANUAL: destination is occupied by different data; preserved ${mv.to} and ${replacement.backupPath}`);
      return false;
    }
  } else if (destinationHash !== replacement.previousHash) {
    log(`ROLLBACK_REPLACEMENT_MANUAL: prior destination is unavailable; inspect ${mv.to} and ${replacement.backupPath}`);
    return false;
  }

  log(`ROLLBACK_REPLACEMENT_OK: ${path.basename(mv.to)} source and prior destination verified`);
  return true;
}
