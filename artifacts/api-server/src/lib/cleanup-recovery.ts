import * as fs from "fs";
import * as path from "path";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { canonicalizePath, ensureDirectoryWithinRoot, resolveLibraryPath, resolveWithinRoot } from "./nas-storage.ts";
import { moveFileNoReplace, sha256File } from "./organize-helpers.ts";
import { isTrashEntryExpired } from "./cleanup-retention.ts";
import { purgeDerivedDataForMedia } from "./derived-cleanup.ts";
import { getActiveNasPath } from "./active-library.ts";

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
    if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) {
      throw new Error("Trash manifest must be a private, unlinked regular file inside the configured library.");
    }
    try { fs.chmodSync(filePath, 0o600); } catch { /* best effort on filesystems with ACL-managed permissions */ }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  return filePath;
}

function trashRoot(nasPath: string): string {
  const configuredPath = path.resolve(nasPath, "WillardAI", ".Trash");
  ensureDirectoryWithinRoot(configuredPath, nasPath);
  // Preserve the configured root spelling so manifest paths stored under a
  // symlinked library mount remain relative to the same lexical root.
  return configuredPath;
}

export function resolveLibraryTrashPath(targetPath: string, nasPath: string): string {
  return resolveTrashPath(targetPath, trashRoot(nasPath));
}

export function resolveTrashPath(targetPath: string, root: string): string {
  const lexicalRoot = path.resolve(root);
  const canonicalRoot = canonicalizePath(root);
  let relative = path.relative(lexicalRoot, path.resolve(targetPath));
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    // The manual restore route may pass back the already-canonical path
    // returned by this resolver. Accept that form only when the configured
    // library root itself is a symlink alias; ordinary outside paths remain
    // rejected and lexical symlink entries are still checked component-wise.
    if (canonicalRoot === lexicalRoot) {
      throw new Error("Trash path is outside the configured trash root");
    }
    const canonicalTarget = path.resolve(targetPath);
    relative = path.relative(canonicalRoot, canonicalTarget);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      throw new Error("Trash path is outside the configured trash root");
    }
  }
  const rootStat = fs.lstatSync(canonicalRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Trash root is not a regular directory");
  }
  const components = relative.split(path.sep).filter(Boolean);
  let current = canonicalRoot;
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]!);
    let info: fs.Stats;
    try {
      info = fs.lstatSync(current);
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return path.join(current, ...components.slice(index + 1));
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error("Trash path contains a symlink; refusing to follow it");
    }
    if (index < components.length - 1 && !info.isDirectory()) {
      throw new Error("Trash path contains a non-directory parent");
    }
  }
  return current;
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
  const root = trashRoot(nasPath);
  const normalizeTrashKey = (value: string) => {
    try { return pathKey(resolveTrashPath(value, root)); }
    catch { return pathKey(value); }
  };
  const removedPaths = new Set<string>();
  const entries: TrashManifestEntry[] = [];
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.recordType === "REMOVE" && typeof record.trashPath === "string") {
        // A tombstone is authoritative only after the trash file has left its
        // recorded path. A forged or partial journal append must not hide a
        // still-recoverable file from the trash list and restore route.
        try {
          const resolvedTrashPath = resolveTrashPath(record.trashPath, root);
          try {
            fs.lstatSync(resolvedTrashPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              removedPaths.add(pathKey(resolvedTrashPath));
            }
          }
        } catch {
          // Invalid or symlinked tombstones must not hide a manifest entry.
        }
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
      !removedPaths.has(normalizeTrashKey(entry.trashPath)),
    ),
  };
}

