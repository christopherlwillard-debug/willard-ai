import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { archivesTable, appSettingsTable, mediaFilesTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import { resolveLibraryPath, resolveWithinRoot, getWillardAIDir } from "../lib/nas-storage";
import { activeMediaCondition, activeMediaSql } from "../lib/media-scope.ts";
import { appendTrashManifestEntry, manifestPath, purgeExpiredTrashEntries, readTrashManifest, removeTrashManifestEntry } from "../lib/cleanup-recovery.ts";
import { sha256File } from "../lib/organize-helpers.ts";
import { DUPLICATE_CONFIRMATION_LIMIT_BYTES } from "../lib/library-engine/indexer.ts";
import { purgeDerivedDataForMedia } from "../lib/derived-cleanup.ts";

const router: IRouter = Router();

const LARGE_FILE_THRESHOLD = DUPLICATE_CONFIRMATION_LIMIT_BYTES;
const OLD_FILE_YEARS = 5;

function cleanupLogPath(nasPath: string) {
  return path.join(nasPath, "WillardAI", "logs", "cleanup-history.jsonl");
}

async function getConfiguredNasPath(): Promise<string | null> {
  const [row] = await db.select({ nasPath: appSettingsTable.nasPath }).from(appSettingsTable).limit(1);
  const nasPath = row?.nasPath?.trim();
  return nasPath || null;
}

// ── GET /cleanup/duplicates — enriched with mediaFilesTable data ───────────

router.get("/cleanup/duplicates", async (req, res) => {
  try {
    const nasPath = await getConfiguredNasPath();
    if (!nasPath) {
      res.json({ groups: [], totalGroups: 0, totalWastedBytes: 0 });
      return;
    }
    const rawLimit = Number.parseInt(String(req.query.limit ?? "20"), 10);
    const rawOffset = Number.parseInt(String(req.query.offset ?? "0"), 10);
    const pageLimit = Math.min(100, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 20));
    const pageOffset = Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0);

    // ── 1. Exact-hash groups ────────────────────────────────────────────────
    const exactHashGroups = await db.execute(sql`
      SELECT content_hash AS group_key, COUNT(*) as file_count, SUM(size_bytes) as total_size
      FROM ${mediaFilesTable}
       WHERE nas_path = ${nasPath}
         AND content_hash IS NOT NULL
         AND ${activeMediaCondition}
      GROUP BY content_hash
      HAVING COUNT(*) > 1
    `);

    // ── 2. Perceptual-hash groups (same quickFingerprint, different hashes) ─
    const perceptualGroups = await db.execute(sql`
      SELECT
        m.quick_fingerprint AS group_key,
        COUNT(*) AS file_count,
         SUM(m.size_bytes) AS total_size,
         COUNT(*) FILTER (
           WHERE m.content_hash IS NULL
             AND m.size_bytes > ${DUPLICATE_CONFIRMATION_LIMIT_BYTES}
         ) AS large_unconfirmed_count
      FROM ${mediaFilesTable} m
      WHERE m.nas_path = ${nasPath}
        AND m.quick_fingerprint IS NOT NULL
        AND m.quick_fingerprint != ''
         AND ${activeMediaCondition}
      GROUP BY m.quick_fingerprint
      HAVING COUNT(*) > 1
        AND NOT (
          COUNT(m.content_hash) = COUNT(*)
          AND COUNT(DISTINCT m.content_hash) = 1
        )
    `);

    // ── 3. Build raw group descriptors sorted by wasted bytes desc ──────────
    type RawGroup = {
      groupKey: string;
      fileCount: number;
      totalSize: number;
      matchType: "HASH_IDENTICAL" | "PERCEPTUAL_SIMILAR";
      matchConfidence: number;
      confirmationStatus: "CONFIRMED" | "UNCONFIRMED_FINGERPRINT" | "UNCONFIRMED_LARGE";
    };

    const allRaw: RawGroup[] = [
      ...(exactHashGroups.rows as any[]).map(r => ({
        groupKey:        String(r.group_key),
        fileCount:       parseInt(r.file_count),
        totalSize:       Number(r.total_size),
        matchType:       "HASH_IDENTICAL" as const,
        matchConfidence: 5,
        confirmationStatus: "CONFIRMED" as const,
      })),
      ...(perceptualGroups.rows as any[]).map(r => ({
        groupKey:        String(r.group_key),
        fileCount:       parseInt(r.file_count),
        totalSize:       Number(r.total_size),
        matchType:       "PERCEPTUAL_SIMILAR" as const,
        matchConfidence: Number(r.large_unconfirmed_count) > 0 ? 2 : 4,
        confirmationStatus: Number(r.large_unconfirmed_count) > 0
          ? "UNCONFIRMED_LARGE" as const
          : "UNCONFIRMED_FINGERPRINT" as const,
      })),
    ].sort((a, b) => {
      const wastedA = (a.fileCount - 1) * (a.totalSize / a.fileCount);
      const wastedB = (b.fileCount - 1) * (b.totalSize / b.fileCount);
      return wastedB - wastedA;
    });

    const totalGroups      = allRaw.length;
    const totalWastedBytes = allRaw.reduce((sum, g) => {
      return sum + Math.round((g.fileCount - 1) * (g.totalSize / g.fileCount));
    }, 0);

    // Apply pagination to the merged list
    const page = allRaw.slice(pageOffset, pageOffset + pageLimit);

    // ── 4. Enrich each group with per-file details ──────────────────────────
    const groups = await Promise.all(page.map(async (raw) => {
      let filesResult;

      if (raw.matchType === "HASH_IDENTICAL") {
        filesResult = await db.execute(sql`
          SELECT
            m.id,
            m.nas_path || '/' || m.relative_path AS path,
            m.name AS filename,
            m.extension,
            m.media_type AS "fileType",
            m.size_bytes AS "sizeBytes",
            m.modified_at AS "modifiedAt",
            regexp_replace(m.relative_path, '[^/]+$', '') AS folder,
            m.content_hash AS "contentHash",
            m.id AS "mediaId",
            m.thumbnail_path AS "thumbnailPath",
            m.width,
            m.height,
            m.duration_seconds AS "durationSeconds",
            m.date_taken     AS "dateTaken",
            m.date_created   AS "dateCreated",
            m.camera_make    AS "cameraMake",
            m.camera_model   AS "cameraModel"
          FROM media_files m
          WHERE m.nas_path = ${nasPath}
            AND m.content_hash = ${raw.groupKey}
             AND ${sql.raw(activeMediaSql("m"))}
          LIMIT 10
        `);
      } else {
        // PERCEPTUAL_SIMILAR: join on quickFingerprint
        filesResult = await db.execute(sql`
          SELECT
            m.id,
            m.nas_path || '/' || m.relative_path AS path,
            m.name AS filename,
            m.extension,
            m.media_type AS "fileType",
            m.size_bytes AS "sizeBytes",
            m.modified_at AS "modifiedAt",
            regexp_replace(m.relative_path, '[^/]+$', '') AS folder,
            m.content_hash AS "contentHash",
            m.id AS "mediaId",
            m.thumbnail_path AS "thumbnailPath",
            m.width,
            m.height,
            m.duration_seconds AS "durationSeconds",
            m.date_taken     AS "dateTaken",
            m.date_created   AS "dateCreated",
            m.camera_make    AS "cameraMake",
            m.camera_model   AS "cameraModel"
          FROM media_files m
          WHERE m.nas_path = ${nasPath}
            AND m.quick_fingerprint = ${raw.groupKey}
             AND ${sql.raw(activeMediaSql("m"))}
          LIMIT 10
        `);
      }

      const wastedBytes = raw.fileCount > 1
        ? Math.round((raw.fileCount - 1) * (raw.totalSize / raw.fileCount))
        : 0;

      return {
        hash:             raw.matchType === "HASH_IDENTICAL"
          ? raw.groupKey
          : `fp:${raw.groupKey}`,
        fileCount:        raw.fileCount,
        totalWastedBytes: wastedBytes,
        matchType:        raw.matchType,
        matchConfidence:  raw.matchConfidence,
        confirmationStatus: raw.confirmationStatus,
        files:            filesResult.rows,
      };
    }));

    res.json({ groups, totalGroups, totalWastedBytes });
  } catch (e: any) {
    console.error("[cleanup/duplicates]", e);
    res.status(500).json({ error: "Failed to get duplicates" });
  }
});

