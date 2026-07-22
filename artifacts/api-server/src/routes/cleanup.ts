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

    const dupHashes = await db.execute(sql`
      SELECT content_hash, COUNT(*) as file_count, SUM(size_bytes) as total_size
      FROM ${indexedFilesTable}
      WHERE content_hash IS NOT NULL
      GROUP BY content_hash
      HAVING COUNT(*) > 1
      ORDER BY SUM(size_bytes) DESC
      LIMIT ${parseInt(limit)}
      OFFSET ${parseInt(offset)}
    `);

    const totalGroupsResult = await db.execute(sql`
      SELECT COUNT(*) as "totalGroups" FROM (
        SELECT content_hash FROM ${indexedFilesTable}
        WHERE content_hash IS NOT NULL GROUP BY content_hash HAVING COUNT(*) > 1
      ) t
    `);

    const totalWastedResult = await db.execute(sql`
      SELECT COALESCE(SUM(t.wasted), 0) as "totalWasted" FROM (
        SELECT (COUNT(*) - 1) * MAX(size_bytes) as wasted
        FROM ${indexedFilesTable}
        WHERE content_hash IS NOT NULL GROUP BY content_hash HAVING COUNT(*) > 1
      ) t
    `);

    const totalGroups = (totalGroupsResult.rows[0] as any)?.totalGroups ?? 0;
    const totalWasted  = (totalWastedResult.rows[0] as any)?.totalWasted ?? 0;

    const groups = await Promise.all((dupHashes.rows as any[]).map(async (row) => {
      // LEFT JOIN with media_files to enrich with thumbnails, dimensions, dates, camera model
      const filesResult = await db.execute(sql`
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
        WHERE i.content_hash = ${row.content_hash}
        LIMIT 10
      `);

      const fileCount = parseInt(row.file_count);
      const totalSize = Number(row.total_size);
      return {
        hash:              row.content_hash,
        fileCount,
        totalWastedBytes:  fileCount > 1
          ? Math.round((fileCount - 1) * (totalSize / fileCount))
          : 0,
        matchType:         "HASH_IDENTICAL",
        matchConfidence:   5,
        files:             filesResult.rows,
      };
    }));

    res.json({
      groups,
      totalGroups:      parseInt(totalGroups),
      totalWastedBytes: Number(totalWasted),
    });
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
    const dupGroupsResult = await db.execute(sql`
      SELECT COUNT(*) as "dupGroups" FROM (
        SELECT content_hash FROM ${indexedFilesTable}
        WHERE content_hash IS NOT NULL GROUP BY content_hash HAVING COUNT(*) > 1
      ) t
    `);
    const dupWastedResult = await db.execute(sql`
      SELECT COALESCE(SUM(t.wasted), 0) as "dupWasted" FROM (
        SELECT (COUNT(*) - 1) * MAX(size_bytes) as wasted
        FROM ${indexedFilesTable}
        WHERE content_hash IS NOT NULL GROUP BY content_hash HAVING COUNT(*) > 1
      ) t
    `);

    const dupGroups = (dupGroupsResult.rows[0] as any)?.dupGroups ?? 0;
    const dupWasted  = (dupWastedResult.rows[0] as any)?.dupWasted ?? 0;

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
      duplicateGroups:       parseInt(dupGroups),
      duplicateWastedBytes:  Number(dupWasted),
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
void mediaFilesTable;

export default router;
