import * as fs from "fs";
import * as path from "path";
import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { ensureDirectoryWithinRoot, resolveLibraryPath, resolveWithinRoot } from "./nas-storage.ts";
import { moveFileNoReplace, sha256File } from "./organize-helpers.ts";
import { isTrashEntryExpired } from "./cleanup-retention.ts";
import { purgeDerivedDataForMedia } from "./derived-cleanup.ts";

export type TrashManifestEntry = {
  ts?: string;
  nasPath?: string;
  mediaFileId?: number;
  originalPath: string;
  trashPath: string;
  relativePath?: string;
  sizeBytes: number;
  contentHash?: string;
  expiresAt?: string;
  [key: string]: unknown;
};

type PendingOperation = {
  operationId: string;
  nasPath: string;
  mediaFileId: number | null;
  operationType: "CLEANUP" | "RESTORE";
  sourcePath: string;
  trashPath: string | null;
  sizeBytes: number;
  status: string;
};

type QueryResultLike = {
  rowCount?: number | null;
  rows?: unknown[];
};

function affectedRows(result: unknown): number {
  const queryResult = result as QueryResultLike;
  if (typeof queryResult.rowCount === "number") return queryResult.rowCount;
  return Array.isArray(queryResult.rows) ? queryResult.rows.length : 0;
}

export function manifestPath(nasPath: string): string {
  const logsDir = ensureDirectoryWithinRoot(path.join(nasPath, "WillardAI", "logs"), nasPath);
  const filePath = path.join(logsDir, "trash-manifest.jsonl");
  try {
    const info = fs.lstatSync(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("Trash manifest must be a regular file inside the configured library.");
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  return filePath;
}

function trashRoot(nasPath: string): string {
  return resolveWithinRoot(path.join(nasPath, "WillardAI", ".Trash"), path.join(nasPath, "WillardAI"));
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

export function readTrashManifest(nasPath: string): { lines: string[]; entries: TrashManifestEntry[] } {
  const filePath = manifestPath(nasPath);
  if (!fs.existsSync(filePath)) return { lines: [], entries: [] };
  const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  const removedPaths = new Set<string>();
  const entries: TrashManifestEntry[] = [];
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.recordType === "REMOVE" && typeof record.trashPath === "string") {
        removedPaths.add(pathKey(record.trashPath));
        continue;
      }
      if (typeof record.originalPath === "string" && typeof record.trashPath === "string") {
        entries.push(record as unknown as TrashManifestEntry);
      }
    } catch {
      // Preserve malformed/unknown lines for diagnostics; they are not active entries.
    }
  }
  return {
    lines,
    entries: entries.filter((entry) =>
      !removedPaths.has(pathKey(entry.trashPath)),
    ),
  };
}

