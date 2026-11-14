import { Router } from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { db, mediaFilesTable, mediaAiTable, libraryJobsTable } from "@workspace/db";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { getThumbnailDir, thumbnailFilename, removeOrphanedThumbnail } from "../lib/thumbnail-engine";
import { checkNasReachableAsync, getWillardAIDir, resolveLibraryPath, resolveWithinRoot } from "../lib/nas-storage";
import { isMissingRegularMediaFileAsync, softDeleteMissingMediaRecord } from "../lib/media-health-scan.ts";
import {
  readHealthDirectory,
  walkHealthDirectories,
  type HealthDirectoryEntry,
} from "../lib/media-health-filesystem.ts";
import { activeMediaCondition } from "../lib/media-scope.ts";
import { getActiveLibraryContext } from "../lib/active-library.ts";
import { purgeOrphanedDerivedData } from "../lib/derived-cleanup.ts";
import { startJob } from "../lib/library-engine";
import { isShuttingDown } from "../lib/shutdown-state.ts";
import { parseHealthCleanupActions } from "../lib/media-health-actions.ts";
import {
  appendMediaHealthJobSummary,
  canStartMediaHealthWorker,
  mediaHealthJobOwnershipCondition,
  scheduleMediaHealthWorker,
} from "../lib/media-health-jobs.ts";
import type { MediaHealthProgress, MediaHealthWorkerContext } from "../lib/media-health-worker.ts";
import {
  removeEmptyDirectoryWithoutSymlinkTraversal,
} from "../lib/safe-directory-read.ts";

const router = Router();
const ACTIVE = activeMediaCondition;

type HealthRow = {
  id: number;
  relativePath: string;
  thumbnailPath: string | null;
  mediaType: string;
  extension: string;
  sizeBytes: number;
  lastScanAction: string | null;
};

type HealthReport = {
  checkedAt: string;
  libraryPath: string | null;
  status: "healthy" | "attention" | "action_required";
  issues: {
    missingFiles: number;
    orphanedIndexRecords: number;
    missingThumbnails: number;
    orphanedThumbnails: number;
    emptyFolders: number;
    brokenMetadataReferences: number;
    unusedCacheBytes: number;
    unusedCacheFiles: number;
  };
};

const HEALTH_PAGE_SIZE = 500;
const MAX_HEALTH_CLEANUP_TARGETS = 250_000;
const HEALTH_JOB_TYPES = ["HEALTH_SCAN", "HEALTH_CLEANUP"] as const;

type HealthTreeBudget = { visitedEntries: number };
type HealthProgressReporter = (progress: MediaHealthProgress) => Promise<void>;

async function walkDirectories(
  root: string,
  skip: string,
  reportProgress?: HealthProgressReporter,
): Promise<{ empty: string[] }> {
  const result = await walkHealthDirectories(root, skip, reportProgress);
  return { empty: result.empty };
}

