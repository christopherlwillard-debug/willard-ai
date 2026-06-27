import { Router, type IRouter } from "express";
import { execFileSync } from "child_process";
import { db } from "@workspace/db";
import { indexedFilesTable, archivesTable, scanJobsTable, appSettingsTable } from "@workspace/db";
import { eq, sql, count } from "drizzle-orm";

const router: IRouter = Router();

function getDiskStats(dirPath: string): { total: number; used: number; free: number } | null {
  // Validate path to reject null bytes or obviously invalid values before passing to execFileSync
  if (!dirPath || dirPath.includes("\0") || dirPath.length > 4096) return null;
  try {
    // Use execFileSync (array args) — NOT shell interpolation — to avoid injection risk
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

async function getImmichStats(baseUrl: string, apiKey: string) {
  if (!baseUrl || !apiKey) return { photoCount: 0, videoCount: 0, connected: false };
  try {
    const url = `${baseUrl.replace(/\/$/, "")}/api/server/statistics`;
    const r = await fetch(url, { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { photoCount: 0, videoCount: 0, connected: false };
    const data = await r.json() as any;
    return { photoCount: data.photos ?? 0, videoCount: data.videos ?? 0, connected: true };
  } catch {
    return { photoCount: 0, videoCount: 0, connected: false };
  }
}

router.get("/dashboard", async (_req, res) => {
  try {
    const [totalRow] = await db.select({
      totalFiles: count(),
      totalSizeBytes: sql<number>`COALESCE(SUM(${indexedFilesTable.sizeBytes}), 0)`,
    }).from(indexedFilesTable);

    const [archiveCountRow] = await db.select({ count: count() }).from(archivesTable);

    const [docCountRow] = await db.select({ count: count() }).from(indexedFilesTable)
      .where(eq(indexedFilesTable.fileType, "document"));

    const typeBreakdown = await db.select({
      fileType: indexedFilesTable.fileType,
      count: count(),
      sizeBytes: sql<number>`COALESCE(SUM(${indexedFilesTable.sizeBytes}), 0)`,
    }).from(indexedFilesTable).groupBy(indexedFilesTable.fileType);

    const total = Number(totalRow.totalSizeBytes) || 1;
    const breakdown = typeBreakdown.map(r => ({
      fileType: r.fileType,
      count: r.count,
      sizeBytes: Number(r.sizeBytes),
      percentage: Math.round((Number(r.sizeBytes) / total) * 100 * 10) / 10,
    }));

    const dupQuery = await db.execute(
      sql`SELECT COUNT(*) as cnt FROM (SELECT content_hash FROM ${indexedFilesTable} WHERE content_hash IS NOT NULL GROUP BY content_hash HAVING COUNT(*) > 1) t`
    );
    const duplicateCount = Number((dupQuery.rows[0] as any)?.cnt ?? 0);

    const runningJob = await db.select().from(scanJobsTable)
      .where(eq(scanJobsTable.status, "running")).limit(1);

    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const settings = settingsRows[0];
    const immich = await getImmichStats(settings?.immichBaseUrl ?? "", settings?.immichApiKey ?? "");

    const nasPath = settings?.nasPath || "/";
    const diskStats = getDiskStats(nasPath);

    res.json({
      totalFiles: totalRow.totalFiles,
      totalSizeBytes: Number(totalRow.totalSizeBytes) || 0,
      archiveCount: archiveCountRow.count,
      documentCount: docCountRow.count,
      duplicateCount,
      isScanning: runningJob.length > 0,
      lastScanAt: settings?.lastScanAt ?? null,
      typeBreakdown: breakdown,
      immichPhotoCount: immich.photoCount,
      immichVideoCount: immich.videoCount,
      immichConnected: immich.connected,
      diskTotal: diskStats?.total ?? null,
      diskUsed: diskStats?.used ?? null,
      diskFree: diskStats?.free ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to get dashboard data" });
  }
});

export default router;