export function appendTrashManifestEntry(nasPath: string, entry: TrashManifestEntry): void {
  const filePath = manifestPath(nasPath);
  const fd = fs.openSync(filePath, "a", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(entry) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try { fs.chmodSync(filePath, 0o600); } catch { /* best effort */ }
}

/**
 * Remove one manifest record with a replace-then-rename write. A crash before
 * the rename leaves the old manifest intact; a crash after it is safe because
 * the restore operation remains durable until it reaches RECORDED.
 */
export function removeTrashManifestEntry(nasPath: string, targetTrashPath: string, operationId: string): boolean {
  const filePath = manifestPath(nasPath);
  if (!fs.existsSync(filePath)) return false;

  const root = trashRoot(nasPath);
  let resolvedTarget: string;
  try {
    resolvedTarget = resolveWithinRoot(targetTrashPath, root);
  } catch {
    return false;
  }
  const { entries } = readTrashManifest(nasPath);
  if (!entries.some((entry) => {
    try { return samePath(resolveWithinRoot(entry.trashPath, root), resolvedTarget); }
    catch { return false; }
  })) return false;

  // The manifest is an append-only journal. A tombstone makes removal durable
  // without replacing the file; a crash can never erase unrelated trash rows.
  const tombstone = {
    recordType: "REMOVE",
    operationId,
    trashPath: resolvedTarget,
    removedAt: new Date().toISOString(),
  };
  const fd = fs.openSync(filePath, "a", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(tombstone) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try { fs.chmodSync(filePath, 0o600); } catch { /* best effort */ }
  return true;
}

async function markNeedsReview(operationId: string, error: string): Promise<void> {
  await db.execute(sql`
    UPDATE cleanup_operations
    SET status = 'NEEDS_REVIEW', error = ${error.slice(0, 1000)}, updated_at = NOW()
    WHERE operation_id = ${operationId}
  `);
}

async function reconcileCleanupOperation(op: PendingOperation): Promise<void> {
  const source = resolveWithinRoot(op.sourcePath, op.nasPath);
  const trash = op.trashPath
    ? resolveWithinRoot(op.trashPath, path.join(op.nasPath, "WillardAI", ".Trash"))
    : null;
  const sourceExists = fs.existsSync(source);
  const trashExists = Boolean(trash && fs.existsSync(trash));

  if (sourceExists && !trashExists) {
    await markNeedsReview(op.operationId, "Filesystem move did not complete; source remains present");
    return;
  }
  if (sourceExists && trashExists) {
    await db.execute(sql`
      UPDATE cleanup_operations SET status = 'CONFLICT',
        error = 'Both source and trash paths exist; no automatic move performed',
        updated_at = NOW() WHERE operation_id = ${op.operationId}
    `);
    return;
  }
  if (!trashExists || !trash) {
    await markNeedsReview(op.operationId, "Neither source nor trash path exists; no file was deleted by recovery");
    return;
  }

  const { entries } = readTrashManifest(op.nasPath);
  if (!entries.some((entry) => {
    try { return samePath(resolveWithinRoot(entry.trashPath, trashRoot(op.nasPath)), trash); }
    catch { return false; }
  })) {
    appendTrashManifestEntry(op.nasPath, {
      ts: new Date().toISOString(),
      nasPath: op.nasPath,
      mediaFileId: op.mediaFileId ?? undefined,
      originalPath: source,
      trashPath: trash,
      sizeBytes: Number(op.sizeBytes ?? 0),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      recoveredByStartup: true,
    });
  }

  if (op.mediaFileId === null) {
    await markNeedsReview(op.operationId, "Cleanup operation has no canonical media row");
    return;
  }
  const updated = await db.execute(sql`
    UPDATE media_files SET last_scan_action = 'RECYCLED'
    WHERE id = ${op.mediaFileId} AND nas_path = ${op.nasPath}
  `);
  if (affectedRows(updated) !== 1) {
    await markNeedsReview(op.operationId, "Cleanup file reached trash but its canonical media row is missing");
    return;
  }
  await purgeDerivedDataForMedia(op.nasPath, [op.mediaFileId]);
  await db.execute(sql`
    UPDATE cleanup_operations SET status = 'RECORDED', error = NULL, updated_at = NOW()
    WHERE operation_id = ${op.operationId}
  `);
}

export type ExpiredTrashResult = {
  expired: number;
  permanentlyRemoved: number;
  errors: string[];
};


/**
 * Permanently remove expired local-trash files and their canonical rows.
 * Windows' OS recycle bin is intentionally not guessed at: only manifest
 * entries with a validated WillardAI/.Trash path are eligible here.
 */
export async function purgeExpiredTrashEntries(nasPath: string): Promise<ExpiredTrashResult> {
  const result: ExpiredTrashResult = { expired: 0, permanentlyRemoved: 0, errors: [] };
  const { entries } = readTrashManifest(nasPath);
  const trash = trashRoot(nasPath);
  for (const entry of entries) {
    if (!isTrashEntryExpired(entry.expiresAt)) continue;
    result.expired++;
    let trashPath: string;
    try { trashPath = resolveWithinRoot(entry.trashPath, trash); }
    catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    try {
      if (fs.existsSync(trashPath)) fs.rmSync(trashPath, { force: true });
      if (fs.existsSync(trashPath)) throw new Error("expired trash file still exists");
      if (entry.mediaFileId != null) {
        const canonical = await db.execute(sql`
          SELECT id
            FROM media_files
           WHERE id = ${Number(entry.mediaFileId)}
             AND nas_path = ${nasPath}
             AND last_scan_action = 'RECYCLED'
             AND REPLACE(nas_path || '/' || relative_path, chr(92), '/') =
                 REPLACE(${entry.originalPath}, chr(92), '/')
           LIMIT 1
        `);
        if (affectedRows(canonical) === 1) {
          await purgeDerivedDataForMedia(nasPath, [Number(entry.mediaFileId)]);
          await db.execute(sql`
            DELETE FROM media_files
             WHERE id = ${Number(entry.mediaFileId)}
               AND nas_path = ${nasPath}
               AND last_scan_action = 'RECYCLED'
          `);
        }
      }
      removeTrashManifestEntry(nasPath, trashPath, `expiry-${randomUUID()}`);
      result.permanentlyRemoved++;
    } catch (error) {
      result.errors.push(`${entry.trashPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

async function reconcileRestoreOperation(op: PendingOperation): Promise<void> {
  if (op.mediaFileId === null || !op.trashPath) {
    await markNeedsReview(op.operationId, "Restore operation has no canonical media row or destination");
    return;
  }

  const root = trashRoot(op.nasPath);
  const sourceTrash = resolveWithinRoot(op.sourcePath, root);
  const destination = resolveWithinRoot(op.trashPath, op.nasPath);
  const [row] = await db.execute(sql`
    SELECT id, relative_path AS "relativePath", last_scan_action AS "lastScanAction",
           size_bytes AS "sizeBytes", content_hash AS "contentHash"
    FROM media_files
    WHERE id = ${op.mediaFileId} AND nas_path = ${op.nasPath}
    LIMIT 1
  `).then((result) => result.rows as Array<{
    id: number;
    relativePath: string;
    lastScanAction: string | null;
    sizeBytes: number;
    contentHash: string | null;
  }>);

  if (!row) {
    await markNeedsReview(op.operationId, "Restore manifest refers to a missing canonical media row");
    return;
  }
  let canonicalPath: string;
  try {
    canonicalPath = resolveLibraryPath(op.nasPath, row.relativePath);
  } catch {
    await markNeedsReview(op.operationId, "Canonical media row contains an invalid library path");
    return;
  }
  if (!samePath(canonicalPath, destination)) {
    await markNeedsReview(op.operationId, "Restore destination does not match the canonical media row");
    return;
  }

  const sourceExists = fs.existsSync(sourceTrash);
  const destinationExists = fs.existsSync(destination);
  if (sourceExists && destinationExists) {
    await db.execute(sql`
      UPDATE cleanup_operations SET status = 'CONFLICT',
        error = 'Both trash and restore destination exist; no automatic overwrite performed',
        updated_at = NOW() WHERE operation_id = ${op.operationId}
    `);
    return;
  }
  if (!sourceExists && !destinationExists) {
    await markNeedsReview(op.operationId, "Neither trash file nor restore destination exists");
    return;
  }

  const expectedSize = Number(row.sizeBytes ?? op.sizeBytes ?? 0);
  const expectedHash = typeof row.contentHash === "string" ? row.contentHash : null;
  const verifyFile = async (filePath: string) => {
    const stat = fs.statSync(filePath);
    if (stat.size !== expectedSize) throw new Error("Restored file size does not match the canonical media row");
    if (expectedHash && await sha256File(filePath) !== expectedHash) {
      throw new Error("Restored file hash does not match the canonical media row");
    }
  };

  try {
    if (sourceExists) {
      await verifyFile(sourceTrash);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      moveFileNoReplace(sourceTrash, destination);
    }
    await verifyFile(destination);
  } catch (error) {
    await markNeedsReview(op.operationId, error instanceof Error ? error.message : "Restore file verification failed");
    return;
  }

  await db.execute(sql`
    UPDATE cleanup_operations SET status = 'FILESYSTEM_MOVED', error = NULL, updated_at = NOW()
    WHERE operation_id = ${op.operationId}
  `);

  if (row.lastScanAction === "RECYCLED") {
    const updated = await db.execute(sql`
      UPDATE media_files SET last_scan_action = NULL
      WHERE id = ${op.mediaFileId} AND nas_path = ${op.nasPath}
        AND last_scan_action = 'RECYCLED'
    `);
    if (affectedRows(updated) !== 1) {
      await markNeedsReview(op.operationId, "Restored file exists but the canonical recycle marker could not be cleared");
      return;
    }
  } else if (row.lastScanAction !== null) {
    await markNeedsReview(op.operationId, "Canonical media row is no longer in the recycled state");
    return;
  }

  await db.execute(sql`
    UPDATE cleanup_operations SET status = 'DB_RECONCILED', updated_at = NOW()
    WHERE operation_id = ${op.operationId}
  `);
  removeTrashManifestEntry(op.nasPath, sourceTrash, op.operationId);
  await db.execute(sql`
    UPDATE cleanup_operations SET status = 'RECORDED', error = NULL, updated_at = NOW()
    WHERE operation_id = ${op.operationId}
  `);
}

/**
 * Reconcile only filesystem states that prove what happened. This is safe to
 * run repeatedly after every restart; it never removes an unknown file.
 */
export async function reconcileCleanupOperations(): Promise<void> {
  const [settings] = await db.select({ nasPath: appSettingsTable.nasPath })
    .from(appSettingsTable).limit(1);
  const nasPath = settings?.nasPath?.trim();
  if (!nasPath) return;

  const result = await db.execute(sql`
    SELECT operation_id AS "operationId", nas_path AS "nasPath",
           media_file_id AS "mediaFileId", operation_type AS "operationType",
           source_path AS "sourcePath", trash_path AS "trashPath",
           size_bytes AS "sizeBytes", status
    FROM cleanup_operations
    WHERE nas_path = ${nasPath}
      AND status NOT IN ('RECORDED', 'FAILED', 'CONFLICT', 'NEEDS_REVIEW')
  `);

  for (const op of result.rows as unknown as PendingOperation[]) {
    try {
      if (op.operationType === "RESTORE") {
        await reconcileRestoreOperation(op);
      } else {
        await reconcileCleanupOperation(op);
      }
    } catch (error) {
      await markNeedsReview(op.operationId, error instanceof Error ? error.message : "Unable to validate recovery paths");
    }
  }
}