import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { libraryJobsTable, appSettingsTable, mediaFilesTable } from "@workspace/db";
import { eq, desc, and, lt, sql, gte, inArray, isNull, or } from "drizzle-orm";
import {
  getActiveJobId, getJobProgress, getLastCompletedProgress, startJob, requestPause, requestCancel, resumeJob,
  addThumbnailPriority,
} from "../lib/library-engine";
import { getThumbnailCacheSizeBytes, clearThumbnailCache } from "../lib/thumbnail-engine";
import { runLibraryCheck, getLibraryHealthSnapshot, acknowledgeReconnect } from "../lib/library-monitor";
import { getWatcherSnapshot } from "../lib/library-watcher";
import { getRecentActivity, recordActivity } from "../lib/library-activity";
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
    watcher: getWatcherSnapshot(),
  });
});

// ── GET /api/library/activity — friendly Library Activity feed ───────────────

router.get("/library/activity", async (req: Request, res: Response) => {
  const nasPath = await getNasPath();
  if (!nasPath) { res.json({ entries: [] }); return; }
  const limit = Math.min(100, parseInt(req.query["limit"] as string) || 20);
  const entries = await getRecentActivity(nasPath, limit);
  res.json({ entries });
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
  const nasPath = await getNasPath();
  if (nasPath) void recordActivity(nasPath, "paused", "Indexing paused — live watching is on hold until you resume.");
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
  const nasPath = await getNasPath();
  if (nasPath) void recordActivity(nasPath, "resumed", "Indexing resumed — watching for library changes again.");
  res.json({ ok: true, indexingPaused: false, resumedJobId });
});

// ── POST /api/library/scan/dry-run — preview what a full scan would touch ────

