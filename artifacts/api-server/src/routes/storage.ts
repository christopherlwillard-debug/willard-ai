import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { indexedFilesTable, appSettingsTable } from "@workspace/db";
import { sql, count, desc } from "drizzle-orm";

const router: IRouter = Router();

router.get("/storage", async (_req, res) => {
  try {
    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const nasPathConfigured = !!(settingsRows[0]?.nasPath);

    const [totals] = await db.select({
      totalSizeBytes: sql<number>`COALESCE(SUM(${indexedFilesTable.sizeBytes}), 0)`,
      fileCount: count(),
    }).from(indexedFilesTable);

    const typeBreakdown = await db.select({
      fileType: indexedFilesTable.fileType,
      count: count(),
      sizeBytes: sql<number>`COALESCE(SUM(${indexedFilesTable.sizeBytes}), 0)`,
    }).from(indexedFilesTable).groupBy(indexedFilesTable.fileType);

    const total = Number(totals.totalSizeBytes) || 1;
    const breakdown = typeBreakdown.map(r => ({
      fileType: r.fileType,
      count: r.count,
      sizeBytes: Number(r.sizeBytes),
      percentage: Math.round((Number(r.sizeBytes) / total) * 100 * 10) / 10,
    }));

    res.json({ totalSizeBytes: Number(totals.totalSizeBytes) || 0, fileCount: totals.fileCount, typeBreakdown: breakdown, nasPathConfigured });
  } catch {
    res.status(500).json({ error: "Failed to get storage stats" });
  }
});

router.get("/storage/top-folders", async (_req, res) => {
  try {
    const folders = await db.select({
      folder: indexedFilesTable.folder,
      fileCount: count(),
      totalSizeBytes: sql<number>`COALESCE(SUM(${indexedFilesTable.sizeBytes}), 0)`,
    }).from(indexedFilesTable).groupBy(indexedFilesTable.folder)
      .orderBy(desc(sql`COALESCE(SUM(${indexedFilesTable.sizeBytes}), 0)`))
      .limit(20);

    res.json(folders.map(f => ({ folder: f.folder, fileCount: f.fileCount, totalSizeBytes: Number(f.totalSizeBytes) })));
  } catch {
    res.status(500).json({ error: "Failed to get top folders" });
  }
});

router.get("/storage/top-files", async (_req, res) => {
  try {
    const files = await db.select().from(indexedFilesTable)
      .orderBy(desc(indexedFilesTable.sizeBytes))
      .limit(20);
    res.json(files);
  } catch {
    res.status(500).json({ error: "Failed to get top files" });
  }
});

export default router;
