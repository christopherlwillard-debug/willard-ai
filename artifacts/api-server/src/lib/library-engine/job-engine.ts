import * as fs from "fs";
import * as path from "path";
import { db } from "@workspace/db";
import { mediaFilesTable, libraryJobsTable } from "@workspace/db";
import { eq, and, lt, sql, isNull, or, gt } from "drizzle-orm";
import {
  type JobType, type JobProfile, type JobPriority, type JobStatus,
  type CancellationReason, type ScanPhase, type ScanAction,
  type ActiveJobState, type ProgressEvent, type JobSummary, type JobCounters,
  EMPTY_COUNTERS, PRIORITY_RANK,
} from "./types";
import {
  walkNas, classifyMediaType, guessMimeType,
  extractPhotoMeta, extractVideoMeta, extractPdfMeta, hashFile,
  PHOTO_EXTS, VIDEO_META_EXTS,
} from "./indexer";
import { getWillardAIDir } from "../nas-storage";
import { getThumbnailDir, thumbnailFilename, generateThumbnail } from "../thumbnail-engine";

// ── In-memory state ───────────────────────────────────────────────────────────

const activeJobs = new Map<number, ActiveJobState>();

export function getActiveJobId(): number | null {
  for (const [id, state] of activeJobs) {
    if (!state.pauseRequested && !state.cancelRequested) return id;
  }
  // Return any paused job if no running ones
  if (activeJobs.size > 0) return [...activeJobs.keys()][0]!;
  return null;
}

export function getJobProgress(jobId: number): ProgressEvent | null {
  const state = activeJobs.get(jobId);
  if (!state) return null;
  const { speed, etaSeconds } = computeEta(state.speedWindow, state.filesProcessed, state.filesTotal);

  let status: JobStatus = "RUNNING";
  if (state.pauseRequested) status = "PAUSED";
  if (state.cancelRequested) status = "CANCELLED";

  const progress = state.filesTotal > 0
    ? Math.min(100, Math.round((state.filesProcessed / state.filesTotal) * 100))
    : 0;

  return {
    jobId: state.id,
    status,
    phase: state.phase,
    profile: state.profile,
    progress,
    filesProcessed: state.filesProcessed,
    filesTotal: state.filesTotal,
    currentPath: state.currentPath,
    etaSeconds,
    speed,
    counters: { ...state.counters },
    summary: null,
  };
}

// ── Rolling ETA (last 2000 file timestamps) ───────────────────────────────────

const WINDOW_SIZE = 2000;

function computeEta(
  speedWindow: number[],
  processed: number,
  total: number,
): { speed: number; etaSeconds: number | null } {
  if (speedWindow.length < 2) return { speed: 0, etaSeconds: null };
  const elapsed = speedWindow[speedWindow.length - 1]! - speedWindow[0]!;
  if (elapsed === 0) return { speed: 0, etaSeconds: null };
  const speed = (speedWindow.length / elapsed) * 1000; // files/sec
  const remaining = total - processed;
  const etaSeconds = remaining > 0 ? Math.round(remaining / speed) : 0;
  return { speed: Math.round(speed), etaSeconds };
}

function tickSpeed(state: ActiveJobState): void {
  state.speedWindow.push(Date.now());
  if (state.speedWindow.length > WINDOW_SIZE) state.speedWindow.shift();
}

// ── Job controls ──────────────────────────────────────────────────────────────

export function requestPause(jobId: number): boolean {
  const state = activeJobs.get(jobId);
  if (!state) return false;
  state.pauseRequested = true;
  return true;
}

export function requestCancel(jobId: number, reason: CancellationReason = "USER_CANCELLED"): boolean {
  const state = activeJobs.get(jobId);
  if (!state) return false;
  state.cancelRequested = true;
  state.cancellationReason = reason;
  return true;
}

// ── Start a job ───────────────────────────────────────────────────────────────

export interface StartJobOptions {
  jobType:  JobType;
  profile:  JobProfile;
  nasPath:  string;
  rootPath?: string;
}

