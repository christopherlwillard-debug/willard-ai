import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { mediaFilesTable, appSettingsTable } from "@workspace/db";
import { sql, count, desc, and, eq } from "drizzle-orm";
import { activeMediaCondition } from "../lib/media-scope.ts";

const router: IRouter = Router();

const ACTIVE_MEDIA = activeMediaCondition;

async function getNasPath(): Promise<string | null> {
  const [row] = await db.select({ nasPath: appSettingsTable.nasPath }).from(appSettingsTable).limit(1);
  const nasPath = row?.nasPath?.trim();
  return nasPath || null;
}

router.get("/storage", async (_req, res) => {
  try {
    const nasPath = await getNasPath();
    const nasPathConfigured = !!nasPath;
    if (!nasPath) {
      return res.json({ totalSizeBytes: 0, fileCount: 0, typeBreakdown: [], nasPathConfigured: false });
    }
    const scoped = and(ACTIVE_MEDIA, eq(mediaFilesTable.nasPath, nasPath));

    const [totals] = await db.select({
      totalSizeBytes: sql<number>`COALESCE(SUM(${mediaFilesTable.sizeBytes}), 0)`,
      fileCount: count(),
    }).from(mediaFilesTable).where(scoped);

    const typeBreakdown = await db.select({
      fileType: mediaFilesTable.mediaType,
      count: count(),
      sizeBytes: sql<number>`COALESCE(SUM(${mediaFilesTable.sizeBytes}), 0)`,
    }).from(mediaFilesTable).where(scoped).groupBy(mediaFilesTable.mediaType);

    const total = Number(totals.totalSizeBytes) || 1;
    const breakdown = typeBreakdown.map(r => ({
      fileType: r.fileType === "photo" ? "image" : r.fileType,
      count: r.count,
      sizeBytes: Number(r.sizeBytes),
      percentage: Math.round((Number(r.sizeBytes) / total) * 100 * 10) / 10,
    }));

    return res.json({ totalSizeBytes: Number(totals.totalSizeBytes) || 0, fileCount: totals.fileCount, typeBreakdown: breakdown, nasPathConfigured });
  } catch {
    return res.status(500).json({ error: "Failed to get storage stats" });
  }
});

router.get("/storage/top-folders", async (_req, res) => {
  try {
    const nasPath = await getNasPath();
    if (!nasPath) return res.json([]);
    const folders = await db.select({
      folder: sql<string>`CASE WHEN ${mediaFilesTable.relativePath} LIKE '%/%' THEN split_part(${mediaFilesTable.relativePath}, '/', 1) ELSE '/' END`,
      fileCount: count(),
      totalSizeBytes: sql<number>`COALESCE(SUM(${mediaFilesTable.sizeBytes}), 0)`,
    }).from(mediaFilesTable)
      .where(and(ACTIVE_MEDIA, eq(mediaFilesTable.nasPath, nasPath)))
      .groupBy(sql`CASE WHEN ${mediaFilesTable.relativePath} LIKE '%/%' THEN split_part(${mediaFilesTable.relativePath}, '/', 1) ELSE '/' END`)
      .orderBy(desc(sql`COALESCE(SUM(${mediaFilesTable.sizeBytes}), 0)`))
      .limit(20);

    return res.json(folders.map(f => ({ folder: f.folder, fileCount: f.fileCount, totalSizeBytes: Number(f.totalSizeBytes) })));
  } catch {
    return res.status(500).json({ error: "Failed to get top folders" });
  }
});

router.get("/storage/top-files", async (_req, res) => {
  try {
    const nasPath = await getNasPath();
    if (!nasPath) return res.json([]);
    const files = await db.select({
      id:        mediaFilesTable.id,
      filename:  mediaFilesTable.name,
      path:      mediaFilesTable.relativePath,
      fileType:  mediaFilesTable.mediaType,
      sizeBytes: mediaFilesTable.sizeBytes,
      folder:    mediaFilesTable.relativePath,
    }).from(mediaFilesTable)
      .where(and(ACTIVE_MEDIA, eq(mediaFilesTable.nasPath, nasPath)))
      .orderBy(desc(mediaFilesTable.sizeBytes))
      .limit(20);
    return res.json(files);
  } catch {
    return res.status(500).json({ error: "Failed to get top files" });
  }
});

export default router;