// ── GET /cleanup/large-files ─────────────────────────────────────────────────

router.get("/cleanup/large-files", async (req, res) => {
  try {
    const nasPath = await getConfiguredNasPath();
    if (!nasPath) { res.json({ files: [], total: 0, totalSizeBytes: 0 }); return; }
    const rawLimit = Number.parseInt(String(req.query.limit ?? "50"), 10);
    const rawOffset = Number.parseInt(String(req.query.offset ?? "0"), 10);
    const limit = Math.min(200, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 50));
    const offset = Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0);
    const result = await db.execute(sql`
      SELECT id, nas_path || '/' || relative_path AS path, name AS filename, extension,
             media_type AS "fileType", size_bytes AS "sizeBytes", modified_at AS "modifiedAt",
             regexp_replace(relative_path, '[^/]+$', '') AS folder,
             content_hash AS "contentHash", indexed_at AS "indexedAt"
        FROM ${mediaFilesTable}
       WHERE nas_path = ${nasPath} AND size_bytes >= ${LARGE_FILE_THRESHOLD}
         AND ${activeMediaCondition}
       ORDER BY size_bytes DESC
       LIMIT ${limit} OFFSET ${offset}
    `);
    const totals = await db.execute(sql`
      SELECT COUNT(*) AS total, COALESCE(SUM(size_bytes), 0) AS total_size
        FROM ${mediaFilesTable}
       WHERE nas_path = ${nasPath} AND size_bytes >= ${LARGE_FILE_THRESHOLD}
         AND ${activeMediaCondition}
    `);
    const row = (totals.rows[0] ?? {}) as any;
    res.json({ files: result.rows, total: Number(row.total ?? 0), totalSizeBytes: Number(row.total_size ?? 0) });
  } catch {
    res.status(500).json({ error: "Failed to get large files" });
  }
});