export async function startJob(opts: StartJobOptions): Promise<{ jobId: number; alreadyRunning: boolean }> {
  const priority: JobPriority = opts.profile === "QUICK" ? "HIGH"
    : opts.profile === "FULL" ? "NORMAL" : "LOW";

  // Check for existing active job
  const existingId = getActiveJobId();
  if (existingId !== null) {
    const existing = activeJobs.get(existingId)!;
    // Preempt if new job has higher priority
    if (PRIORITY_RANK[priority] > PRIORITY_RANK[existing.priority]) {
      requestPause(existingId);
    } else {
      return { jobId: existingId, alreadyRunning: true };
    }
  }

  // Persist job record
  const [job] = await db.insert(libraryJobsTable).values({
    jobType:  opts.jobType,
    profile:  opts.profile,
    priority,
    status:   "RUNNING",
    nasPath:  opts.nasPath,
    rootPath: opts.rootPath ?? null,
    startedAt: new Date(),
  }).returning();

  const state: ActiveJobState = {
    id:               job.id,
    nasPath:          opts.nasPath,
    profile:          opts.profile,
    priority,
    pauseRequested:   false,
    cancelRequested:  false,
    cancellationReason: null,
    startedAt:        new Date(),
    phase:            "walking",
    filesTotal:       0,
    filesProcessed:   0,
    currentPath:      "",
    counters:         EMPTY_COUNTERS(),
    speedWindow:      [],
  };
  activeJobs.set(job.id, state);

  // Run async without blocking the response
  if (opts.jobType === "THUMBNAILS") {
    void runThumbnailJob(state);
  } else {
    void runScanJob(state, opts.rootPath);
  }

  return { jobId: job.id, alreadyRunning: false };
}

// ── Resume a paused job ───────────────────────────────────────────────────────

export async function resumeJob(jobId: number): Promise<boolean> {
  // Fetch job from DB
  const [job] = await db.select().from(libraryJobsTable)
    .where(eq(libraryJobsTable.id, jobId)).limit(1);
  if (!job || job.status !== "PAUSED") return false;

  // Re-create in-memory state and restart
  const priority = (job.priority as JobPriority) ?? "NORMAL";
  const profile  = (job.profile  as JobProfile)  ?? "QUICK";

  // Update DB status back to RUNNING
  await db.update(libraryJobsTable)
    .set({ status: "RUNNING", pausedAt: null, startedAt: new Date() })
    .where(eq(libraryJobsTable.id, jobId));

  const state: ActiveJobState = {
    id:               job.id,
    nasPath:          job.nasPath,
    profile,
    priority,
    pauseRequested:   false,
    cancelRequested:  false,
    cancellationReason: null,
    startedAt:        new Date(),
    phase:            "walking",
    filesTotal:       0,
    filesProcessed:   0,
    currentPath:      "",
    counters:         EMPTY_COUNTERS(),
    speedWindow:      [],
  };
  activeJobs.set(job.id, state);

  if (job.jobType === "THUMBNAILS") {
    void runThumbnailJob(state);
  } else {
    void runScanJob(state, job.rootPath ?? undefined);
  }
  return true;
}

// ── Previous job elapsed time (for "Saved" comparison) ───────────────────────

async function getPreviousElapsedMs(nasPath: string, profile: string): Promise<number | null> {
  const [prev] = await db.select({ summary: libraryJobsTable.summary })
    .from(libraryJobsTable)
    .where(and(
      eq(libraryJobsTable.nasPath, nasPath),
      eq(libraryJobsTable.profile, profile),
      eq(libraryJobsTable.status, "DONE"),
    ))
    .orderBy(sql`${libraryJobsTable.createdAt} DESC`)
    .limit(1);

  if (!prev?.summary) return null;
  const s = prev.summary as any;
  return typeof s.elapsedMs === "number" ? s.elapsedMs : null;
}

// ── NAS availability check ───────────────────────────────────────────────────

function isNasAvailable(nasPath: string): boolean {
  try {
    fs.statSync(nasPath);
    return true;
  } catch {
    return false;
  }
}

// ── Main scan loop ────────────────────────────────────────────────────────────