async function cacheInventory(
  nasPath: string,
  reportProgress?: HealthProgressReporter,
): Promise<{ orphaned: string[]; unused: string[]; unusedBytes: number }> {
  const thumbDir = getThumbnailDir(nasPath);
  const cacheRoot = path.join(getWillardAIDir(nasPath), "cache");
  const result = { orphaned: [] as string[], unused: [] as string[], unusedBytes: 0 };
  const pending: Array<{ dir: string; isThumb: boolean }> = [{ dir: cacheRoot, isThumb: false }];
  const budget: HealthTreeBudget = { visitedEntries: 0 };
  let visitedDirectories = 0;
  while (pending.length > 0) {
    const { dir, isThumb } = pending.pop()!;
    let entries: HealthDirectoryEntry[];
    try { entries = await readHealthDirectory(nasPath, dir, budget); } catch (error) {
      if (error instanceof Error && /limited to/.test(error.message)) throw error;
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory) pending.push({ dir: full, isThumb: isThumb || path.resolve(full) === path.resolve(thumbDir) });
      else if (entry.isFile) {
        if (isThumb) result.orphaned.push(full);
        else {
          result.unused.push(full);
          result.unusedBytes += entry.sizeBytes ?? 0;
        }
      }
    }
    visitedDirectories++;
    if (reportProgress && visitedDirectories % 100 === 0) {
      await reportProgress({
        phase: "cache",
        processed: visitedDirectories,
        total: null,
        message: `Checked ${visitedDirectories.toLocaleString()} cache folders…`,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return result;
}

async function isHealthThumbnailValid(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 32) return false;
    const handle = await fs.promises.open(filePath, "r");
    try {
      const header = Buffer.alloc(12);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      return bytesRead >= 12 &&
        header.subarray(0, 4).toString("ascii") === "RIFF" &&
        header.subarray(8, 12).toString("ascii") === "WEBP" &&
        header.readUInt32LE(4) + 8 <= stat.size;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function inspectLibrary(
  nasPath: string,
  reportProgress?: HealthProgressReporter,
): Promise<{ report: HealthReport; rows: HealthRow[]; missing: HealthRow[]; missingThumbs: HealthRow[]; orphanThumbs: string[]; emptyFolders: string[] }> {
  const reachability = await checkNasReachableAsync(nasPath);
  if (!reachability.online) {
    throw new Error(`Library is not safely readable: ${reachability.message}`);
  }

  const [indexedCount] = await db.select({
    total: sql<number>`count(*)::int`,
  }).from(mediaFilesTable).where(and(eq(mediaFilesTable.nasPath, nasPath), ACTIVE));
  const totalIndexed = Number(indexedCount?.total ?? 0);
  if (totalIndexed > MAX_HEALTH_CLEANUP_TARGETS) {
    throw new Error(`Health scan is limited to ${MAX_HEALTH_CLEANUP_TARGETS.toLocaleString()} indexed files per run; no cleanup action was started.`);
  }

  const rows: HealthRow[] = [];
  const missing: HealthRow[] = [];
  const missingThumbs: HealthRow[] = [];
  const validIds = new Set<number>();
  let indexedFiles = 0;
  let afterId = 0;
  while (true) {
    const page = await db.select({
      id: mediaFilesTable.id,
      relativePath: mediaFilesTable.relativePath,
      thumbnailPath: mediaFilesTable.thumbnailPath,
      mediaType: mediaFilesTable.mediaType,
      extension: mediaFilesTable.extension,
      sizeBytes: mediaFilesTable.sizeBytes,
      lastScanAction: mediaFilesTable.lastScanAction,
    }).from(mediaFilesTable)
      .where(and(eq(mediaFilesTable.nasPath, nasPath), ACTIVE, gt(mediaFilesTable.id, afterId)))
      .orderBy(asc(mediaFilesTable.id))
      .limit(HEALTH_PAGE_SIZE);
    if (page.length === 0) break;
    indexedFiles += page.length;
    if (indexedFiles > MAX_HEALTH_CLEANUP_TARGETS) {
      throw new Error(`Health scan is limited to ${MAX_HEALTH_CLEANUP_TARGETS.toLocaleString()} indexed files per run; no cleanup action was started.`);
    }
    rows.push(...page);
    for (const row of page) {
      validIds.add(row.id);
      const source = resolveLibraryPath(nasPath, row.relativePath);
      if (await isMissingRegularMediaFileAsync(source)) missing.push(row);
      const needsThumb = row.mediaType === "photo" || row.mediaType === "video" || row.extension === "pdf";
      if (needsThumb) {
        try {
          const thumb = row.thumbnailPath
            ? resolveWithinRoot(row.thumbnailPath, getWillardAIDir(nasPath))
            : path.join(getThumbnailDir(nasPath), thumbnailFilename(row.id));
          if (!await isHealthThumbnailValid(thumb)) missingThumbs.push(row);
        } catch { missingThumbs.push(row); }
      }
    }
    afterId = page[page.length - 1]!.id;
    if (reportProgress) {
      await reportProgress({
        phase: "catalog",
        processed: indexedFiles,
        total: totalIndexed,
        message: `Checked ${indexedFiles.toLocaleString()} of ${totalIndexed.toLocaleString()} indexed files…`,
      });
    }
      await new Promise<void>((resolve) => setImmediate(resolve));
  }

  const cache = await cacheInventory(nasPath, reportProgress);
  const orphanThumbs = cache.orphaned.filter(file => {
    const id = Number(path.basename(file, path.extname(file)));
    return path.extname(file).toLowerCase() === ".webp" && (!Number.isInteger(id) || !validIds.has(id));
  });
  const folders = await walkDirectories(nasPath, getWillardAIDir(nasPath), reportProgress);
  const [metadataRows, orphanFaceRows, orphanStateRows] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` })
    .from(mediaAiTable)
    .leftJoin(mediaFilesTable, eq(mediaAiTable.mediaFileId, mediaFilesTable.id))
    .where(sql`${mediaFilesTable.id} IS NULL`),
    db.execute(sql`
      SELECT count(*)::int AS count
        FROM faces fc
       WHERE NOT EXISTS (SELECT 1 FROM media_files mf WHERE mf.id = fc.media_file_id)
    `),
    db.execute(sql`
      SELECT count(*)::int AS count
        FROM face_scan_state s
       WHERE NOT EXISTS (SELECT 1 FROM media_files mf WHERE mf.id = s.media_file_id)
    `),
  ]);
  const orphanedDerivedRows =
    Number(metadataRows?.[0]?.count ?? 0) +
    Number((orphanFaceRows.rows[0] as { count?: number | string } | undefined)?.count ?? 0) +
    Number((orphanStateRows.rows[0] as { count?: number | string } | undefined)?.count ?? 0);

  const issues = {
    missingFiles: missing.length,
    orphanedIndexRecords: missing.length,
    missingThumbnails: missingThumbs.length,
    orphanedThumbnails: orphanThumbs.length,
    emptyFolders: folders.empty.filter(dir => path.resolve(dir) !== path.resolve(nasPath)).length,
    brokenMetadataReferences: orphanedDerivedRows,
    unusedCacheBytes: cache.unusedBytes,
    unusedCacheFiles: cache.unused.length,
  };
  const total = Object.values(issues).some(value => value > 0);
  const severe = issues.missingFiles > 0 || issues.orphanedIndexRecords > 0 || issues.brokenMetadataReferences > 0;
  return {
    report: {
      checkedAt: new Date().toISOString(),
      libraryPath: nasPath,
      status: severe ? "action_required" : total ? "attention" : "healthy",
      issues,
    },
    rows, missing, missingThumbs, orphanThumbs, emptyFolders: folders.empty,
  };
}

function publicHealthJob(job: typeof libraryJobsTable.$inferSelect) {
  const diagnostics = (job.diagnostics ?? {}) as Record<string, unknown>;
  const worker = (diagnostics.healthJob ?? {}) as Record<string, unknown>;
  const lastProgress = worker.lastProgress && typeof worker.lastProgress === "object"
    ? worker.lastProgress as Record<string, unknown>
    : null;
  const restartInterrupted = worker.retryAvailable === true && worker.restartInterrupted === true;
  return {
    id: job.id,
    jobType: job.jobType,
    status: job.status,
    processed: job.processedFiles,
    total: job.totalFiles,
    phase: restartInterrupted
      ? "interrupted"
      : typeof lastProgress?.phase === "string"
      ? lastProgress.phase
      : typeof worker.phase === "string" ? worker.phase : null,
    message: restartInterrupted && typeof job.error === "string"
      ? job.error
      : typeof lastProgress?.message === "string"
      ? lastProgress.message
      : typeof worker.message === "string" ? worker.message : null,
    actions: Array.isArray(worker.actions) ? worker.actions : [],
    retryAvailable: restartInterrupted,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    summary: job.summary,
    error: job.error,
  };
}

async function findActiveLibraryJob(nasPath: string) {
  const [job] = await db.select().from(libraryJobsTable)
    .where(and(eq(libraryJobsTable.nasPath, nasPath), eq(libraryJobsTable.status, "RUNNING")))
    .orderBy(desc(libraryJobsTable.createdAt), desc(libraryJobsTable.id))
    .limit(1);
  return job ?? null;
}

async function startHealthJob(
  nasPath: string,
  jobType: "HEALTH_SCAN" | "HEALTH_CLEANUP",
  actions: string[],
  runner: (jobId: number, token: string, context: MediaHealthWorkerContext) => Promise<{ summary: Record<string, unknown>; status?: "DONE" | "FAILED"; error?: string }>,
  afterComplete?: (jobId: number, token: string, outcome: { summary: Record<string, unknown>; status?: "DONE" | "FAILED"; error?: string }) => Promise<void>,
): Promise<{ job: typeof libraryJobsTable.$inferSelect; started: boolean } | { busy: true }> {
  if (isShuttingDown()) return { busy: true };
  const existing = await findActiveLibraryJob(nasPath);
  if (existing) return { job: existing, started: false };
  if (!canStartMediaHealthWorker()) return { busy: true };

  const token = randomUUID();
  try {
    const [job] = await db.insert(libraryJobsTable).values({
      jobType,
      profile: "HEALTH",
      priority: "HIGH",
      status: "RUNNING",
      nasPath,
      startedAt: new Date(),
      processedFiles: 0,
      diagnostics: {
        healthJob: {
          workerToken: token,
          phase: "queued",
          message: "Health task queued",
          actions,
        },
      },
    }).returning();
    if (!job) throw new Error("Health job could not be recorded.");

    const scheduled = scheduleMediaHealthWorker(
      job.id,
      token,
      (context) => runner(job.id, token, context),
      afterComplete,
    );
    if (!scheduled) {
      await db.update(libraryJobsTable).set({
        status: "FAILED",
        finishedAt: new Date(),
        error: "The bounded Health Center worker is busy; start this task again shortly.",
      }).where(mediaHealthJobOwnershipCondition(job.id, token));
      return { busy: true };
    }
    return { job, started: true };
  } catch (error) {
    const candidate = error as { code?: string; constraint?: string } | null;
    if (candidate?.code === "23505" && candidate.constraint === "library_jobs_active_nas_unique") {
      const winner = await findActiveLibraryJob(nasPath);
      if (winner) return { job: winner, started: false };
    }
    throw error;
  }
}

router.get("/media/health", async (_req, res) => {
  try {
    const library = await getActiveLibraryContext();
    if (!library) return res.json({
      checkedAt: null,
      libraryPath: null,
      libraryKey: null,
      indexedFiles: 0,
      hasReport: false,
      status: "attention",
      issues: { missingFiles: 0, orphanedIndexRecords: 0, missingThumbnails: 0, orphanedThumbnails: 0, emptyFolders: 0, brokenMetadataReferences: 0, unusedCacheBytes: 0, unusedCacheFiles: 0 },
      error: "No library is configured",
      activeJob: null,
      recoverableCleanup: null,
    });

    const [latest] = await db.select({
      summary: libraryJobsTable.summary,
    }).from(libraryJobsTable).where(and(
      eq(libraryJobsTable.nasPath, library.nasPath),
      inArray(libraryJobsTable.jobType, [...HEALTH_JOB_TYPES]),
      eq(libraryJobsTable.status, "DONE"),
    )).orderBy(desc(libraryJobsTable.createdAt), desc(libraryJobsTable.id)).limit(1);
    const summary = (latest?.summary ?? {}) as Record<string, unknown>;
    const report = summary.healthReport as HealthReport | undefined;
    const indexedFiles = Number(summary.indexedFiles ?? 0);
    const active = await findActiveLibraryJob(library.nasPath);
    const [recoverableCleanup] = await db.select().from(libraryJobsTable)
      .where(and(
        eq(libraryJobsTable.nasPath, library.nasPath),
        eq(libraryJobsTable.jobType, "HEALTH_CLEANUP"),
        inArray(libraryJobsTable.status, ["FAILED", "INTERRUPTED_BY_RESTART"]),
        sql`${libraryJobsTable.diagnostics}->'healthJob'->>'retryAvailable' = 'true'`,
        sql`${libraryJobsTable.diagnostics}->'healthJob'->>'restartInterrupted' = 'true'`,
      ))
      .orderBy(desc(libraryJobsTable.createdAt), desc(libraryJobsTable.id))
      .limit(1);

    return res.json({
      ...(report ?? {
        checkedAt: null,
        libraryPath: library.nasPath,
        status: "attention" as const,
        issues: { missingFiles: 0, orphanedIndexRecords: 0, missingThumbnails: 0, orphanedThumbnails: 0, emptyFolders: 0, brokenMetadataReferences: 0, unusedCacheBytes: 0, unusedCacheFiles: 0 },
      }),
      libraryKey: library.libraryKey,
      indexedFiles,
      hasReport: Boolean(report),
      activeJob: active ? publicHealthJob(active) : null,
      recoverableCleanup: recoverableCleanup ? publicHealthJob(recoverableCleanup) : null,
    });
  } catch {
    return res.status(500).json({ error: "Health status could not be loaded" });
  }
});

router.get("/media/health/jobs/active", async (_req, res) => {
  const library = await getActiveLibraryContext();
  if (!library) return res.json({ job: null });
  const job = await findActiveLibraryJob(library.nasPath);
  return res.json({ job: job ? publicHealthJob(job) : null });
});

router.get("/media/health/jobs/:jobId", async (req, res) => {
  const id = Number(req.params.jobId);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: "A valid job id is required" });
  const library = await getActiveLibraryContext();
  if (!library) return res.status(404).json({ error: "No library is configured" });
  const [job] = await db.select().from(libraryJobsTable)
    .where(and(eq(libraryJobsTable.id, id), eq(libraryJobsTable.nasPath, library.nasPath)))
    .limit(1);
  if (!job) return res.status(404).json({ error: "Health job was not found for the active library" });
  return res.json({ job: publicHealthJob(job) });
});

router.post("/media/health/scan", async (_req, res) => {
  const library = await getActiveLibraryContext();
  if (!library) return res.status(409).json({ error: "No library is configured" });
  let started: Awaited<ReturnType<typeof startHealthJob>>;
  try {
    started = await startHealthJob(
      library.nasPath,
      "HEALTH_SCAN",
      [],
      async (_jobId, _token, context) => {
        const inspected = await inspectLibrary(library.nasPath, (progress) => context.reportProgress(progress));
        return {
          summary: {
            healthReport: inspected.report,
            indexedFiles: inspected.rows.length,
          },
        };
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Health scan could not start";
    return res.status(503).json({ error: message });
  }
  if ("busy" in started) return res.status(503).json({ error: "The bounded Health Center worker is busy; try again shortly." });
  if (!started.started && !HEALTH_JOB_TYPES.includes(started.job.jobType as typeof HEALTH_JOB_TYPES[number])) {
    return res.status(409).json({ error: "Another library job is running.", job: publicHealthJob(started.job) });
  }
  return res.status(202).json({ job: publicHealthJob(started.job), alreadyRunning: !started.started });
});

async function runHealthCleanup(
  jobId: number,
  token: string,
  nasPath: string,
  actions: string[],
  context: MediaHealthWorkerContext,
) {
  let failedItems = 0;
  let thumbnailFailures = 0;
  let faceCropFailures = 0;
  await context.reportProgress({
    phase: "inspect",
    processed: 0,
    total: null,
    message: "Checking the library before cleanup…",
  });
  const inspected = await inspectLibrary(nasPath, (progress) => context.reportProgress(progress));
  let done = 0;
  const thumbnailRequested = actions.includes("fullThumbnailRebuild") || actions.includes("missingThumbnails");
  const metadataRequested = actions.includes("rebuildMetadata");
    const emptyFolderTargets = inspected.emptyFolders.filter(folder =>
      path.resolve(folder) !== path.resolve(nasPath) &&
      !path.resolve(folder).startsWith(path.resolve(getWillardAIDir(nasPath)) + path.sep)
    );
    let total =
      (actions.includes("orphanedRecords") ? inspected.missing.length : 0) +
      (actions.includes("orphanedDerivedData") ? inspected.report.issues.brokenMetadataReferences : 0) +
      (actions.includes("orphanedThumbnails") ? inspected.orphanThumbs.length : 0) +
      (actions.includes("emptyFolders") ? emptyFolderTargets.length : 0) +
      (thumbnailRequested || metadataRequested ? 1 : 0);
    total = Math.max(1, total);
    let lastProgressAt = -1;
    const progress = async (message: string, force = false) => {
      if (!force && done - lastProgressAt < 10 && done < total) return;
      lastProgressAt = done;
      await context.reportProgress({ phase: "cleanup", processed: done, total, message });
    };
    let derivedCleanup: Record<string, unknown> | undefined;

    if (actions.includes("orphanedRecords")) {
      for (const row of inspected.missing) {
        await context.assertOwned();
        const source = resolveLibraryPath(nasPath, row.relativePath);
        const result = await softDeleteMissingMediaRecord(source, async () => {
          await context.assertOwned();
          const [updated] = await db.update(mediaFilesTable)
            .set({ lastScanAction: "DELETED", lastScannedAt: new Date() })
            .where(and(
              eq(mediaFilesTable.id, row.id),
              eq(mediaFilesTable.nasPath, nasPath),
              eq(mediaFilesTable.relativePath, row.relativePath),
              ACTIVE,
              mediaHealthJobOwnershipCondition(jobId, token)!,
            ))
            .returning({ id: mediaFilesTable.id });
          return Boolean(updated);
        });
        done++;
        if (result === "marked_deleted") {
          await progress("Marked a confirmed-missing file as removed from the library…");
        } else if (result === "reappeared") {
          await progress("Skipped a file that reappeared during cleanup…");
        } else {
          await progress("Skipped a media record that changed during cleanup…");
        }
      }
    }
    if (actions.includes("orphanedDerivedData")) {
      await context.assertOwned();
      const cleaned = await purgeOrphanedDerivedData(nasPath);
      faceCropFailures = cleaned.cropErrors.length;
      failedItems += faceCropFailures;
      // Orphaned metadata rows are included in the inspection count. Face-crop
      // removals and failures are discovered during cleanup, so add those
      // attempted items to both the denominator and processed count.
      total +=
        cleaned.orphanRows - inspected.report.issues.brokenMetadataReferences +
        cleaned.staleCropsRemoved + cleaned.cropErrors.length;
      done += cleaned.orphanRows + cleaned.staleCropsRemoved + cleaned.cropErrors.length;
      derivedCleanup = {
        orphanRows: cleaned.orphanRows,
        staleCropsRemoved: cleaned.staleCropsRemoved,
        peopleRows: cleaned.peopleRows,
        cropErrors: cleaned.cropErrors.length,
      };
      await progress(`Removed ${cleaned.orphanRows} orphaned derived rows and ${cleaned.staleCropsRemoved} stale face crops${faceCropFailures > 0 ? `; ${faceCropFailures} face crop(s) could not be removed` : ""}…`, true);
    }
    if (actions.includes("orphanedThumbnails")) {
      for (const file of inspected.orphanThumbs) {
        await context.assertOwned();
        let removed = false;
        const filename = path.basename(file);
        const mediaFileId = Number(path.basename(filename, path.extname(filename)));
        if (path.extname(filename).toLowerCase() === ".webp" &&
            Number.isSafeInteger(mediaFileId) && mediaFileId > 0 &&
            filename === thumbnailFilename(mediaFileId)) {
          try {
            removed = await removeOrphanedThumbnail(nasPath, file, async () => {
              await context.assertOwned();
              const [activeRow] = await db.select({ id: mediaFilesTable.id })
                .from(mediaFilesTable)
                .where(and(
                  eq(mediaFilesTable.id, mediaFileId),
                  eq(mediaFilesTable.nasPath, nasPath),
                  ACTIVE,
                ))
                .limit(1);
              return !activeRow;
            });
          } catch { /* changed or became unsafe since inspection */ }
        }
        done++;
        await progress(removed ? "Removed an orphaned thumbnail…" : "Skipped a thumbnail that changed or is no longer orphaned…");
      }
    }
    if (actions.includes("missingThumbnails") || actions.includes("fullThumbnailRebuild")) {
      done++;
      await progress("Thumbnail regeneration will run as a capacity-checked library job.", true);
    }
    if (actions.includes("emptyFolders")) {
      for (const folder of emptyFolderTargets) {
        await context.assertOwned();
        try {
          removeEmptyDirectoryWithoutSymlinkTraversal(nasPath, folder);
        } catch { /* changed since scan or failed a no-follow check */ }
        done++;
        await progress("Removing empty folders…");
      }
    }
    if (actions.includes("rebuildMetadata")) {
      done++;
      await progress("Metadata refresh will run as a separate library job.", true);
    }
    const partial = failedItems > 0;
    const failureDetails = [
      thumbnailFailures > 0 ? `${thumbnailFailures} thumbnail(s) could not be regenerated` : null,
      faceCropFailures > 0 ? `${faceCropFailures} face crop(s) could not be removed` : null,
    ].filter((detail): detail is string => Boolean(detail));
    const completionMessage = partial
      ? `Cleanup finished with ${failedItems} item(s) needing attention${failureDetails.length > 0 ? `: ${failureDetails.join("; ")}` : ""}.`
      : "Cleanup completed.";
    const followUpRequest = thumbnailRequested
      ? {
          jobType: "THUMBNAILS",
          rebuildThumbnails: actions.includes("fullThumbnailRebuild"),
        }
      : metadataRequested
        ? { jobType: "METADATA" }
        : null;

    await context.reportProgress({
      phase: "complete",
      processed: done,
      total,
      message: completionMessage,
    });
    return {
      status: partial ? "FAILED" as const : "DONE" as const,
      error: partial ? completionMessage : undefined,
      summary: {
        actions,
        failedItems,
        thumbnailFailures,
        faceCropFailures,
        ...(derivedCleanup ? { derivedCleanup } : {}),
        healthReport: inspected.report,
        indexedFiles: inspected.rows.length,
        reportStale: true,
        ...(followUpRequest ? {
          followUpPending: true,
          followUpRequest,
        } : {}),
        message: completionMessage,
      },
    };
}

async function startHealthCleanupJob(nasPath: string, actions: string[]) {
  const thumbnailRequested = actions.includes("fullThumbnailRebuild") || actions.includes("missingThumbnails");
  const metadataRequested = actions.includes("rebuildMetadata");
  return startHealthJob(
    nasPath,
    "HEALTH_CLEANUP",
    actions,
    (jobId, token, context) => runHealthCleanup(jobId, token, nasPath, actions, context),
    async (jobId, token, outcome) => {
      const followUp = outcome.summary.followUpRequest as { jobType?: string; rebuildThumbnails?: boolean } | undefined;
      if (!followUp?.jobType) return;
      try {
        const child = await startJob({
          jobType: followUp.jobType as "THUMBNAILS" | "METADATA",
          profile: "HEALTH_SCAN",
          nasPath,
          ...(followUp.jobType === "THUMBNAILS" ? { rebuildThumbnails: followUp.rebuildThumbnails === true } : {}),
        });
        if (child.errorCode) throw new Error(child.errorMessage ?? "The follow-up library job could not start.");
        if (child.alreadyRunning) {
          const [existing] = await db.select({
            jobType: libraryJobsTable.jobType,
            status: libraryJobsTable.status,
          }).from(libraryJobsTable).where(eq(libraryJobsTable.id, child.jobId)).limit(1);
          if (existing?.jobType !== followUp.jobType || existing.status !== "RUNNING") {
            throw new Error("Another library job is active; the requested follow-up was not started.");
          }
        }
        await appendMediaHealthJobSummary(jobId, token, {
          followUpPending: false,
          followUpJobId: child.jobId,
          followUpJobType: followUp.jobType,
          followUpMessage: `${followUp.jobType === "METADATA" ? "Metadata refresh" : "Thumbnail rebuild"} job #${child.jobId} is running.`,
        });
      } catch (error) {
        await appendMediaHealthJobSummary(jobId, token, {
          followUpPending: false,
          followUpError: error instanceof Error ? error.message : "The follow-up library job could not start.",
        });
      }
    },
  );
}

