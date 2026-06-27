import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { indexedFilesTable, archivesTable } from "@workspace/db";
import { sql, count, gte, lte, desc, isNotNull } from "drizzle-orm";

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

    const [{ totalGroups }] = await db.execute(sql`
      SELECT COUNT(*) as "totalGroups" FROM (
        SELECT content_hash FROM ${indexedFilesTable} WHERE content_hash IS NOT NULL GROUP BY content_hash HAVING COUNT(*) > 1
      ) t
    `) as any;

    const [{ totalWasted }] = await db.execute(sql`
      SELECT COALESCE(SUM(t.wasted), 0) as "totalWasted" FROM (
        SELECT (COUNT(*) - 1) * MAX(size_bytes) as wasted FROM ${indexedFilesTable} WHERE content_hash IS NOT NULL GROUP BY content_hash HAVING COUNT(*) > 1
      ) t
    `) as any;

    const groups = await Promise.all((dupHashes.rows as any[]).map(async (row) => {
      const files = await db.select().from(indexedFilesTable)
        .where(sql`${indexedFilesTable.contentHash} = ${row.content_hash}`)
        .limit(10);
      return {
        hash: row.content_hash,
        fileCount: parseInt(row.file_count),
        totalWastedBytes: (parseInt(row.file_count) - 1) * Number(row.total_size) / parseInt(row.file_count),
        files,
      };
    }));

    res.json({ groups, totalGroups: parseInt((totalGroups as any)?.totalGroups ?? 0), totalWastedBytes: Number(totalWasted?.totalWasted ?? 0) });
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
  res.json([]);
});

router.get("/cleanup/summary", async (_req, res) => {
  try {
    const [{ dupGroups }] = await db.execute(sql`
      SELECT COUNT(*) as "dupGroups" FROM (
        SELECT content_hash FROM ${indexedFilesTable} WHERE content_hash IS NOT NULL GROUP BY content_hash HAVING COUNT(*) > 1
      ) t
    `) as any;
    const [{ dupWasted }] = await db.execute(sql`
      SELECT COALESCE(SUM(t.wasted), 0) as "dupWasted" FROM (
        SELECT (COUNT(*) - 1) * MAX(size_bytes) as wasted FROM ${indexedFilesTable} WHERE content_hash IS NOT NULL GROUP BY content_hash HAVING COUNT(*) > 1
      ) t
    `) as any;
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - OLD_FILE_YEARS);
    const [{ largeFiles }] = await db.select({ largeFiles: count() }).from(indexedFilesTable).where(gte(indexedFilesTable.sizeBytes, LARGE_FILE_THRESHOLD));
    const [{ largeBytes }] = await db.select({ largeBytes: sql<number>`COALESCE(SUM(${indexedFilesTable.sizeBytes}), 0)` }).from(indexedFilesTable).where(gte(indexedFilesTable.sizeBytes, LARGE_FILE_THRESHOLD));
    const [{ oldFiles }] = await db.select({ oldFiles: count() }).from(indexedFilesTable).where(lte(indexedFilesTable.modifiedAt, cutoff));

    res.json({
      duplicateGroups: parseInt((dupGroups as any)?.dupGroups ?? 0),
      duplicateWastedBytes: Number(dupWasted?.dupWasted ?? 0),
      largeFileCount: largeFiles,
      largeFilesBytes: Number(largeBytes),
      oldFileCount: oldFiles,
      emptyFolderCount: 0,
    });
  } catch {
    res.status(500).json({ error: "Failed to get cleanup summary" });
  }
});

export default router;
