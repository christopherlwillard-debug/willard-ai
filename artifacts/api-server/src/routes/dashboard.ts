import { Router, type IRouter } from "express";
import { execFileSync } from "child_process";
import { db } from "@workspace/db";
import { mediaFilesTable, archivesTable, scanJobsTable, appSettingsTable, organizationJobsTable } from "@workspace/db";
import { eq, sql, count, and } from "drizzle-orm";
import { checkNasReachable } from "../lib/nas-storage";

const router: IRouter = Router();

const NOT_DELETED = sql`${mediaFilesTable.lastScanAction} IS DISTINCT FROM 'DELETED'`;

function getDiskStats(dirPath: string): { total: number; used: number; free: number } | null {
  if (!dirPath || dirPath.includes("\0") || dirPath.length > 4096) return null;
  try {
    const output = execFileSync("df", ["-B1", dirPath], { timeout: 2000, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
    const lines = output.split("\n");
    const lastLine = lines[lines.length - 1].trim();
    const parts = lastLine.split(/\s+/);
    if (parts.length < 4) return null;
    const total = parseInt(parts[1]) || 0;
    const used = parseInt(parts[2]) || 0;
    const free = parseInt(parts[3]) || 0;
    if (!total) return null;
    return { total, used, free };
  } catch {
    return null;
  }
}

router.get("/dashboard", async (_req, res) => {
  try {
    const [totalRow] = await db.select({
      totalFiles: count(),
      totalSizeBytes: sql<number>`COALESCE(SUM(${mediaFilesTable.sizeBytes}), 0)`,
    }).from(mediaFilesTable).where(NOT_DELETED);

    const [archiveCountRow] = await db.select({ count: count() }).from(archivesTable);

    const [docCountRow] = await db.select({ count: count() }).from(mediaFilesTable)
      .where(and(NOT_DELETED, eq(mediaFilesTable.mediaType, "document")));

    const typeBreakdown = await db.select({
      fileType: mediaFilesTable.mediaType,
      count: count(),
      sizeBytes: sql<number>`COALESCE(SUM(${mediaFilesTable.sizeBytes}), 0)`,
    }).from(mediaFilesTable).where(NOT_DELETED).groupBy(mediaFilesTable.mediaType);

    const total = Number(totalRow.totalSizeBytes) || 1;
    const breakdown = typeBreakdown.map(r => ({
      fileType: r.fileType === "photo" ? "image" : r.fileType,
      count: r.count,
      sizeBytes: Number(r.sizeBytes),
      percentage: Math.round((Number(r.sizeBytes) / total) * 100 * 10) / 10,
    }));

    const dupQuery = await db.execute(
      sql`SELECT COUNT(*) as cnt FROM (SELECT content_hash FROM ${mediaFilesTable} WHERE content_hash IS NOT NULL AND (last_scan_action IS DISTINCT FROM 'DELETED') GROUP BY content_hash HAVING COUNT(*) > 1) t`
    );
    const duplicateCount = Number((dupQuery.rows[0] as any)?.cnt ?? 0);

    const dupSizeQuery = await db.execute(
      sql`SELECT COALESCE(SUM(size_bytes), 0) as total_size FROM ${mediaFilesTable} WHERE (last_scan_action IS DISTINCT FROM 'DELETED') AND content_hash IN (SELECT content_hash FROM ${mediaFilesTable} WHERE content_hash IS NOT NULL AND (last_scan_action IS DISTINCT FROM 'DELETED') GROUP BY content_hash HAVING COUNT(*) > 1)`
    );
    const duplicateSizeBytes = Number((dupSizeQuery.rows[0] as any)?.total_size ?? 0);

    const [incomingRow] = await db.select({ count: count() }).from(organizationJobsTable)
      .where(eq(organizationJobsTable.status, "pending"));
    const incomingCount = incomingRow?.count ?? 0;

    const runningJob = await db.select().from(scanJobsTable)
      .where(eq(scanJobsTable.status, "running")).limit(1);

    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const settings = settingsRows[0];
    const nasPath = settings?.nasPath ?? "";
    const reach = checkNasReachable(nasPath);
    const diskStats = reach.online ? getDiskStats(reach.path) : null;

    res.json({
      totalFiles: totalRow.totalFiles,
      totalSizeBytes: Number(totalRow.totalSizeBytes) || 0,
      archiveCount: archiveCountRow.count,
      documentCount: docCountRow.count,
      duplicateCount,
      duplicateSizeBytes,
      incomingCount,
      isScanning: runningJob.length > 0,
      lastScanAt: settings?.lastScanAt ?? null,
      typeBreakdown: breakdown,
      diskTotal: diskStats?.total ?? null,
      diskUsed: diskStats?.used ?? null,
      diskFree: diskStats?.free ?? null,
      libraryOnline: reach.online,
      libraryPath: reach.path,
      libraryMessage: reach.message,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to get dashboard data" });
  }
});

export default router;
