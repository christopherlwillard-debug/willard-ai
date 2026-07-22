import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { indexedFilesTable, archivesTable, appSettingsTable, mediaFilesTable } from "@workspace/db";
import { sql, count, gte, lte, desc, eq } from "drizzle-orm";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

const router: IRouter = Router();

const LARGE_FILE_THRESHOLD = 500 * 1024 * 1024; // 500MB
const OLD_FILE_YEARS = 5;

function cleanupLogPath(nasPath: string) {
  return path.join(nasPath, "WillardAI", "logs", "cleanup-history.jsonl");
}

function trashManifestPath(nasPath: string) {
  return path.join(nasPath, "WillardAI", "logs", "trash-manifest.jsonl");
}

// ── GET /cleanup/duplicates — enriched with mediaFilesTable data ───────────

router.get("/cleanup/duplicates", async (req, res) => {
  try {
    const { limit = "20", offset = "0" } = req.query as Record<string, string>;
    const pageLimit  = parseInt(limit);
    const pageOffset = parseInt(offset);

    // ── 1. Exact-hash groups ────────────────────────────────────────────────
    const exactHashGroups = await db.execute(sql`
      SELECT content_hash AS group_key, COUNT(*) as file_count, SUM(size_bytes) as total_size
      FROM ${indexedFilesTable}
      WHERE content_hash IS NOT NULL
      GROUP BY content_hash
      HAVING COUNT(*) > 1
    `);

    // ── 2. Perceptual-hash groups (same quickFingerprint, different hashes) ─
    // Join media_files (has quickFingerprint) with indexed_files (has path/size for wasted bytes).
    // Exclude fingerprint groups where all files share a single non-null content_hash
    // (those are already surfaced by the exact-hash query above).
    const perceptualGroups = await db.execute(sql`
      SELECT
        m.quick_fingerprint AS group_key,
        COUNT(DISTINCT m.id) AS file_count,
        SUM(i.size_bytes)   AS total_size
      FROM ${mediaFilesTable} m
      JOIN ${indexedFilesTable} i
        ON REPLACE(i.path, chr(92), '/') =
           REPLACE(m.nas_path || '/' || m.relative_path, chr(92), '/')
      WHERE m.quick_fingerprint IS NOT NULL
        AND m.quick_fingerprint != ''
      GROUP BY m.quick_fingerprint
      HAVING COUNT(DISTINCT m.id) > 1
        AND NOT (
          COUNT(DISTINCT i.content_hash) = 1
          AND MIN(i.content_hash) IS NOT NULL
        )
    `);

    // ── 3. Build raw group descriptors sorted by wasted bytes desc ──────────
    type RawGroup = {
      groupKey: string;
      fileCount: number;
      totalSize: number;
      matchType: "HASH_IDENTICAL" | "PERCEPTUAL_SIMILAR";
      matchConfidence: number;
    };

    const allRaw: RawGroup[] = [
      ...(exactHashGroups.rows as any[]).map(r => ({
        groupKey:        String(r.group_key),
        fileCount:       parseInt(r.file_count),
        totalSize:       Number(r.total_size),
        matchType:       "HASH_IDENTICAL" as const,
        matchConfidence: 5,
      })),
      ...(perceptualGroups.rows as any[]).map(r => ({
        groupKey:        String(r.group_key),
        fileCount:       parseInt(r.file_count),
        totalSize:       Number(r.total_size),
        matchType:       "PERCEPTUAL_SIMILAR" as const,
        matchConfidence: 4,
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
            i.id,
            i.path,
            i.filename,
            i.extension,
            i.file_type      AS "fileType",
            i.size_bytes     AS "sizeBytes",
            i.modified_at    AS "modifiedAt",
            i.folder,
            i.content_hash   AS "contentHash",
            m.id             AS "mediaId",
            m.thumbnail_path AS "thumbnailPath",
            m.width,
            m.height,
            m.duration_seconds AS "durationSeconds",
            m.date_taken     AS "dateTaken",
            m.date_created   AS "dateCreated",
            m.camera_make    AS "cameraMake",
            m.camera_model   AS "cameraModel"
          FROM indexed_files i
          LEFT JOIN media_files m
            ON REPLACE(i.path, chr(92), '/') = REPLACE(m.nas_path || '/' || m.relative_path, chr(92), '/')
          WHERE i.content_hash = ${raw.groupKey}
          LIMIT 10
        `);
      } else {
        // PERCEPTUAL_SIMILAR: join on quickFingerprint
        filesResult = await db.execute(sql`
          SELECT
            i.id,
            i.path,
            i.filename,
            i.extension,
            i.file_type      AS "fileType",
            i.size_bytes     AS "sizeBytes",
            i.modified_at    AS "modifiedAt",
            i.folder,
            i.content_hash   AS "contentHash",
            m.id             AS "mediaId",
            m.thumbnail_path AS "thumbnailPath",
            m.width,
            m.height,
            m.duration_seconds AS "durationSeconds",
            m.date_taken     AS "dateTaken",
            m.date_created   AS "dateCreated",
            m.camera_make    AS "cameraMake",
            m.camera_model   AS "cameraModel"
          FROM media_files m
          JOIN indexed_files i
            ON REPLACE(i.path, chr(92), '/') = REPLACE(m.nas_path || '/' || m.relative_path, chr(92), '/')
          WHERE m.quick_fingerprint = ${raw.groupKey}
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
    const { limit = "50", offset = "0" } = req.query as Record<string, string>;
    const [{ total }] = await db.select({ total: count() }).from(indexedFilesTable).where(gte(indexedFilesTable.sizeBytes, LARGE_FILE_THRESHOLD));
    const [{ totalBytes }] = await db.select({ totalBytes: sql<number>`COALESCE(SUM(${indexedFilesTable.sizeBytes}), 0)` }).from(indexedFilesTable).where(gte(indexedFilesTable.sizeBytes, LARGE_FILE_THRESHOLD));
    const files = await db.select().from(indexedFilesTable)
      .where(gte(indexedFilesTable.sizeBytes, LARGE_FILE_THRESHOLD))
      .orderBy(desc(indexedFilesTable.sizeBytes))
      .limit(parseInt(limit))
      .offset(parseInt(offset));
    res.json({ files, total, totalSizeBytes: Number(totalBytes) });
  } catch {
    res.status(500).json({ error: "Failed to get large files" });
  }
});

// ── GET /cleanup/old-files ───────────────────────────────────────────────────

router.get("/cleanup/old-files", async (req, res) => {
  try {
    const { limit = "50", offset = "0" } = req.query as Record<string, string>;
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - OLD_FILE_YEARS);
    const [{ total }] = await db.select({ total: count() }).from(indexedFilesTable).where(lte(indexedFilesTable.modifiedAt, cutoff));
    const files = await db.select().from(indexedFilesTable)
      .where(lte(indexedFilesTable.modifiedAt, cutoff))
      .orderBy(indexedFilesTable.modifiedAt)
      .limit(parseInt(limit))
      .offset(parseInt(offset));
    res.json({ files, total });
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
    // Exact-hash duplicate groups
    const exactDupResult = await db.execute(sql`
      SELECT COUNT(*) as "dupGroups", COALESCE(SUM(t.wasted), 0) as "dupWasted" FROM (
        SELECT (COUNT(*) - 1) * MAX(size_bytes) as wasted
        FROM ${indexedFilesTable}
        WHERE content_hash IS NOT NULL GROUP BY content_hash HAVING COUNT(*) > 1
      ) t
    `);

    // Perceptual-hash duplicate groups (same fingerprint, not all same content_hash)
    const perceptualDupResult = await db.execute(sql`
      SELECT COUNT(*) as "percGroups", COALESCE(SUM(t.wasted), 0) as "percWasted" FROM (
        SELECT (COUNT(DISTINCT m.id) - 1) * MAX(i.size_bytes) AS wasted
        FROM ${mediaFilesTable} m
        JOIN ${indexedFilesTable} i
          ON REPLACE(i.path, chr(92), '/') =
             REPLACE(m.nas_path || '/' || m.relative_path, chr(92), '/')
        WHERE m.quick_fingerprint IS NOT NULL AND m.quick_fingerprint != ''
        GROUP BY m.quick_fingerprint
        HAVING COUNT(DISTINCT m.id) > 1
          AND NOT (
            COUNT(DISTINCT i.content_hash) = 1
            AND MIN(i.content_hash) IS NOT NULL
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
    const [{ largeFiles }] = await db.select({ largeFiles: count() }).from(indexedFilesTable).where(gte(indexedFilesTable.sizeBytes, LARGE_FILE_THRESHOLD));
    const [{ largeBytes }] = await db.select({ largeBytes: sql<number>`COALESCE(SUM(${indexedFilesTable.sizeBytes}), 0)` }).from(indexedFilesTable).where(gte(indexedFilesTable.sizeBytes, LARGE_FILE_THRESHOLD));
    const [{ oldFiles }] = await db.select({ oldFiles: count() }).from(indexedFilesTable).where(lte(indexedFilesTable.modifiedAt, cutoff));

    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const nasPath = settingsRows[0]?.nasPath ?? "";
    let emptyFolderCount = 0;
    if (nasPath && fs.existsSync(nasPath)) {
      const distinctFolders = await db.execute(sql`SELECT DISTINCT folder FROM ${indexedFilesTable}`);
      for (const row of distinctFolders.rows as any[]) {
        const folder = row.folder as string;
        if (folder && fs.existsSync(folder)) {
          try {
            const entries = fs.readdirSync(folder);
            if (entries.length === 0) emptyFolderCount++;
          } catch { }
        }
      }
    }

    res.json({
      duplicateGroups:       dupGroups,
      duplicateWastedBytes:  dupWasted,
      largeFileCount:        largeFiles,
      largeFilesBytes:       Number(largeBytes),
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
    if (!Array.isArray(deleteFileIds) || deleteFileIds.length === 0) {
      res.status(400).json({ error: "deleteFileIds must be a non-empty array" });
      return;
    }

    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const nasPath = settingsRows[0]?.nasPath ?? "";
    if (!nasPath) {
      res.status(409).json({ error: "No library configured" });
      return;
    }

    let recycled = 0;
    let recoveredBytes = 0;
    const errors: string[] = [];
    const deletedFiles: Array<{ path: string; sizeBytes: number }> = [];
    const trashTimestamp = String(Date.now());

    for (const fileId of deleteFileIds) {
      try {
        const [file] = await db
          .select()
          .from(indexedFilesTable)
          .where(eq(indexedFilesTable.id, fileId))
          .limit(1);

        if (!file) {
          errors.push(`File ID ${fileId}: not found in index`);
          continue;
        }

        const filePath = file.path;
        if (!fs.existsSync(filePath)) {
          errors.push(`File ID ${fileId}: not found on disk (${filePath})`);
          continue;
        }

        const sizeBytes = file.sizeBytes ?? 0;

        if (process.platform === "win32") {
          // Windows: move to OS Recycle Bin via PowerShell (recoverable)
          const psResult = spawnSync("powershell", [
            "-NoProfile", "-Command",
            `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${filePath.replace(/'/g, "''")}','OnlyErrorDialogs','SendToRecycleBin')`,
          ], { encoding: "utf8", stdio: "pipe", timeout: 30_000 });

          if (psResult.status !== 0) {
            errors.push(`File ID ${fileId}: Recycle Bin failed: ${(psResult.stderr ?? "").slice(0, 200)}`);
            continue;
          }
        } else {
          // Linux / Replit: move to WillardAI/.Trash/<timestamp>/ (reversible by user)
          // Prefix filename with fileId to prevent collision when two deleted files share the same basename
          const trashDir = path.join(nasPath, "WillardAI", ".Trash", trashTimestamp);
          fs.mkdirSync(trashDir, { recursive: true });
          const safeBasename = `${fileId}_${file.filename}`;
          const destPath = path.join(trashDir, safeBasename);
          fs.renameSync(filePath, destPath);

          // Record in trash manifest so user can locate the file later
          const manifestPath = trashManifestPath(nasPath);
          fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
          fs.appendFileSync(manifestPath, JSON.stringify({
            ts:           new Date().toISOString(),
            originalPath: filePath,
            trashPath:    destPath,
            sizeBytes,
            expiresAt:    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          }) + "\n");
        }

        // Mark media_files row as RECYCLED (soft-delete marker)
        // Use chr(92) for backslash to normalize Windows \ vs POSIX / separators
        await db.execute(sql`
          UPDATE media_files
          SET last_scan_action = 'RECYCLED'
          WHERE REPLACE(nas_path || '/' || relative_path, chr(92), '/') = REPLACE(${filePath}, chr(92), '/')
        `);

        recycled++;
        recoveredBytes += sizeBytes;
        deletedFiles.push({ path: filePath, sizeBytes });
      } catch (err: any) {
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