export function appendTrashManifestEntry(nasPath: string, entry: TrashManifestEntry): void {
  const filePath = manifestPath(nasPath);
  resolveTrashPath(entry.trashPath, trashRoot(nasPath));
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
 * Mark one manifest record as removed by appending a tombstone. The trash
 * file must already be absent; this keeps recoverable media visible if a
 * caller fails before completing its filesystem move or purge.
 */
export function removeTrashManifestEntry(nasPath: string, targetTrashPath: string, operationId: string): boolean {
  const filePath = manifestPath(nasPath);
  if (!fs.existsSync(filePath)) return false;

  const root = trashRoot(nasPath);
  let resolvedTarget: string;
  try {
    resolvedTarget = resolveTrashPath(targetTrashPath, root);
  } catch (error) {
    if (error instanceof Error && error.message.includes("symlink")) throw error;
    return false;
  }
  let targetExists = false;
  try {
    fs.lstatSync(resolvedTarget);
    targetExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (targetExists) {
    throw new Error("Trash file still exists; refusing to mark its manifest entry as removed");
  }
  const { entries } = readTrashManifest(nasPath);
  if (!entries.some((entry) => {
    try { return samePath(resolveTrashPath(entry.trashPath, root), resolvedTarget); }
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
    ? resolveTrashPath(op.trashPath, trashRoot(op.nasPath))
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

  if (op.mediaFileId === null) {
    await markNeedsReview(op.operationId, "Cleanup operation has no canonical media row");
    return;
  }

  const canonicalResult = await db.execute(sql`
    SELECT relative_path AS "relativePath", last_scan_action AS "lastScanAction",
           size_bytes AS "sizeBytes", content_hash AS "contentHash"
      FROM media_files
     WHERE id = ${op.mediaFileId} AND nas_path = ${op.nasPath}
     LIMIT 1
  `);
  const canonical = canonicalResult.rows[0] as {
    relativePath?: string;
    lastScanAction?: string | null;
    sizeBytes?: number | string | null;
    contentHash?: string | null;
  } | undefined;
  if (!canonical || typeof canonical.relativePath !== "string") {
    await markNeedsReview(op.operationId, "Cleanup file reached trash but its canonical media row is missing");
    return;
  }
  if (canonical.lastScanAction === "DELETED") {
    await markNeedsReview(op.operationId, "Canonical media row was deleted independently; trash file preserved for review");
    return;
  }
  let canonicalSource: string;
  try {
    canonicalSource = resolveLibraryPath(op.nasPath, canonical.relativePath);
  } catch {
    await markNeedsReview(op.operationId, "Canonical media row contains an invalid library path");
    return;
  }
  if (!samePath(canonicalSource, source)) {
    await markNeedsReview(op.operationId, "Canonical media path changed during cleanup; trash file preserved for review");
    return;
  }

  const trashStat = fs.lstatSync(trash);
  if (trashStat.isSymbolicLink() || !trashStat.isFile()) {
    await markNeedsReview(op.operationId, "Cleanup trash destination is not a regular file");
    return;
  }
  const expectedSize = Number(canonical.sizeBytes ?? op.sizeBytes ?? 0);
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || trashStat.size !== expectedSize ||
      (op.sizeBytes !== null && Number(op.sizeBytes) !== expectedSize)) {
    await markNeedsReview(op.operationId, "Trash file size no longer matches the canonical media row");
    return;
  }
  const actualHash = await sha256File(trash);
  if (canonical.contentHash != null) {
    if (typeof canonical.contentHash !== "string" || !/^[a-f0-9]{64}$/i.test(canonical.contentHash) ||
        actualHash.toLowerCase() !== canonical.contentHash.toLowerCase()) {
      await markNeedsReview(op.operationId, "Trash file hash no longer matches the canonical media row");
      return;
    }
  }

  const { entries } = readTrashManifest(op.nasPath);
  if (!entries.some((entry) => {
    try { return samePath(resolveTrashPath(entry.trashPath, trashRoot(op.nasPath)), trash); }
    catch { return false; }
  })) {
    appendTrashManifestEntry(op.nasPath, {
      ts: new Date().toISOString(),
      nasPath: op.nasPath,
      mediaFileId: op.mediaFileId,
      originalPath: source,
      trashPath: trash,
      sizeBytes: expectedSize,
      contentHash: actualHash,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      recoveredByStartup: true,
    });
  }

  const updated = await db.execute(sql`
    UPDATE media_files SET last_scan_action = 'RECYCLED'
     WHERE id = ${op.mediaFileId} AND nas_path = ${op.nasPath}
       AND relative_path = ${canonical.relativePath}
       AND size_bytes IS NOT DISTINCT FROM ${canonical.sizeBytes}
       AND content_hash IS NOT DISTINCT FROM ${canonical.contentHash}
       AND last_scan_action IS DISTINCT FROM 'DELETED'
  `);
  if (affectedRows(updated) !== 1) {
    await markNeedsReview(op.operationId, "Cleanup file reached trash but its canonical media row changed during recovery");
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
 * Verify a local-trash object before retention is allowed to destroy it.
 * Legacy entries without a trustworthy SHA-256 are preserved for manual review.
 */
export async function assertTrashFileIntegrity(entry: TrashManifestEntry, trashPath: string): Promise<void> {
  const stat = fs.lstatSync(trashPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Expired trash object is not a regular file; preserving it for review");
  }
  if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || stat.size !== entry.sizeBytes) {
    throw new Error("Expired trash object size does not match its manifest; preserving it for review");
  }
  if (typeof entry.contentHash !== "string" || !/^[a-f0-9]{64}$/i.test(entry.contentHash)) {
    throw new Error("Expired trash object has no valid SHA-256 manifest; preserving it for review");
  }
  const actualHash = await sha256File(trashPath);
  if (actualHash.toLowerCase() !== entry.contentHash.toLowerCase()) {
    throw new Error("Expired trash object hash does not match its manifest; preserving it for review");
  }
}


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
    try { trashPath = resolveTrashPath(entry.trashPath, trash); }
    catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    try {
      // A missing trash object is ambiguous: it may have been moved, manually
      // removed, or lost during an interrupted retention run. Without a
      // durable permanent-delete intent, never infer that it is safe to erase
      // the canonical row or hide its manifest record.
      const trashStat = (() => {
        try { return fs.lstatSync(trashPath); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      })();
      if (!trashStat) {
        throw new Error("expired trash file is missing without a durable deletion record; preserving canonical data for review");
      }
      if (entry.mediaFileId == null) {
        throw new Error("expired trash entry has no canonical media ID; preserving it for review");
      }
      // Verify the canonical row before touching the only recoverable file.
      // A stale manifest must never cause an unrelated or already-restored
      // media row to be deleted as part of retention.
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
      if (affectedRows(canonical) !== 1) {
        throw new Error("canonical recycled media row does not match this trash entry; preserving file for review");
      }
      await assertTrashFileIntegrity(entry, trashPath);
      fs.unlinkSync(trashPath);
      if (fs.existsSync(trashPath)) throw new Error("expired trash file still exists");
      await purgeDerivedDataForMedia(nasPath, [Number(entry.mediaFileId)]);
      const deleted = await db.execute(sql`
        DELETE FROM media_files
         WHERE id = ${Number(entry.mediaFileId)}
           AND nas_path = ${nasPath}
           AND last_scan_action = 'RECYCLED'
      `);
      if (affectedRows(deleted) !== 1) {
        throw new Error("trash file was removed but canonical row changed during retention; manual recovery is required");
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
  const sourceTrash = resolveTrashPath(op.sourcePath, root);
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
  const nasPath = await getActiveNasPath();
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