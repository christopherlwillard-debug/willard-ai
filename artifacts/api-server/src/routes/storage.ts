import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { mediaFilesTable, appSettingsTable } from "@workspace/db";
import { sql, count, desc, and } from "drizzle-orm";

const router: IRouter = Router();

const NOT_DELETED = sql`${mediaFilesTable.lastScanAction} IS DISTINCT FROM 'DELETED'`;

router.get("/storage", async (_req, res) => {
  try {
    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const nasPathConfigured = !!(settingsRows[0]?.nasPath);

    const [totals] = await db.select({
      totalSizeBytes: sql<number>`COALESCE(SUM(${mediaFilesTable.sizeBytes}), 0)`,
      fileCount: count(),
    }).from(mediaFilesTable).where(NOT_DELETED);

    const typeBreakdown = await db.select({
      fileType: mediaFilesTable.mediaType,
      count: count(),
      sizeBytes: sql<number>`COALESCE(SUM(${mediaFilesTable.sizeBytes}), 0)`,
    }).from(mediaFilesTable).where(NOT_DELETED).groupBy(mediaFilesTable.mediaType);

    const total = Number(totals.totalSizeBytes) || 1;
    const breakdown = typeBreakdown.map(r => ({
      fileType: r.fileType === "photo" ? "image" : r.fileType,
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
      folder: sql<string>`CASE WHEN ${mediaFilesTable.relativePath} LIKE '%/%' THEN split_part(${mediaFilesTable.relativePath}, '/', 1) ELSE '/' END`,
      fileCount: count(),
      totalSizeBytes: sql<number>`COALESCE(SUM(${mediaFilesTable.sizeBytes}), 0)`,
    }).from(mediaFilesTable)
      .where(NOT_DELETED)
      .groupBy(sql`CASE WHEN ${mediaFilesTable.relativePath} LIKE '%/%' THEN split_part(${mediaFilesTable.relativePath}, '/', 1) ELSE '/' END`)
      .orderBy(desc(sql`COALESCE(SUM(${mediaFilesTable.sizeBytes}), 0)`))
      .limit(20);

    res.json(folders.map(f => ({ folder: f.folder, fileCount: f.fileCount, totalSizeBytes: Number(f.totalSizeBytes) })));
  } catch {
    res.status(500).json({ error: "Failed to get top folders" });
  }
});

router.get("/storage/top-files", async (_req, res) => {
  try {
    const files = await db.select({
      id:        mediaFilesTable.id,
      filename:  mediaFilesTable.name,
      path:      mediaFilesTable.relativePath,
      fileType:  mediaFilesTable.mediaType,
      sizeBytes: mediaFilesTable.sizeBytes,
      folder:    mediaFilesTable.relativePath,
    }).from(mediaFilesTable)
      .where(NOT_DELETED)
      .orderBy(desc(mediaFilesTable.sizeBytes))
      .limit(20);
    res.json(files);
  } catch {
    res.status(500).json({ error: "Failed to get top files" });
  }
});

export default router;