// ── GET /cleanup/old-files ───────────────────────────────────────────────────

router.get("/cleanup/old-files", async (req, res) => {
  try {
    const nasPath = await getConfiguredNasPath();
    if (!nasPath) { res.json({ files: [], total: 0 }); return; }
    const rawLimit = Number.parseInt(String(req.query.limit ?? "50"), 10);
    const rawOffset = Number.parseInt(String(req.query.offset ?? "0"), 10);
    const limit = Math.min(200, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 50));
    const offset = Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0);
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - OLD_FILE_YEARS);
    const result = await db.execute(sql`
      SELECT id, nas_path || '/' || relative_path AS path, name AS filename, extension,
             media_type AS "fileType", size_bytes AS "sizeBytes", modified_at AS "modifiedAt",
             regexp_replace(relative_path, '[^/]+$', '') AS folder,
             content_hash AS "contentHash", indexed_at AS "indexedAt"
        FROM ${mediaFilesTable}
       WHERE nas_path = ${nasPath} AND modified_at <= ${cutoff}
         AND ${activeMediaCondition}
       ORDER BY modified_at ASC
       LIMIT ${limit} OFFSET ${offset}
    `);
    const totals = await db.execute(sql`
      SELECT COUNT(*) AS total
        FROM ${mediaFilesTable}
       WHERE nas_path = ${nasPath} AND modified_at <= ${cutoff}
         AND ${activeMediaCondition}
    `);
    res.json({ files: result.rows, total: Number((totals.rows[0] as any)?.total ?? 0) });
  } catch {
    res.status(500).json({ error: "Failed to get old files" });
  }
});

// ── GET /cleanup/empty-folders ───────────────────────────────────────────────

router.get("/cleanup/empty-folders", async (_req, res) => {
  try {
    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const nasPath = settingsRows[0]?.nasPath ?? "";

    if (!nasPath || !fs.existsSync(nasPath)) {
      res.json([]);
      return;
    }

    const emptyFolders: { path: string; sizeBytes: number }[] = [];

    function findEmptyDirs(dir: string) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const e of entries) {
        if (e.isDirectory()) findEmptyDirs(path.join(dir, e.name));
      }

      const hasFiles = entries.some(e => e.isFile());
      const hasNonEmptySubdirs = entries.some(e => {
        if (!e.isDirectory()) return false;
        try {
          const sub = fs.readdirSync(path.join(dir, e.name));
          return sub.length > 0;
        } catch { return false; }
      });

      if (!hasFiles && !hasNonEmptySubdirs && dir !== nasPath) {
        emptyFolders.push({ path: dir, sizeBytes: 0 });
      }
    }

    findEmptyDirs(nasPath);
    res.json(emptyFolders.slice(0, 200));
  } catch {
    res.status(500).json({ error: "Failed to find empty folders" });
  }
});

