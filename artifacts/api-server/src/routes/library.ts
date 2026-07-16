import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { libraryJobsTable, appSettingsTable, mediaFilesTable } from "@workspace/db";
import { eq, desc, and, lt, sql, gte } from "drizzle-orm";
import {
  getActiveJobId, getJobProgress, getLastCompletedProgress, startJob, requestPause, requestCancel, resumeJob,
} from "../lib/library-engine";
import { runLibraryCheck, getLibraryHealthSnapshot, acknowledgeReconnect } from "../lib/library-monitor";
import { SCANNER_VERSION } from "../lib/library-engine/types";

const router = Router();

async function getNasPath(): Promise<string | null> {
  const [row] = await db.select({ nasPath: appSettingsTable.nasPath }).from(appSettingsTable).limit(1);
  return row?.nasPath ?? null;
}

// ── GET /api/library/health — smart library health snapshot ──────────────────

router.get("/library/health", async (_req: Request, res: Response) => {
  const health = getLibraryHealthSnapshot();
  const activeId = getActiveJobId();
  const activeJob = activeId !== null ? getJobProgress(activeId) : null;
  const lastCompleted = activeId === null ? getLastCompletedProgress() : null;
  const [row] = await db.select({ lastScanAt: appSettingsTable.lastScanAt })
    .from(appSettingsTable).limit(1);
  res.json({
    ...health,
    lastScanAt: row?.lastScanAt?.toISOString() ?? null,
    activeJob,
    lastCompleted,
  });
});

// ── POST /api/library/retry — user-triggered "Retry Now" reachability check ──

router.post("/library/retry", async (_req: Request, res: Response) => {
  const health = await runLibraryCheck();
  res.json(health);
});

// ── POST /api/library/reconnect-ack — dismiss the one-time reconnect banner ──

router.post("/library/reconnect-ack", (_req: Request, res: Response) => {
  acknowledgeReconnect();
  res.json({ ok: true });
});

// ── POST /api/library/indexing/pause | resume — user-facing indexing switch ──

router.post("/library/indexing/pause", async (_req: Request, res: Response) => {
  await db.update(appSettingsTable).set({ indexingPaused: true });
  const activeId = getActiveJobId();
  if (activeId !== null) requestPause(activeId);
  res.json({ ok: true, indexingPaused: true });
});

router.post("/library/indexing/resume", async (_req: Request, res: Response) => {
  await db.update(appSettingsTable).set({ indexingPaused: false });
  // Resume the most recent paused job, if any.
  const [paused] = await db.select().from(libraryJobsTable)
    .where(eq(libraryJobsTable.status, "PAUSED"))
    .orderBy(desc(libraryJobsTable.createdAt))
    .limit(1);
  let resumedJobId: number | null = null;
  if (paused) {
    const ok = await resumeJob(paused.id);
    if (ok) resumedJobId = paused.id;
  }
  res.json({ ok: true, indexingPaused: false, resumedJobId });
});

// ── POST /api/library/scan — start a scan job ────────────────────────────────

router.post("/library/scan", async (req: Request, res: Response) => {
  const nasPath = await getNasPath();
  if (!nasPath) {
    res.status(400).json({ error: "NAS path not configured. Visit Settings to configure it." });
    return;
  }

  const profile = (req.body?.profile as string) ?? "QUICK";
  const rootPath = req.body?.rootPath as string | undefined;

  const result = await startJob({
    jobType: "SCAN",
    profile: profile as any,
    nasPath,
    rootPath,
  });

  res.json(result);
});

// ── GET /api/library/jobs/active — live progress of the running job ───────────

router.get("/library/jobs/active", async (_req: Request, res: Response) => {
  const activeId = getActiveJobId();
  if (activeId === null) {
    // No running job — surface the most recent completion (with summary) so
    // the UI can show the scan-summary card after the job finishes.
    res.json(getLastCompletedProgress());
    return;
  }
  const progress = getJobProgress(activeId);
  res.json(progress);
});

// ── GET /api/library/jobs — paginated job history ────────────────────────────

router.get("/library/jobs", async (req: Request, res: Response) => {
  const nasPath = await getNasPath();
  const type    = req.query["type"] as string | undefined;
  const limit   = Math.min(100, parseInt(req.query["limit"] as string) || 20);

  const conditions = [];
  if (nasPath) conditions.push(eq(libraryJobsTable.nasPath, nasPath));
  if (type)    conditions.push(eq(libraryJobsTable.jobType, type));

  const jobs = await db.select().from(libraryJobsTable)
    .where(conditions.length === 1 ? conditions[0] : conditions.length > 1 ? and(...conditions) : undefined)
    .orderBy(desc(libraryJobsTable.createdAt))
    .limit(limit);

  res.json({ jobs });
});

// ── GET /api/library/jobs/:id — single job ────────────────────────────────────

