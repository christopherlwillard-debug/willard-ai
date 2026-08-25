import { Router, type IRouter } from "express";
import { execFile } from "child_process";
import { promisify } from "util";
import { db } from "@workspace/db";
// libraryJobsTable is the SINGLE AUTHORITATIVE SOURCE for library job state.
// scanJobsTable is the LEGACY scan engine table — kept here only for the debug
// endpoint. No production isScanning logic may read from scanJobsTable.
import { mediaFilesTable, archivesTable, scanJobsTable, libraryJobsTable, appSettingsTable, organizationJobsTable } from "@workspace/db";
import { eq, sql, count, and } from "drizzle-orm";
import { checkNasReachableAsync, type NasReachability } from "../lib/nas-storage";
import { getEnrichmentStatus } from "../lib/ai-enrichment";
import { getFaceStatus } from "../lib/face-recognition";

const execFileAsync = promisify(execFile);
const router: IRouter = Router();

const NOT_DELETED = sql`${mediaFilesTable.lastScanAction} IS DISTINCT FROM 'DELETED'`;

// ── NAS reachability cache ─────────────────────────────────────────────────────
// The dashboard is polled every 3 seconds while isScanning = true.  Caching for
// 5 seconds prevents a blocking NAS stat call on every poll cycle.
let _nasCache: { path: string; result: NasReachability; expiresAt: number } | null = null;

async function getCachedNasReachability(nasPath: string): Promise<NasReachability> {
  if (_nasCache && _nasCache.path === nasPath && _nasCache.expiresAt > Date.now()) {
    return _nasCache.result;
  }
  const result = await checkNasReachableAsync(nasPath);
  _nasCache = { path: nasPath, result, expiresAt: Date.now() + 5_000 };
  return result;
}

// ── Disk stats (async) ─────────────────────────────────────────────────────────
// Runs `df -B1` in a child process so the event loop is never blocked.
async function getDiskStats(dirPath: string): Promise<{ total: number; used: number; free: number } | null> {
  if (!dirPath || dirPath.includes("\0") || dirPath.length > 4096) return null;
  try {
    const { stdout } = await execFileAsync("df", ["-B1", dirPath], { timeout: 2000 });
    const lines = stdout.trim().split("\n");
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

// ── Dashboard ──────────────────────────────────────────────────────────────────

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

    // isScanning — authoritative source: libraryJobsTable with status "RUNNING".
    // Covers all job types: SCAN, THUMBNAILS, METADATA.  The legacy scanJobsTable
    // (routes/scan.ts) is intentionally NOT read here — it uses a different status
    // enum ("running" lowercase) and a different table, causing permanent stuck state
    // when old rows were left in "running" status.
    const [runningLibraryJob] = await db.select({ id: libraryJobsTable.id })
      .from(libraryJobsTable)
      .where(eq(libraryJobsTable.status, "RUNNING"))
      .limit(1);
    const isScanning = !!runningLibraryJob;

    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const settings = settingsRows[0];
    const nasPath = settings?.nasPath ?? "";

    // Async + cached NAS reachability — never blocks the event loop.
    const reach = await getCachedNasReachability(nasPath);
    const diskStats = reach.online ? await getDiskStats(reach.path) : null;

    res.json({
      totalFiles: totalRow.totalFiles,
      totalSizeBytes: Number(totalRow.totalSizeBytes) || 0,
      archiveCount: archiveCountRow.count,
      documentCount: docCountRow.count,
      duplicateCount,
      duplicateSizeBytes,
      incomingCount,
      isScanning,
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

// ── Debug: library state ───────────────────────────────────────────────────────
// GET /api/debug/library-state
//
// Returns a complete snapshot of both job tables' status counts, the computed
// isScanning value with its authoritative source, and background-worker status.
// Use this endpoint to diagnose "scanning forever" and other stuck-state issues
// without needing to inspect logs or run raw SQL.
//
// Example: curl http://localhost:8080/api/debug/library-state
router.get("/debug/library-state", async (_req, res) => {
  try {
    // libraryJobsTable counts by status (current engine — authoritative)
    const libResult = await db.execute(
      sql`SELECT status, COUNT(*) AS cnt FROM library_jobs GROUP BY status ORDER BY status`
    );
    const libraryJobs: Record<string, number> = {};
    for (const r of libResult.rows as { status: string; cnt: string }[]) {
      libraryJobs[r.status] = Number(r.cnt);
    }

    // scanJobsTable counts by status (legacy engine — scan.ts)
    const scanResult = await db.execute(
      sql`SELECT status, COUNT(*) AS cnt FROM scan_jobs GROUP BY status ORDER BY status`
    ).catch(() => ({ rows: [] as { status: string; cnt: string }[] }));
    const scanJobs: Record<string, number> = {};
    for (const r of scanResult.rows as { status: string; cnt: string }[]) {
      scanJobs[r.status] = Number(r.cnt);
    }

    const runningCount    = libraryJobs["RUNNING"] ?? 0;
    const legacyRunning   = scanJobs["running"]    ?? 0;

    let enrichment: Record<string, unknown> = {};
    let faces: Record<string, unknown> = {};
    try {
      const e = getEnrichmentStatus();
      enrichment = { pending: e.pending, analyzed: e.analyzed, running: e.running, lastRunAt: e.lastRunAt };
    } catch { /* module may not have initialised yet */ }
    try {
      const f = getFaceStatus();
      faces = { pending: f.pending, scanned: f.scanned, running: f.running, lastRunAt: f.lastRunAt };
    } catch { /* module may not have initialised yet */ }

    res.json({
      libraryJobs,
      scanJobs,
      computed: {
        isScanning:           runningCount > 0,
        source:               "libraryJobsTable",
        runningJobCount:      runningCount,
        legacyRunningCount:   legacyRunning,
        note: legacyRunning > 0
          ? `Legacy scan_jobs has ${legacyRunning} stuck 'running' row(s) — drained at next server restart`
          : "No stuck legacy scan jobs",
      },
      enrichment,
      faces,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to get library state" });
  }
});

export default router;