// ── GET /cleanup/summary ─────────────────────────────────────────────────────

router.get("/cleanup/summary", async (_req, res) => {
  try {
    const nasPath = await getConfiguredNasPath();
    if (!nasPath) {
      res.json({ duplicateGroups: 0, duplicateWastedBytes: 0, largeFileCount: 0, largeFilesBytes: 0, oldFileCount: 0, emptyFolderCount: 0 });
      return;
    }
    // Exact-hash duplicate groups
    const exactDupResult = await db.execute(sql`
      SELECT COUNT(*) as "dupGroups", COALESCE(SUM(t.wasted), 0) as "dupWasted" FROM (
        SELECT (COUNT(*) - 1) * MAX(size_bytes) as wasted
        FROM ${mediaFilesTable}
         WHERE nas_path = ${nasPath} AND content_hash IS NOT NULL AND ${activeMediaCondition}
        GROUP BY content_hash HAVING COUNT(*) > 1
      ) t
    `);

    // Perceptual-hash duplicate groups (same fingerprint, not all same content_hash)
    const perceptualDupResult = await db.execute(sql`
      SELECT COUNT(*) as "percGroups", COALESCE(SUM(t.wasted), 0) as "percWasted" FROM (
        SELECT (COUNT(DISTINCT m.id) - 1) * MAX(m.size_bytes) AS wasted
        FROM ${mediaFilesTable} m
        WHERE m.nas_path = ${nasPath}
          AND m.quick_fingerprint IS NOT NULL AND m.quick_fingerprint != ''
           AND ${sql.raw(activeMediaSql("m"))}
        GROUP BY m.quick_fingerprint
        HAVING COUNT(DISTINCT m.id) > 1
          AND NOT (
            COUNT(m.content_hash) = COUNT(*)
            AND COUNT(DISTINCT m.content_hash) = 1
          )
      ) t
    `);

    const exactDupGroups  = Number((exactDupResult.rows[0] as any)?.dupGroups  ?? 0);
    const exactDupWasted  = Number((exactDupResult.rows[0] as any)?.dupWasted   ?? 0);
    const percDupGroups   = Number((perceptualDupResult.rows[0] as any)?.percGroups ?? 0);
    const percDupWasted   = Number((perceptualDupResult.rows[0] as any)?.percWasted  ?? 0);

    const dupGroups = exactDupGroups + percDupGroups;
    const dupWasted = exactDupWasted + percDupWasted;

    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - OLD_FILE_YEARS);
    const summaryResult = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE size_bytes >= ${LARGE_FILE_THRESHOLD}) AS large_files,
        COALESCE(SUM(size_bytes) FILTER (WHERE size_bytes >= ${LARGE_FILE_THRESHOLD}), 0) AS large_bytes,
        COUNT(*) FILTER (WHERE modified_at <= ${cutoff}) AS old_files
        FROM ${mediaFilesTable}
       WHERE nas_path = ${nasPath} AND ${activeMediaCondition}
    `);
    const summaryRow = (summaryResult.rows[0] ?? {}) as any;
    const largeFiles = Number(summaryRow.large_files ?? 0);
    const largeBytes = Number(summaryRow.large_bytes ?? 0);
    const oldFiles = Number(summaryRow.old_files ?? 0);

    let emptyFolderCount = 0;
    if (fs.existsSync(nasPath)) {
      const distinctFolders = await db.execute(sql`
        SELECT DISTINCT regexp_replace(relative_path, '[^/]+$', '') AS folder
          FROM ${mediaFilesTable}
         WHERE nas_path = ${nasPath} AND ${activeMediaCondition}
      `);
      for (const row of distinctFolders.rows as any[]) {
        const relativeFolder = String(row.folder ?? "").replace(/^\/+|\/+$/g, "");
        if (relativeFolder) {
          try {
            const folder = resolveLibraryPath(nasPath, relativeFolder);
            const entries = fs.readdirSync(folder);
            if (entries.length === 0) emptyFolderCount++;
          } catch { /* stale rows and missing folders are ignored */ }
        }
      }
    }

    res.json({
      duplicateGroups:       dupGroups,
      duplicateWastedBytes:  dupWasted,
      largeFileCount:        largeFiles,
      largeFilesBytes:       largeBytes,
      oldFileCount:          oldFiles,
      emptyFolderCount,
    });
  } catch {
    res.status(500).json({ error: "Failed to get cleanup summary" });
  }
});

// ── POST /cleanup/execute — move files to Recycle Bin / .Trash ───────────────

router.post("/cleanup/execute", async (req, res) => {
  try {
    const { deleteFileIds } = req.body as { deleteFileIds?: number[] };
    if (
      !Array.isArray(deleteFileIds) ||
      deleteFileIds.length === 0 ||
      deleteFileIds.length > 500 ||
      deleteFileIds.some(id => !Number.isInteger(id) || id <= 0)
    ) {
      res.status(400).json({ error: "deleteFileIds must be a non-empty array" });
      return;
    }

    const nasPath = await getConfiguredNasPath();
    if (!nasPath) {
      res.status(409).json({ error: "No library configured" });
      return;
    }

    let recycled = 0;
    let recoveredBytes = 0;
    const errors: string[] = [];
    const deletedFiles: Array<{ path: string; sizeBytes: number }> = [];
    const trashTimestamp = String(Date.now());

    const uniqueFileIds = [...new Set(deleteFileIds)];
    for (const fileId of uniqueFileIds) {
      try {
        const [file] = await db
          .select()
          .from(mediaFilesTable)
          .where(sql`${mediaFilesTable.id} = ${fileId}
            AND ${mediaFilesTable.nasPath} = ${nasPath}
            AND ${activeMediaCondition}`)
          .limit(1);

        if (!file) {
          errors.push(`File ID ${fileId}: not found in the active library`);
          continue;
        }

        let filePath: string;
        try {
          filePath = resolveLibraryPath(nasPath, file.relativePath);
        } catch {
          errors.push(`File ID ${fileId}: stored path is outside the configured library`);
          continue;
        }
        if (!fs.existsSync(filePath)) {
          errors.push(`File ID ${fileId}: not found on disk (${filePath})`);
          continue;
        }

        const sizeBytes = file.sizeBytes ?? 0;
        const operationId = randomUUID();
        let trashPath: string | null = null;
        await db.execute(sql`
          INSERT INTO cleanup_operations
            (operation_id, nas_path, media_file_id, source_path, size_bytes, status)
          VALUES
            (${operationId}, ${nasPath}, ${fileId}, ${filePath}, ${sizeBytes}, 'PREPARED')
        `);

        if (process.platform === "win32") {
          await db.execute(sql`UPDATE cleanup_operations SET status = 'MOVING', updated_at = NOW() WHERE operation_id = ${operationId}`);
          // Windows: move to OS Recycle Bin via PowerShell (recoverable)
          const psResult = spawnSync("powershell", [
            "-NoProfile", "-Command",
            `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${filePath.replace(/'/g, "''")}','OnlyErrorDialogs','SendToRecycleBin')`,
          ], { encoding: "utf8", stdio: "pipe", timeout: 30_000 });

          if (psResult.status !== 0) {
            await db.execute(sql`UPDATE cleanup_operations SET status = 'FAILED', error = ${(psResult.stderr ?? "").slice(0, 500)}, updated_at = NOW() WHERE operation_id = ${operationId}`);
            errors.push(`File ID ${fileId}: Recycle Bin failed: ${(psResult.stderr ?? "").slice(0, 200)}`);
            continue;
          }
          await db.execute(sql`UPDATE cleanup_operations SET status = 'FILESYSTEM_MOVED', updated_at = NOW() WHERE operation_id = ${operationId}`);
        } else {
          // Linux / Replit: move to WillardAI/.Trash/<timestamp>/ (reversible by user)
          // Prefix filename with fileId to prevent collision when two deleted files share the same basename
          const trashDir = resolveWithinRoot(
            path.join(nasPath, "WillardAI", ".Trash", trashTimestamp),
            getWillardAIDir(nasPath),
          );
          fs.mkdirSync(trashDir, { recursive: true });
          const safeBasename = `${fileId}_${path.basename(file.name)}`;
          trashPath = resolveWithinRoot(path.join(trashDir, safeBasename), trashDir);
          await db.execute(sql`
            UPDATE cleanup_operations
            SET status = 'MOVING', trash_path = ${trashPath}, updated_at = NOW()
            WHERE operation_id = ${operationId}
          `);
          fs.renameSync(filePath, trashPath);
          await db.execute(sql`UPDATE cleanup_operations SET status = 'FILESYSTEM_MOVED', updated_at = NOW() WHERE operation_id = ${operationId}`);

          // Record in trash manifest so user can locate the file later
          appendTrashManifestEntry(nasPath, {
            ts:           new Date().toISOString(),
            nasPath,
            mediaFileId:  fileId,
            relativePath: file.relativePath,
            originalPath: filePath,
            trashPath,
            sizeBytes,
            contentHash:  file.contentHash ?? undefined,
            expiresAt:    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          });
          await db.execute(sql`UPDATE cleanup_operations SET status = 'MANIFESTED', updated_at = NOW() WHERE operation_id = ${operationId}`);
        }

        // Mark media_files row as RECYCLED (soft-delete marker)
        // Use chr(92) for backslash to normalize Windows \ vs POSIX / separators
        const restoredRow = await db.execute(sql`
          UPDATE media_files
          SET last_scan_action = 'RECYCLED'
          WHERE id = ${fileId} AND nas_path = ${nasPath}
        `);
        if (Number(restoredRow.rowCount ?? restoredRow.rows.length) !== 1) {
          throw new Error("File moved to trash but its canonical media row could not be marked RECYCLED");
        }
        await purgeDerivedDataForMedia(nasPath, [fileId]);
        await db.execute(sql`UPDATE cleanup_operations SET status = 'RECORDED', updated_at = NOW() WHERE operation_id = ${operationId}`);

        recycled++;
        recoveredBytes += sizeBytes;
        deletedFiles.push({ path: filePath, sizeBytes });
      } catch (err: any) {
        // The operation id is deliberately not reused across retries. Any
        // PREPARED/MOVING record remains available for startup reconciliation.
        errors.push(`File ID ${fileId}: ${err.message ?? "unknown error"}`);
      }
    }

    // Append session entry to cleanup-history.jsonl
    if (recycled > 0 || errors.length > 0) {
      const logPath = cleanupLogPath(nasPath);
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, JSON.stringify({
        ts:             new Date().toISOString(),
        recycled,
        recoveredBytes,
        platform:       process.platform === "win32" ? "Recycle Bin (Windows)" : "WillardAI/.Trash (Linux)",
        files:          deletedFiles,
        errors,
      }) + "\n");
    }

    res.json({ recycled, recoveredBytes, errors });
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? "Cleanup failed" });
  }
});

// ── GET /cleanup/trash — read trash-manifest.jsonl ───────────────────────────

router.get("/cleanup/trash", async (_req, res) => {
  try {
    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const nasPath = settingsRows[0]?.nasPath ?? "";
    if (!nasPath) {
      res.json({ entries: [] });
      return;
    }

    await purgeExpiredTrashEntries(nasPath);
    const filePath = manifestPath(nasPath);
    if (!fs.existsSync(filePath)) {
      res.json({ entries: [] });
      return;
    }

    const now = Date.now();
    const { entries: manifestEntries } = readTrashManifest(nasPath);
    const entries = manifestEntries.map((e) => ({
      ts:           e.ts,
      nasPath:      e.nasPath,
      mediaFileId:  e.mediaFileId,
      originalPath: e.originalPath,
      trashPath:    e.trashPath,
      sizeBytes:    Number(e.sizeBytes ?? 0),
      contentHash:  e.contentHash,
      expiresAt:    e.expiresAt,
      filename:     path.basename(e.originalPath ?? ""),
      expired:      e.expiresAt ? new Date(e.expiresAt).getTime() < now : false,
    })).reverse(); // newest first

    res.json({ entries });
  } catch {
    res.status(500).json({ error: "Failed to read trash manifest" });
  }
});

// ── POST /cleanup/restore — move file from .Trash back to original path ───────

router.post("/cleanup/restore", async (req, res) => {
  try {
    // Accept trashPath from client; originalPath is intentionally ignored —
    // we derive the destination from the manifest to prevent arbitrary file moves.
    const { trashPath } = req.body as { trashPath?: string };
    if (!trashPath) {
      res.status(400).json({ error: "trashPath is required" });
      return;
    }

    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const nasPath = settingsRows[0]?.nasPath ?? "";
    if (!nasPath) {
      res.status(409).json({ error: "No library configured" });
      return;
    }

    // ── Path constraint: trashPath must resolve under <nasPath>/WillardAI/.Trash ──
    const trashDir = resolveWithinRoot(
      path.join(nasPath, "WillardAI", ".Trash"),
      getWillardAIDir(nasPath),
    );
    let resolvedTrashPath: string;
    try {
      resolvedTrashPath = resolveWithinRoot(trashPath, trashDir);
    } catch {
      res.status(400).json({ error: "Invalid trashPath — must be within the .Trash directory" });
      return;
    }

    // ── Require a manifest entry — do NOT trust client-supplied paths ─────────
    const manifestFilePath = manifestPath(nasPath);
    if (!fs.existsSync(manifestFilePath)) {
      res.status(404).json({ error: "No trash manifest found" });
      return;
    }

    const { entries: manifestEntries } = readTrashManifest(nasPath);
    const entry = manifestEntries.find(e => {
      if (typeof e.nasPath === "string" && e.nasPath !== nasPath) return false;
      try {
        return resolveWithinRoot(e.trashPath, trashDir) === resolvedTrashPath;
      } catch {
        return false;
      }
    });

    if (!entry) {
      res.status(404).json({ error: "File not found in trash manifest — it may have already been restored or permanently removed" });
      return;
    }

    // ── Check expiry ──────────────────────────────────────────────────────────
    if (entry.expiresAt && new Date(String(entry.expiresAt)).getTime() < Date.now()) {
      res.status(409).json({ error: "Entry has expired — the file was permanently removed" });
      return;
    }

    // ── Derive originalPath from manifest (not client-supplied) ───────────────
    const originalPath = entry.originalPath;
    if (!originalPath) {
      res.status(500).json({ error: "Manifest entry is missing originalPath" });
      return;
    }

    // ── originalPath must resolve under nasPath ───────────────────────────────
    let resolvedOriginalPath: string;
    try {
      resolvedOriginalPath = resolveWithinRoot(originalPath, nasPath);
    } catch {
      res.status(400).json({ error: "Cannot restore — destination is outside the configured library" });
      return;
    }

    // ── Destination collision check ───────────────────────────────────────────
    if (fs.existsSync(resolvedOriginalPath)) {
      res.status(409).json({ error: "A file already exists at the restore destination — rename or remove it first" });
      return;
    }

    // ── Verify the file still exists in trash ────────────────────────────────
    if (!fs.existsSync(resolvedTrashPath)) {
      res.status(404).json({ error: "File not found in trash folder — it may have been permanently removed" });
      return;
    }

    const operationId = randomUUID();
    const inserted = await db.execute(sql`
      INSERT INTO cleanup_operations
        (operation_id, nas_path, media_file_id, operation_type, source_path, trash_path, size_bytes, status)
      SELECT ${operationId}, ${nasPath}, id, 'RESTORE', ${resolvedTrashPath}, ${resolvedOriginalPath},
             size_bytes, 'PREPARED'
      FROM media_files
      WHERE nas_path = ${nasPath}
        AND REPLACE(nas_path || '/' || relative_path, chr(92), '/') =
            REPLACE(${resolvedOriginalPath}, chr(92), '/')
        AND last_scan_action = 'RECYCLED'
      LIMIT 1
      RETURNING operation_id, media_file_id, size_bytes, content_hash
    `);
    if (Number(inserted.rowCount ?? inserted.rows.length) !== 1) {
      await db.execute(sql`
        INSERT INTO cleanup_operations
          (operation_id, nas_path, media_file_id, operation_type, source_path, trash_path, size_bytes, status, error)
        VALUES
          (${operationId}, ${nasPath}, NULL, 'RESTORE', ${resolvedTrashPath}, ${resolvedOriginalPath},
           ${Number(entry.sizeBytes ?? 0)}, 'NEEDS_REVIEW',
           'Restore manifest has no matching RECYCLED canonical media row')
      `);
      res.status(409).json({ error: "Cannot restore — the manifest has no matching RECYCLED canonical media row" });
      return;
    }
    const insertedRow = inserted.rows[0] as {
      media_file_id: number;
      size_bytes: number;
      content_hash: string | null;
    };
    const expectedSize = Number(insertedRow.size_bytes ?? entry.sizeBytes ?? 0);
    const manifestHash = typeof entry.contentHash === "string" ? entry.contentHash : null;
    if (manifestHash && insertedRow.content_hash && manifestHash !== insertedRow.content_hash) {
      await db.execute(sql`
        UPDATE cleanup_operations SET status = 'NEEDS_REVIEW',
          error = 'Restore manifest hash disagrees with the canonical media row', updated_at = NOW()
        WHERE operation_id = ${operationId}
      `);
      res.status(409).json({ error: "Cannot restore — manifest metadata is stale" });
      return;
    }
    const expectedHash = insertedRow.content_hash ?? manifestHash;
    await db.execute(sql`
      UPDATE cleanup_operations SET status = 'MOVING', updated_at = NOW()
      WHERE operation_id = ${operationId}
    `);

    // ── Ensure destination directory exists ───────────────────────────────────
    const destinationDir = resolveWithinRoot(path.dirname(resolvedOriginalPath), nasPath);
    fs.mkdirSync(destinationDir, { recursive: true });

    // ── Verify and move file back ──────────────────────────────────────────────
    const verifyFile = async (filePath: string) => {
      const stat = fs.statSync(filePath);
      if (stat.size !== expectedSize) throw new Error("Restored file size does not match the canonical media row");
      if (expectedHash && await sha256File(filePath) !== expectedHash) {
        throw new Error("Restored file hash does not match the canonical media row");
      }
    };
    await verifyFile(resolvedTrashPath);
    fs.renameSync(resolvedTrashPath, resolvedOriginalPath);
    try {
      await verifyFile(resolvedOriginalPath);
    } catch (error) {
      try { fs.renameSync(resolvedOriginalPath, resolvedTrashPath); } catch { /* recovery will flag the conflict */ }
      await db.execute(sql`
        UPDATE cleanup_operations SET status = 'NEEDS_REVIEW',
          error = ${error instanceof Error ? error.message : "Restored file verification failed"},
          updated_at = NOW() WHERE operation_id = ${operationId}
      `);
      res.status(409).json({ error: "Restore verification failed; no canonical state was changed" });
      return;
    }
    await db.execute(sql`
      UPDATE cleanup_operations SET status = 'FILESYSTEM_MOVED', updated_at = NOW()
      WHERE operation_id = ${operationId}
    `);

    // ── Clear RECYCLED marker so the next scan re-indexes the file normally ────
    const cleared = await db.execute(sql`
      UPDATE media_files
      SET last_scan_action = NULL
      WHERE id = ${insertedRow.media_file_id}
        AND nas_path = ${nasPath}
        AND last_scan_action = 'RECYCLED'
    `);
    if (Number(cleared.rowCount ?? cleared.rows.length) !== 1) {
      await db.execute(sql`
        UPDATE cleanup_operations SET status = 'NEEDS_REVIEW',
          error = 'Restored file exists but the canonical recycle marker could not be cleared',
          updated_at = NOW() WHERE operation_id = ${operationId}
      `);
      res.status(409).json({ error: "Restore requires review — the canonical media row changed during restore" });
      return;
    }
    await db.execute(sql`
      UPDATE cleanup_operations SET status = 'DB_RECONCILED', updated_at = NOW()
      WHERE operation_id = ${operationId}
    `);
    removeTrashManifestEntry(nasPath, resolvedTrashPath, operationId);
    await db.execute(sql`
      UPDATE cleanup_operations SET status = 'RECORDED', updated_at = NOW()
      WHERE operation_id = ${operationId}
    `);

    res.json({ restored: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? "Restore failed" });
  }
});

// ── GET /cleanup/history — read cleanup-history.jsonl ────────────────────────

router.get("/cleanup/history", async (_req, res) => {
  try {
    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const nasPath = settingsRows[0]?.nasPath ?? "";
    if (!nasPath) {
      res.json({ sessions: [] });
      return;
    }

    const logPath = cleanupLogPath(nasPath);
    if (!fs.existsSync(logPath)) {
      res.json({ sessions: [] });
      return;
    }

    const lines  = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    const sessions = lines
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean)
      .reverse()  // newest first
      .slice(0, 50);

    res.json({ sessions });
  } catch {
    res.status(500).json({ error: "Failed to read cleanup history" });
  }
});

// Unused import suppression
void archivesTable;

export default router;