router.post("/media/cleanup", async (req, res) => {
  const parsed = parseHealthCleanupActions(req.body?.actions);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const library = await getActiveLibraryContext();
  if (!library) return res.status(409).json({ error: "No library is configured" });

  let started: Awaited<ReturnType<typeof startHealthCleanupJob>>;
  try {
    started = await startHealthCleanupJob(library.nasPath, parsed.actions);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cleanup could not start";
    return res.status(503).json({ error: message });
  }
  if ("busy" in started) return res.status(503).json({ error: "The bounded Health Center worker is busy; try again shortly." });
  if (!started.started) {
    if (started.job.jobType === "HEALTH_CLEANUP") {
      return res.status(202).json({ job: publicHealthJob(started.job), alreadyRunning: true });
    }
    return res.status(409).json({ error: "Another library job is running.", job: publicHealthJob(started.job) });
  }
  return res.status(202).json({ job: publicHealthJob(started.job), alreadyRunning: false });
});

router.post("/media/cleanup/jobs/:jobId/retry", async (req, res) => {
  const id = Number(req.params.jobId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({ error: "A valid cleanup job id is required" });
  }
  const library = await getActiveLibraryContext();
  if (!library) return res.status(409).json({ error: "No library is configured" });

  const [job] = await db.select().from(libraryJobsTable)
    .where(and(
      eq(libraryJobsTable.id, id),
      eq(libraryJobsTable.nasPath, library.nasPath),
      eq(libraryJobsTable.jobType, "HEALTH_CLEANUP"),
      inArray(libraryJobsTable.status, ["FAILED", "INTERRUPTED_BY_RESTART"]),
    ))
    .limit(1);
  const diagnostics = (job?.diagnostics ?? {}) as Record<string, unknown>;
  const healthJob = (diagnostics.healthJob ?? {}) as Record<string, unknown>;
  if (!job || healthJob.retryAvailable !== true || healthJob.restartInterrupted !== true) {
    return res.status(409).json({ error: "This cleanup was not interrupted by a server restart and cannot be retried from its saved actions." });
  }
  const parsed = parseHealthCleanupActions(healthJob.actions);
  if (!parsed.ok) {
    return res.status(409).json({ error: "Saved cleanup actions are invalid. Start a new cleanup after reviewing the library." });
  }

  let started: Awaited<ReturnType<typeof startHealthCleanupJob>>;
  try {
    started = await startHealthCleanupJob(library.nasPath, parsed.actions);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cleanup could not be retried";
    return res.status(503).json({ error: message });
  }
  if ("busy" in started) {
    return res.status(503).json({ error: "The bounded Health Center worker is busy; try again shortly." });
  }
  if (!started.started && started.job.jobType !== "HEALTH_CLEANUP") {
    return res.status(409).json({ error: "Another library job is running.", job: publicHealthJob(started.job) });
  }
  if (started.started) {
    await db.update(libraryJobsTable).set({
      diagnostics: sql`jsonb_set(
        COALESCE(${libraryJobsTable.diagnostics}, '{}'::jsonb),
        '{healthJob,retryAvailable}',
        'false'::jsonb,
        true
      )`,
    }).where(and(
      eq(libraryJobsTable.id, job.id),
      sql`${libraryJobsTable.diagnostics}->'healthJob'->>'retryAvailable' = 'true'`,
    ));
  }
  return res.status(202).json({ job: publicHealthJob(started.job), alreadyRunning: !started.started });
});

export default router;