router.get("/library/jobs/:id", async (req: Request, res: Response) => {
  const id = parseInt(req.params["id"] as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  // Check in-memory first for live progress
  const liveProgress = getJobProgress(id);
  if (liveProgress) { res.json({ ...liveProgress, fromMemory: true }); return; }

  const [job] = await db.select().from(libraryJobsTable)
    .where(eq(libraryJobsTable.id, id)).limit(1);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  res.json(job);
});

// ── POST /api/library/jobs/:id/pause ─────────────────────────────────────────

router.post("/library/jobs/:id/pause", async (req: Request, res: Response) => {
  const id = parseInt(req.params["id"] as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const ok = requestPause(id);
  res.json({ ok, jobId: id });
});

// ── POST /api/library/jobs/:id/resume ────────────────────────────────────────

router.post("/library/jobs/:id/resume", async (req: Request, res: Response) => {
  const id = parseInt(req.params["id"] as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const ok = await resumeJob(id);
  if (!ok) { res.status(400).json({ error: "Job not found or not paused" }); return; }
  res.json({ ok, jobId: id });
});

// ── POST /api/library/jobs/:id/cancel ────────────────────────────────────────

router.post("/library/jobs/:id/cancel", async (req: Request, res: Response) => {
  const id = parseInt(req.params["id"] as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const reason = req.body?.reason ?? "USER_CANCELLED";
  const ok = requestCancel(id, reason);
  res.json({ ok, jobId: id });
});

// ── POST /api/library/thumbnails — start a thumbnail backfill job ─────────────

router.post("/library/thumbnails", async (req: Request, res: Response) => {
  const nasPath = await getNasPath();
  if (!nasPath) {
    res.status(400).json({ error: "NAS path not configured." });
    return;
  }

  const result = await startJob({
    jobType: "THUMBNAILS",
    profile: "FULL",
    nasPath,
  });

  res.json(result);
});

// ── GET /api/library/jobs/:id/files?action=NEW — files touched by a scan ──────
// Uses the scan's time anchor (summary.scanStartedAt) so the summary counts are
// clickable: each count maps to the exact files behind it.

router.get("/library/jobs/:id/files", async (req: Request, res: Response) => {
  const id = parseInt(req.params["id"] as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const action = (req.query["action"] as string | undefined)?.toUpperCase();
  const allowed = new Set(["NEW", "MODIFIED", "MOVED", "DELETED", "UNCHANGED"]);
  if (!action || !allowed.has(action)) {
    res.status(400).json({ error: "Query param 'action' must be one of NEW, MODIFIED, MOVED, DELETED, UNCHANGED" });
    return;
  }
  const limit = Math.min(500, parseInt(req.query["limit"] as string) || 100);

  const [job] = await db.select().from(libraryJobsTable)
    .where(eq(libraryJobsTable.id, id)).limit(1);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }

  const summary = (job.summary ?? {}) as { scanStartedAt?: string };
  if (!summary.scanStartedAt) {
    res.json({ files: [], note: "This job has no per-file details (older scan)." });
    return;
  }
  const anchor = new Date(summary.scanStartedAt);

  const files = await db.select({
    id: mediaFilesTable.id,
    relativePath: mediaFilesTable.relativePath,
    name: mediaFilesTable.name,
    mediaType: mediaFilesTable.mediaType,
    sizeBytes: mediaFilesTable.sizeBytes,
    modifiedAt: mediaFilesTable.modifiedAt,
  }).from(mediaFilesTable)
    .where(and(
      eq(mediaFilesTable.nasPath, job.nasPath),
      eq(mediaFilesTable.lastScanAction, action),
      gte(mediaFilesTable.lastScannedAt, anchor),
    ))
    .orderBy(desc(mediaFilesTable.modifiedAt))
    .limit(limit);

  res.json({ files });
});

// ── GET /api/library/duplicates — confirmed duplicate groups ──────────────────

router.get("/library/duplicates", async (_req: Request, res: Response) => {
  const nasPath = await getNasPath();
  if (!nasPath) { res.json({ groups: [] }); return; }

  const rows = await db.select({
    id: mediaFilesTable.id,
    relativePath: mediaFilesTable.relativePath,
    name: mediaFilesTable.name,
    mediaType: mediaFilesTable.mediaType,
    sizeBytes: mediaFilesTable.sizeBytes,
    contentHash: mediaFilesTable.contentHash,
  }).from(mediaFilesTable)
    .where(and(
      eq(mediaFilesTable.nasPath, nasPath),
      sql`${mediaFilesTable.lastScanAction} IS DISTINCT FROM 'DELETED'`,
      sql`${mediaFilesTable.contentHash} IN (
        SELECT content_hash FROM media_files
        WHERE nas_path = ${nasPath}
          AND content_hash IS NOT NULL
          AND (last_scan_action IS DISTINCT FROM 'DELETED')
        GROUP BY content_hash HAVING count(*) > 1
      )`,
    ))
    .orderBy(desc(mediaFilesTable.sizeBytes));

  const byHash = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.contentHash) continue;
    const g = byHash.get(row.contentHash);
    if (g) g.push(row); else byHash.set(row.contentHash, [row]);
  }
  const groups = [...byHash.entries()].map(([hash, files]) => ({
    contentHash: hash,
    sizeBytes: files[0]!.sizeBytes,
    count: files.length,
    files: files.map(({ contentHash: _h, ...rest }) => rest),
  }));

  res.json({ groups });
});

// ── GET /api/library/outdated — count of items with an older scanner version ──

router.get("/library/outdated", async (_req: Request, res: Response) => {
  const nasPath = await getNasPath();
  if (!nasPath) { res.json({ count: 0, scannerVersion: SCANNER_VERSION }); return; }

  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
    .from(mediaFilesTable)
    .where(and(
      eq(mediaFilesTable.nasPath, nasPath),
      lt(mediaFilesTable.scannerVersion, SCANNER_VERSION),
      sql`${mediaFilesTable.lastScanAction} IS DISTINCT FROM 'DELETED'`,
    ));

  res.json({ count: count ?? 0, scannerVersion: SCANNER_VERSION });
});

// ── POST /api/library/reprocess — selective metadata re-processing ────────────

router.post("/library/reprocess", async (_req: Request, res: Response) => {
  const nasPath = await getNasPath();
  if (!nasPath) {
    res.status(400).json({ error: "NAS path not configured." });
    return;
  }

  const result = await startJob({
    jobType: "METADATA",
    profile: "FULL",
    nasPath,
  });

  res.json(result);
});

export default router;
