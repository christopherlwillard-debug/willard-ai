import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { indexedFilesTable, archivesTable, appSettingsTable } from "@workspace/db";
import { sql, count, gte, lte, desc } from "drizzle-orm";
import * as fs from "fs";
import * as path from "path";

const router: IRouter = Router();

const LARGE_FILE_THRESHOLD = 500 * 1024 * 1024; // 500MB
const OLD_FILE_YEARS = 5;

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
        SELECT content_hash FROM ${indexedFilesTable} WHERE content_hash IS NOT NULL GROUP BY content_hash HAVING COUNT(*) > 1
      ) t
    `);

    const totalWastedResult = await db.execute(sql`
      SELECT COALESCE(SUM(t.wasted), 0) as "totalWasted" FROM (
        SELECT (COUNT(*) - 1) * MAX(size_bytes) as wasted FROM ${indexedFilesTable} WHERE content_hash IS NOT NULL GROUP BY content_hash HAVING COUNT(*) > 1
      ) t
    `);

    const totalGroups = (totalGroupsResult.rows[0] as any)?.totalGroups ?? 0;
    const totalWasted = (totalWastedResult.rows[0] as any)?.totalWasted ?? 0;

    const groups = await Promise.all((dupHashes.rows as any[]).map(async (row) => {
      const files = await db.select().from(indexedFilesTable)
        .where(sql`${indexedFilesTable.contentHash} = ${row.content_hash}`)
        .limit(10);
      const fileCount = parseInt(row.file_count);
      const totalSize = Number(row.total_size);
      return {
        hash: row.content_hash,
        fileCount,
        totalWastedBytes: fileCount > 1 ? Math.round((fileCount - 1) * (totalSize / fileCount)) : 0,
        files,
      };
    }));

    res.json({ groups, totalGroups: parseInt(totalGroups), totalWastedBytes: Number(totalWasted) });
  } catch {
    res.status(500).json({ error: "Failed to get duplicates" });
  }
});

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

      // Recurse into subdirectories first
      for (const e of entries) {
        if (e.isDirectory()) {
          findEmptyDirs(path.join(dir, e.name));
        }
      }

      // A folder is "empty" if it has no files (may still have subdirs that are all empty)
      const hasFiles = entries.some(e => e.isFile());
      const hasNonEmptySubdirs = entries.some(e => {
        if (!e.isDirectory()) return false;
        try {
          const sub = fs.readdirSync(path.join(dir, e.name));
          return sub.length > 0;
        } catch {
          return false;
        }
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

router.get("/cleanup/summary", async (_req, res) => {
  try {
    const dupGroupsResult = await db.execute(sql`
      SELECT COUNT(*) as "dupGroups" FROM (
        SELECT content_hash FROM ${indexedFilesTable} WHERE content_hash IS NOT NULL GROUP BY content_hash HAVING COUNT(*) > 1
      ) t
    `);
    const dupWastedResult = await db.execute(sql`
      SELECT COALESCE(SUM(t.wasted), 0) as "dupWasted" FROM (
        SELECT (COUNT(*) - 1) * MAX(size_bytes) as wasted FROM ${indexedFilesTable} WHERE content_hash IS NOT NULL GROUP BY content_hash HAVING COUNT(*) > 1
      ) t
    `);

    const dupGroups = (dupGroupsResult.rows[0] as any)?.dupGroups ?? 0;
    const dupWasted = (dupWastedResult.rows[0] as any)?.dupWasted ?? 0;

    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - OLD_FILE_YEARS);
    const [{ largeFiles }] = await db.select({ largeFiles: count() }).from(indexedFilesTable).where(gte(indexedFilesTable.sizeBytes, LARGE_FILE_THRESHOLD));
    const [{ largeBytes }] = await db.select({ largeBytes: sql<number>`COALESCE(SUM(${indexedFilesTable.sizeBytes}), 0)` }).from(indexedFilesTable).where(gte(indexedFilesTable.sizeBytes, LARGE_FILE_THRESHOLD));
    const [{ oldFiles }] = await db.select({ oldFiles: count() }).from(indexedFilesTable).where(lte(indexedFilesTable.modifiedAt, cutoff));

    // Count empty folders from DB-tracked paths that no longer have any files under them
    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const nasPath = settingsRows[0]?.nasPath ?? "";
    let emptyFolderCount = 0;
    if (nasPath && fs.existsSync(nasPath)) {
      const distinctFolders = await db.execute(sql`
        SELECT DISTINCT folder FROM ${indexedFilesTable}
      `);
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
      duplicateGroups: parseInt(dupGroups),
      duplicateWastedBytes: Number(dupWasted),
      largeFileCount: largeFiles,
      largeFilesBytes: Number(largeBytes),
      oldFileCount: oldFiles,
      emptyFolderCount,
    });
  } catch {
    res.status(500).json({ error: "Failed to get cleanup summary" });
  }
});

// Unused import suppression
void archivesTable;

export default router;