router.post("/library/scan/dry-run", async (_req: Request, res: Response) => {
  const nasPath = await getNasPath();
  if (!nasPath) {
    res.status(400).json({ error: "NAS path not configured" });
    return;
  }

  try {
    // Load current scanner settings
    const [settingsRow] = await db.select({
      ignoredFolders:    appSettingsTable.ignoredFolders,
      ignoredExtensions: appSettingsTable.ignoredExtensions,
      ignoreHiddenFiles:  appSettingsTable.ignoreHiddenFiles,
      ignoreSystemFiles:  appSettingsTable.ignoreSystemFiles,
      ignoreTempFiles:    appSettingsTable.ignoreTempFiles,
      ignoreSidecarFiles: appSettingsTable.ignoreSidecarFiles,
      ignoreEmptyFolders: appSettingsTable.ignoreEmptyFolders,
      followSymlinks:     appSettingsTable.followSymlinks,
      indexOtherFiles:    appSettingsTable.indexOtherFiles,
    }).from(appSettingsTable).limit(1);

    const { walkNas } = await import("../lib/library-engine/indexer");
    const { getWillardAIDir } = await import("../lib/nas-storage");
    const fs = await import("fs");
    const path = await import("path");

    try { fs.statSync(nasPath); } catch {
      res.status(503).json({ error: "NAS is offline" });
      return;
    }

    const scannerSettings = {
      ignoredFolders:    settingsRow?.ignoredFolders    ?? [],
      ignoredExtensions: settingsRow?.ignoredExtensions ?? [],
      ignoreHiddenFiles:  settingsRow?.ignoreHiddenFiles  ?? true,
      ignoreSystemFiles:  settingsRow?.ignoreSystemFiles  ?? true,
      ignoreTempFiles:    settingsRow?.ignoreTempFiles    ?? true,
      ignoreSidecarFiles: settingsRow?.ignoreSidecarFiles ?? true,
      ignoreEmptyFolders: settingsRow?.ignoreEmptyFolders ?? false,
      followSymlinks:     settingsRow?.followSymlinks     ?? false,
      indexOtherFiles:    settingsRow?.indexOtherFiles    ?? true,
    };

    const willardDir = path.resolve(getWillardAIDir(nasPath));
    const skipDirs   = new Set([willardDir]);
    const files: Array<{ fullPath: string; name: string; ext: string; sizeBytes: number; modifiedAt: Date }> = [];

    // Fixed schema — canonical skip-reason keys, all initialized to 0
    const skipped = {
      system_file:          0,
      hidden_file:          0,
      user_ignored_folder:  0,
      user_ignored_extension: 0,
      system_directory:     0,
      other_type_excluded:  0,
    };

    walkNas(
      path.resolve(nasPath),
      skipDirs,
      files,
      undefined,
      (_skippedPath, reason) => {
        if (Object.prototype.hasOwnProperty.call(skipped, reason)) {
          (skipped as Record<string, number>)[reason]++;
        }
        // read-error strings are intentionally excluded from the breakdown
      },
      undefined,
      undefined,
      undefined,
      path.resolve(nasPath),
      scannerSettings,
    );

    res.json({ wouldScan: files.length, skipped });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Dry-run failed" });
  }
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

// ── GET /api/library/thumbnails/status — thumbnail cache stats ────────────────

router.get("/library/thumbnails/status", async (_req: Request, res: Response) => {
  const nasPath = await getNasPath();
  if (!nasPath) {
    res.json({ total: 0, built: 0, missing: 0, cacheSizeBytes: 0, activeJob: null });
    return;
  }

  const eligibleFilter = and(
    eq(mediaFilesTable.nasPath, nasPath),
    or(
      eq(mediaFilesTable.mediaType, "photo"),
      eq(mediaFilesTable.mediaType, "video"),
      eq(mediaFilesTable.extension, "pdf"),
    ),
    sql`${mediaFilesTable.lastScanAction} IS DISTINCT FROM 'DELETED'`,
  );

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(mediaFilesTable)
    .where(eligibleFilter);

  const [{ built }] = await db
    .select({ built: sql<number>`count(*)::int` })
    .from(mediaFilesTable)
    .where(and(eligibleFilter, sql`${mediaFilesTable.thumbnailPath} IS NOT NULL`));

  const cacheSizeBytes = getThumbnailCacheSizeBytes(nasPath);

  const totalNum = total ?? 0;
  const builtNum = built ?? 0;

  res.json({
    total: totalNum,
    built: builtNum,
    missing: Math.max(0, totalNum - builtNum),
    cacheSizeBytes,
    activeJob: null,
  });
});

// ── POST /api/library/thumbnails/prioritize — boost a folder to front ─────────

router.post("/library/thumbnails/prioritize", async (req: Request, res: Response) => {
  const nasPath = await getNasPath();
  if (!nasPath) {
    res.status(400).json({ error: "NAS path not configured." });
    return;
  }

  const folder = req.body?.folder as string | undefined;
  if (!folder) {
    res.status(400).json({ error: "folder is required" });
    return;
  }

  // Find files in this folder without thumbnails
  const folderPrefix = folder.replace(/^\//, "");
  const files = await db.select({ id: mediaFilesTable.id })
    .from(mediaFilesTable)
    .where(and(
      eq(mediaFilesTable.nasPath, nasPath),
      isNull(mediaFilesTable.thumbnailPath),
      or(
        eq(mediaFilesTable.mediaType, "photo"),
        eq(mediaFilesTable.mediaType, "video"),
        eq(mediaFilesTable.extension, "pdf"),
      ),
      sql`relative_path LIKE ${folderPrefix + "/%"}`,
    ))
    .limit(500);

  if (files.length > 0) {
    addThumbnailPriority(nasPath, files.map(f => f.id));
  }

  res.json({ boosted: files.length, folder });
});

// ── DELETE /api/library/thumbnails/cache — wipe thumbnail cache ───────────────

router.delete("/library/thumbnails/cache", async (_req: Request, res: Response) => {
  const nasPath = await getNasPath();
  if (!nasPath) {
    res.status(400).json({ error: "NAS path not configured." });
    return;
  }

  const deleted = clearThumbnailCache(nasPath);

  // Reset thumbnailPath in DB so the backfill job can regenerate them
  await db.update(mediaFilesTable).set({
    thumbnailPath: null,
    thumbnailGeneratedAt: null,
  }).where(eq(mediaFilesTable.nasPath, nasPath));

  res.json({ deleted });
});

// ── POST /api/library/thumbnails/rebuild — wipe cache then start fresh job ────

router.post("/library/thumbnails/rebuild", async (_req: Request, res: Response) => {
  const nasPath = await getNasPath();
  if (!nasPath) {
    res.status(400).json({ error: "NAS path not configured." });
    return;
  }

  clearThumbnailCache(nasPath);

  await db.update(mediaFilesTable).set({
    thumbnailPath: null,
    thumbnailGeneratedAt: null,
  }).where(eq(mediaFilesTable.nasPath, nasPath));

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

// ── PATCH /api/library/thumbnails/quality — update thumbnail quality setting ──

router.patch("/library/thumbnails/quality", async (req: Request, res: Response) => {
  const quality = req.body?.quality as string | undefined;
  const allowed = new Set(["FAST", "BALANCED", "HIGH"]);
  if (!quality || !allowed.has(quality.toUpperCase())) {
    res.status(400).json({ error: "quality must be FAST, BALANCED, or HIGH" });
    return;
  }

  const [existing] = await db.select({ id: appSettingsTable.id }).from(appSettingsTable).limit(1);
  if (!existing) {
    res.status(400).json({ error: "Settings not found" });
    return;
  }

  await db.update(appSettingsTable)
    .set({ thumbnailQuality: quality.toUpperCase() })
    .where(eq(appSettingsTable.id, existing.id));

  res.json({ thumbnailQuality: quality.toUpperCase() });
});

// ── POST /api/library/scan/benchmark — synthetic NAS timing benchmark ─────────
// Walks up to `size` files, measures raw I/O latency + metadata extraction
// speed WITHOUT touching media_files. Records as a BENCHMARK job so it appears
// in the diagnostics history table.

router.post("/library/scan/benchmark", async (req: Request, res: Response) => {
  const nasPath = await getNasPath();
  if (!nasPath) { res.status(400).json({ error: "NAS path not configured" }); return; }

  const sizeParam = req.query["size"] as string | undefined;
  const sampleLimit = sizeParam === "full" ? Infinity :
                      sizeParam === "10000" ? 10000 :
                      sizeParam === "5000"  ? 5000  : 1000;

  try {
    const { walkNas, extractPhotoMeta, extractVideoMeta, PHOTO_EXTS, VIDEO_META_EXTS } = await import("../lib/library-engine/indexer");
    const { getWillardAIDir: _wDir } = await import("../lib/nas-storage");
    const fs   = await import("fs");
    const path = await import("path");
    const { DEFAULT_SCANNER_SETTINGS } = await import("../lib/system-filter");

    try { fs.statSync(nasPath); } catch {
      res.status(503).json({ error: "NAS is offline" });
      return;
    }

    const willardDir = path.resolve(_wDir(nasPath));
    const skipDirs   = new Set([willardDir]);
    const allFiles: Array<{ fullPath: string; name: string; ext: string; sizeBytes: number; modifiedAt: Date }> = [];

    const walkStart = Date.now();
    walkNas(
      path.resolve(nasPath), skipDirs, allFiles,
      undefined, undefined, undefined, undefined, undefined,
      path.resolve(nasPath), DEFAULT_SCANNER_SETTINGS,
    );
    const walkTimeMs = Date.now() - walkStart;

    const sampled = sampleLimit === Infinity ? allFiles : allFiles.slice(0, sampleLimit);

    // Stat each file to measure raw NAS I/O latency
    const latencies: number[] = [];
    let totalSizeBytes = 0;
    for (const f of sampled) {
      const t0 = Date.now();
      try { fs.statSync(f.fullPath); } catch { continue; }
      latencies.push(Date.now() - t0);
      totalSizeBytes += f.sizeBytes;
    }
    const avgNasLatencyMs = latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
    const maxNasLatencyMs = latencies.length > 0 ? Math.round(Math.max(...latencies)) : 0;

    // Run metadata extraction on up to 100 photo/video files
    let metadataExtracted = 0;
    let metadataExtractionTimeMs = 0;
    const metaSample = sampled.filter(f => PHOTO_EXTS.has(f.ext) || VIDEO_META_EXTS.has(f.ext)).slice(0, 100);
    for (const f of metaSample) {
      const t0 = Date.now();
      try {
        if (PHOTO_EXTS.has(f.ext)) await extractPhotoMeta(f.fullPath, f.ext);
        else extractVideoMeta(f.fullPath);
        metadataExtractionTimeMs += Date.now() - t0;
        metadataExtracted++;
      } catch { /* skip unreadable file */ }
    }

    const elapsedMs    = Date.now() - walkStart;
    const elapsedSecs  = elapsedMs / 1000;
    const diagnostics  = {
      walkTimeMs,
      dirCacheHits:    0, dirCacheMisses:  0, skippedByReason: {},
      metadataExtracted, hashesGenerated: 0, dbWriteBatches: 0,
      avgNasLatencyMs, maxNasLatencyMs, peakConcurrency: 1,
      throughputFilesPerSec: elapsedSecs > 0 ? Math.round((sampled.length / elapsedSecs) * 10) / 10 : 0,
      throughputMBPerSec:    elapsedSecs > 0 ? Math.round((totalSizeBytes / (1024 * 1024) / elapsedSecs) * 100) / 100 : 0,
      peakQueueDepth: 0, dbWriteTimeMs: 0, metadataExtractionTimeMs, totalSizeBytes,
    };

    const [benchJob] = await db.insert(libraryJobsTable).values({
      jobType:  "SCAN", profile: "BENCHMARK", priority: "NORMAL", status: "DONE", nasPath,
      startedAt:      new Date(Date.now() - elapsedMs),
      finishedAt:     new Date(),
      processedFiles: sampled.length,
      totalFiles:     allFiles.length,
      summary:        { benchmark: true, sampleSize: sampled.length, totalFiles: allFiles.length, elapsedMs } as any,
      diagnostics:    diagnostics as any,
    }).returning({ id: libraryJobsTable.id });

    res.json({ jobId: benchJob?.id, filesWalked: allFiles.length, sampleSize: sampled.length, elapsedMs, diagnostics });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Benchmark failed" });
  }
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