async function runScanJob(state: ActiveJobState, rootPath?: string): Promise<void> {
  const jobId = state.id;

  try {
    const scanRoot = rootPath ?? state.nasPath;

    // ── NAS availability check ─────────────────────────────────────────────
    if (!isNasAvailable(scanRoot)) {
      await failJob(jobId, "NAS_OFFLINE", "NAS path is not accessible");
      return;
    }

    // ── Phase: walking ────────────────────────────────────────────────────
    state.phase = "walking";
    const willardDir = path.resolve(getWillardAIDir(state.nasPath));
    const skipDirs   = new Set([willardDir]);
    const files: Array<{ fullPath: string; name: string; ext: string; sizeBytes: number; modifiedAt: Date }> = [];
    walkNas(path.resolve(scanRoot), skipDirs, files);

    state.filesTotal = files.length;
    await db.update(libraryJobsTable)
      .set({ totalFiles: files.length })
      .where(eq(libraryJobsTable.id, jobId));

    const scanStartedAt = new Date();

    // ── Phase: indexing ───────────────────────────────────────────────────
    state.phase = "indexing";

    // Load all existing paths from DB for this NAS (for move detection)
    const existingByPath = new Map<string, { id: number; sizeBytes: number; modifiedAt: Date | null; contentHash: string | null }>();
    const dbRows = await db.select({
      id: mediaFilesTable.id,
      relativePath: mediaFilesTable.relativePath,
      sizeBytes: mediaFilesTable.sizeBytes,
      modifiedAt: mediaFilesTable.modifiedAt,
      contentHash: mediaFilesTable.contentHash,
    }).from(mediaFilesTable).where(eq(mediaFilesTable.nasPath, state.nasPath));

    for (const row of dbRows) {
      existingByPath.set(row.relativePath, row);
    }

    // Build hash→id map for move detection (only entries with a hash)
    const existingByHash = new Map<string, number>(); // hash → db id
    for (const row of dbRows) {
      if (row.contentHash) existingByHash.set(row.contentHash, row.id);
    }

    // Track which DB paths we've seen (for deletion detection)
    const seenPaths = new Set<string>();

    const BATCH = 25;

    for (let i = 0; i < files.length; i += BATCH) {
      // ── Pause/cancel check ─────────────────────────────────────────────
      if (state.cancelRequested) {
        await db.update(libraryJobsTable).set({
          status: "CANCELLED",
          cancellationReason: state.cancellationReason ?? "USER_CANCELLED",
          finishedAt: new Date(),
        }).where(eq(libraryJobsTable.id, jobId));
        activeJobs.delete(jobId);
        return;
      }

      if (state.pauseRequested) {
        // Store cursor (file index) so we can resume
        await db.update(libraryJobsTable).set({
          status:         "PAUSED",
          cursor:         String(i),
          pausedAt:       new Date(),
          processedFiles: state.filesProcessed,
        }).where(eq(libraryJobsTable.id, jobId));
        activeJobs.delete(jobId);
        return;
      }

      const batch = files.slice(i, i + BATCH);

      for (const f of batch) {
        const relativePath = path.relative(state.nasPath, f.fullPath).replace(/\\/g, "/");
        seenPaths.add(relativePath);
        state.currentPath = relativePath;

        const existing = existingByPath.get(relativePath);
        const unchanged = existing &&
          existing.sizeBytes === f.sizeBytes &&
          existing.modifiedAt?.getTime() === f.modifiedAt.getTime() &&
          state.profile !== "FULL"; // Full Verify always re-processes

        if (unchanged) {
          // Mark as UNCHANGED (just update lastScannedAt)
          await db.update(mediaFilesTable)
            .set({ lastScanAction: "UNCHANGED" as ScanAction, lastScannedAt: scanStartedAt })
            .where(eq(mediaFilesTable.id, existing!.id));
          state.counters.unchanged++;
        } else {
          // Need to process — hash the file
          state.phase = "hashing";
          const contentHash = await hashFile(f.fullPath);
          state.counters.hashed++;

          let action: ScanAction;
          let targetId: number | undefined;

          if (!existing) {
            // Check if it's a move (hash matches a different path)
            const movedFromId = contentHash ? existingByHash.get(contentHash) : undefined;
            if (movedFromId !== undefined) {
              action = "MOVED";
              targetId = movedFromId;
              // Remove old path from existingByHash to prevent double-move
              if (contentHash) existingByHash.delete(contentHash);
            } else {
              action = "NEW";
            }
          } else {
            action = "MODIFIED";
            // Delete stale thumbnail
            const thumbDir = getThumbnailDir(state.nasPath);
            const oldThumb = path.join(thumbDir, thumbnailFilename(existing.id));
            try { fs.unlinkSync(oldThumb); } catch { /* gone */ }
          }

          // ── Extract metadata ─────────────────────────────────────────────
          state.phase = "metadata";
          const mediaType = classifyMediaType(f.ext);
          const mimeType  = guessMimeType(f.ext);

          let width: number | null = null, height: number | null = null;
          let orientation: number | null = null, durationSeconds: number | null = null;
          let dateTaken: Date | null = null, cameraMake: string | null = null;
          let cameraModel: string | null = null, lens: string | null = null;
          let iso: number | null = null, aperture: number | null = null;
          let exposure: string | null = null, focalLength: number | null = null;
          let flash: string | null = null, colorProfile: string | null = null;
          let gpsLatitude: number | null = null, gpsLongitude: number | null = null;
          let exifJson: Record<string, unknown> | null = null;
          let videoCodec: string | null = null, videoBitrate: number | null = null;
          let fps: number | null = null, audioCodec: string | null = null;
          let dateCreated: Date | null = null;
          let pageCount: number | null = null, pdfAuthor: string | null = null;
          let pdfTitle: string | null = null, pdfSubject: string | null = null;
          let pdfKeywords: string | null = null;

          if (mediaType === "photo") {
            const meta = await extractPhotoMeta(f.fullPath, f.ext);
            ({ width, height, orientation, dateTaken, cameraMake, cameraModel, lens,
               iso, aperture, exposure, focalLength, flash, colorProfile,
               gpsLatitude, gpsLongitude, exifJson } = meta);
          } else if (VIDEO_META_EXTS.has(f.ext)) {
            const meta = extractVideoMeta(f.fullPath);
            ({ width, height, durationSeconds, videoCodec, videoBitrate, fps, audioCodec, dateCreated } = meta);
          } else if (f.ext === "pdf") {
            const meta = await extractPdfMeta(f.fullPath);
            ({ pageCount, pdfAuthor, pdfTitle, pdfSubject, pdfKeywords } = meta);
          }

          const fileValues = {
            nasPath: state.nasPath, relativePath,
            name: f.name, extension: f.ext, mimeType, mediaType,
            sizeBytes: f.sizeBytes, modifiedAt: f.modifiedAt,
            width, height, orientation, durationSeconds,
            dateTaken, cameraMake, cameraModel, lens, iso, aperture,
            exposure, focalLength, flash, colorProfile, gpsLatitude, gpsLongitude, exifJson,
            videoCodec, videoBitrate, fps, audioCodec, dateCreated,
            pageCount, pdfAuthor, pdfTitle, pdfSubject, pdfKeywords,
            contentHash, lastScanAction: action as string, lastScannedAt: scanStartedAt,
            thumbnailPath: null, thumbnailGeneratedAt: null, indexedAt: new Date(),
          };

          if (action === "MOVED" && targetId !== undefined) {
            // Update the existing record's path + metadata
            await db.update(mediaFilesTable).set({
              relativePath, name: f.name, sizeBytes: f.sizeBytes, modifiedAt: f.modifiedAt,
              lastScanAction: "MOVED", lastScannedAt: scanStartedAt, indexedAt: new Date(),
            }).where(eq(mediaFilesTable.id, targetId));
            state.counters.moved++;
          } else {
            await db.insert(mediaFilesTable).values(fileValues).onConflictDoUpdate({
              target: [mediaFilesTable.nasPath, mediaFilesTable.relativePath],
              set: { ...fileValues },
            });
            if (action === "NEW") state.counters.new++;
            else state.counters.modified++;
          }

          state.phase = "indexing";
        }

        state.filesProcessed++;
        tickSpeed(state);
      }

      // Persist progress every batch
      await db.update(libraryJobsTable)
        .set({ processedFiles: state.filesProcessed })
        .where(eq(libraryJobsTable.id, jobId));
    }

    // ── Phase: detecting deletions ─────────────────────────────────────────
    state.phase = "detecting_deletions";

    // Any DB record for this nasPath not seen in this scan → DELETED
    const deletedRows = await db.update(mediaFilesTable)
      .set({ lastScanAction: "DELETED", lastScannedAt: scanStartedAt })
      .where(and(
        eq(mediaFilesTable.nasPath, state.nasPath),
        lt(mediaFilesTable.lastScannedAt, scanStartedAt),
      ))
      .returning({ id: mediaFilesTable.id });

    // Only count paths that weren't seen
    let deletedCount = 0;
    for (const row of deletedRows) {
      // We need to double-check via seenPaths — but since we updated lastScannedAt for seen files above,
      // any record with lastScannedAt < scanStartedAt was not seen in this scan
      deletedCount++;
    }
    state.counters.deleted = deletedCount;

    // ── Phase: finalizing ─────────────────────────────────────────────────
    state.phase = "finalizing";
    const elapsedMs = Date.now() - state.startedAt.getTime();
    const previousElapsedMs = await getPreviousElapsedMs(state.nasPath, state.profile);

    const summary: JobSummary = {
      newFiles:            state.counters.new,
      modifiedFiles:       state.counters.modified,
      movedFiles:          state.counters.moved,
      deletedFiles:        state.counters.deleted,
      unchangedFiles:      state.counters.unchanged,
      hashedFiles:         state.counters.hashed,
      thumbnailsGenerated: state.counters.thumbnails,
      elapsedMs,
      previousElapsedMs,
    };

    await db.update(libraryJobsTable).set({
      status:         "DONE",
      finishedAt:     new Date(),
      processedFiles: state.filesProcessed,
      totalFiles:     state.filesTotal,
      summary,
    }).where(eq(libraryJobsTable.id, jobId));

    activeJobs.delete(jobId);

  } catch (err: any) {
    await failJob(jobId, "ERROR", err?.message ?? "Unknown error");
  }
}

// ── Thumbnail backfill job ────────────────────────────────────────────────────

const THUMB_BATCH = 50;

async function runThumbnailJob(state: ActiveJobState): Promise<void> {
  const jobId   = state.id;
  const nasPath = state.nasPath;

  state.phase = "thumbnailing";

  try {
    // Check NAS
    if (!isNasAvailable(nasPath)) {
      await failJob(jobId, "NAS_OFFLINE", "NAS path is not accessible");
      return;
    }

    // Count total files that need thumbnails
    const [{ count: totalCount }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(mediaFilesTable)
      .where(and(
        eq(mediaFilesTable.nasPath, nasPath),
        isNull(mediaFilesTable.thumbnailPath),
        or(
          eq(mediaFilesTable.mediaType, "photo"),
          eq(mediaFilesTable.mediaType, "video"),
          eq(mediaFilesTable.extension, "pdf"),
        ),
      ));

    state.filesTotal = totalCount ?? 0;
    state.filesProcessed = 0;

    await db.update(libraryJobsTable)
      .set({ totalFiles: state.filesTotal, startedAt: state.startedAt })
      .where(eq(libraryJobsTable.id, jobId));

    // Cursor-based batch processing
    let cursor = 0;

    while (true) {
      // Pause handling
      if (state.pauseRequested) {
        await db.update(libraryJobsTable).set({
          status: "PAUSED",
          pausedAt: new Date(),
          cursor: String(cursor),
          processedFiles: state.filesProcessed,
        }).where(eq(libraryJobsTable.id, jobId));
        // Wait until resume or cancel
        while (state.pauseRequested && !state.cancelRequested) {
          await new Promise((r) => setTimeout(r, 500));
        }
        if (!state.cancelRequested) {
          await db.update(libraryJobsTable)
            .set({ status: "RUNNING", pausedAt: null })
            .where(eq(libraryJobsTable.id, jobId));
        }
      }

      if (state.cancelRequested) {
        await db.update(libraryJobsTable).set({
          status:             "CANCELLED",
          cancellationReason: state.cancellationReason ?? "USER_CANCELLED",
          finishedAt:         new Date(),
          processedFiles:     state.filesProcessed,
        }).where(eq(libraryJobsTable.id, jobId));
        activeJobs.delete(jobId);
        return;
      }

      // Fetch next batch
      const batch = await db.select({
        id:           mediaFilesTable.id,
        relativePath: mediaFilesTable.relativePath,
        extension:    mediaFilesTable.extension,
      })
        .from(mediaFilesTable)
        .where(and(
          eq(mediaFilesTable.nasPath, nasPath),
          isNull(mediaFilesTable.thumbnailPath),
          gt(mediaFilesTable.id, cursor),
          or(
            eq(mediaFilesTable.mediaType, "photo"),
            eq(mediaFilesTable.mediaType, "video"),
            eq(mediaFilesTable.extension, "pdf"),
          ),
        ))
        .orderBy(mediaFilesTable.id)
        .limit(THUMB_BATCH);

      if (batch.length === 0) break;

      for (const file of batch) {
        cursor = file.id;

        if (state.cancelRequested) break;

        const sourcePath = path.join(nasPath, file.relativePath);
        state.currentPath = file.relativePath;
        tickSpeed(state);

        try {
          const result = await generateThumbnail(file.id, sourcePath, file.extension, nasPath);
          if (!result.error && result.destPath) {
            await db.update(mediaFilesTable).set({
              thumbnailPath:        result.destPath,
              thumbnailGeneratedAt: new Date(),
            }).where(eq(mediaFilesTable.id, file.id));
            state.counters.thumbnails++;
          }
        } catch {
          // Skip failed thumbnails — don't abort the job
        }

        state.filesProcessed++;
      }

      // Update progress in DB periodically
      await db.update(libraryJobsTable)
        .set({ processedFiles: state.filesProcessed, cursor: String(cursor) })
        .where(eq(libraryJobsTable.id, jobId));
    }

    // Done
    const elapsedMs = Date.now() - state.startedAt.getTime();
    const summary: JobSummary = {
      newFiles: 0, modifiedFiles: 0, movedFiles: 0, deletedFiles: 0, unchangedFiles: 0,
      hashedFiles: 0,
      thumbnailsGenerated: state.counters.thumbnails,
      elapsedMs,
      previousElapsedMs: null,
    };

    await db.update(libraryJobsTable).set({
      status:         "DONE",
      finishedAt:     new Date(),
      processedFiles: state.filesProcessed,
      totalFiles:     state.filesTotal,
      summary,
    }).where(eq(libraryJobsTable.id, jobId));

    activeJobs.delete(jobId);

  } catch (err: any) {
    await failJob(jobId, "ERROR", err?.message ?? "Unknown error");
  }
}

// ── Fail a job ────────────────────────────────────────────────────────────────

async function failJob(jobId: number, reason: CancellationReason, message: string): Promise<void> {
  await db.update(libraryJobsTable).set({
    status:             "FAILED",
    cancellationReason: reason,
    error:              message,
    finishedAt:         new Date(),
  }).where(eq(libraryJobsTable.id, jobId)).catch(() => {});
  activeJobs.delete(jobId);
}

// ── Interrupt recovery (call on server start) ─────────────────────────────────

export async function recoverInterruptedJobs(): Promise<void> {
  const { rowCount } = await db.update(libraryJobsTable).set({
    status:             "FAILED",
    cancellationReason: "ERROR",
    error:              "Interrupted by server restart",
    finishedAt:         new Date(),
  }).where(eq(libraryJobsTable.status, "RUNNING"));

  if (rowCount && rowCount > 0) {
    console.warn(`[library-engine] Marked ${rowCount} interrupted job(s) as failed`);
  }
}
