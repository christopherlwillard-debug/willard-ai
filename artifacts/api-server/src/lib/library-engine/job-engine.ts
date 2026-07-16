import * as fs from "fs";
import * as path from "path";
import { db } from "@workspace/db";
import { mediaFilesTable, libraryJobsTable, appSettingsTable } from "@workspace/db";
import { eq, and, lt, sql, isNull, or, gt } from "drizzle-orm";
import {
  type JobType, type JobProfile, type JobPriority, type JobStatus,
  type CancellationReason, type ScanPhase, type ScanAction,
  type ActiveJobState, type ProgressEvent, type JobSummary, type JobCounters,
  type ScanPerformance, type ThrottleProfile, type SkippedFile,
  EMPTY_COUNTERS, PRIORITY_RANK, THROTTLE_PROFILES, SCANNER_VERSION, MAX_SKIPPED_LISTED,
} from "./types";
import {
  walkNas, classifyMediaType, guessMimeType,
  extractPhotoMeta, extractVideoMeta, extractPdfMeta, hashFile,
  computeQuickFingerprint, sortFilesByPriority,
  PHOTO_EXTS, VIDEO_META_EXTS,
} from "./indexer";
import { getWillardAIDir } from "../nas-storage";
import { recordActivity, describeChanges } from "../library-activity";
import { getThumbnailDir, thumbnailFilename, generateThumbnail, qualityPreset } from "../thumbnail-engine";

// ── In-memory state ───────────────────────────────────────────────────────────

const activeJobs = new Map<number, ActiveJobState>();

// ── Thumbnail priority queue (folder-aware boosting) ──────────────────────────
// Maps nasPath → Set of file IDs that should be processed ASAP before the
// normal cursor-based sweep continues. Populated via addThumbnailPriority().

const thumbPriorityIds = new Map<string, Set<number>>();

export function addThumbnailPriority(nasPath: string, fileIds: number[]): void {
  const s = thumbPriorityIds.get(nasPath) ?? new Set<number>();
  for (const id of fileIds) s.add(id);
  thumbPriorityIds.set(nasPath, s);
}

export function clearThumbnailPriority(nasPath: string): void {
  thumbPriorityIds.delete(nasPath);
}

// Last completed job's final progress (with summary), so the UI can show the
// scan-summary card after the job leaves the in-memory active map. Cleared
// when a new job starts.
let lastCompletedProgress: ProgressEvent | null = null;

export function getLastCompletedProgress(): ProgressEvent | null {
  return lastCompletedProgress;
}

function recordCompletion(state: ActiveJobState, summary: JobSummary): void {
  lastCompletedProgress = {
    jobId: state.id,
    status: "DONE",
    phase: "finalizing",
    profile: state.profile,
    progress: 100,
    filesProcessed: state.filesProcessed,
    filesTotal: state.filesTotal,
    currentPath: "",
    etaSeconds: 0,
    speed: 0,
    counters: { ...state.counters },
    summary,
  };
}

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

// ── Performance throttle (High / Balanced / Low from Settings) ───────────────

async function getThrottleProfile(): Promise<ThrottleProfile> {
  try {
    const [row] = await db.select({ perf: appSettingsTable.scanPerformance })
      .from(appSettingsTable).limit(1);
    const perf = (row?.perf ?? "BALANCED") as ScanPerformance;
    return THROTTLE_PROFILES[perf] ?? THROTTLE_PROFILES.BALANCED;
  } catch {
    return THROTTLE_PROFILES.BALANCED;
  }
}

function recordSkip(state: ActiveJobState, relPath: string, reason: string): void {
  state.counters.skipped++;
  if (state.skippedList.length < MAX_SKIPPED_LISTED) {
    state.skippedList.push({ path: relPath, reason });
  }
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

  // A new job supersedes the previous completion summary
  lastCompletedProgress = null;

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
    throttle:         await getThrottleProfile(),
    skippedList:      [],
  };
  activeJobs.set(job.id, state);

  // Run async without blocking the response
  if (opts.jobType === "THUMBNAILS") {
    void runThumbnailJob(state);
  } else if (opts.jobType === "METADATA") {
    void runMetadataRefreshJob(state);
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

  // Restore counters + scan anchor persisted at pause time so the resumed run
  // continues exactly where it stopped (never from the beginning).
  const saved = (job.summary ?? {}) as Partial<JobSummary> & { partialCounters?: JobCounters };
  const restoredCounters = saved.partialCounters ?? EMPTY_COUNTERS();
  const restoredSkipped  = (saved.skippedList ?? []) as SkippedFile[];
  const cursorIndex = job.cursor ? parseInt(job.cursor, 10) || 0 : 0;
  const scanStartedAt = saved.scanStartedAt ? new Date(saved.scanStartedAt) : undefined;

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
    counters:         { ...EMPTY_COUNTERS(), ...restoredCounters },
    speedWindow:      [],
    throttle:         await getThrottleProfile(),
    skippedList:      restoredSkipped,
  };
  activeJobs.set(job.id, state);

  if (job.jobType === "THUMBNAILS") {
    void runThumbnailJob(state);
  } else if (job.jobType === "METADATA") {
    void runMetadataRefreshJob(state);
  } else {
    void runScanJob(state, job.rootPath ?? undefined, cursorIndex, scanStartedAt);
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

async function runScanJob(
  state: ActiveJobState,
  rootPath?: string,
  startCursor = 0,
  resumedScanStartedAt?: Date,
): Promise<void> {
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
    walkNas(path.resolve(scanRoot), skipDirs, files, undefined, (skippedPath, reason) => {
      recordSkip(state, path.relative(state.nasPath, skippedPath).replace(/\\/g, "/"), reason);
    });

    // Prioritized ordering: photos → videos → documents → audio → other;
    // newest-modified first within each category. Deterministic, so a stored
    // cursor index remains meaningful across pause/resume.
    sortFilesByPriority(files);

    state.filesTotal = files.length;
    state.filesProcessed = Math.min(startCursor, files.length);
    await db.update(libraryJobsTable)
      .set({ totalFiles: files.length })
      .where(eq(libraryJobsTable.id, jobId));

    // Reuse the original scan anchor on resume so files indexed before the
    // pause are not misdetected as deleted at the end of this run.
    const scanStartedAt = resumedScanStartedAt ?? new Date();

    // Persist the anchor immediately (survives pause and server restart)
    await db.update(libraryJobsTable)
      .set({ summary: { scanStartedAt: scanStartedAt.toISOString() } })
      .where(eq(libraryJobsTable.id, jobId));

    // ── Phase: indexing ───────────────────────────────────────────────────
    state.phase = "indexing";

    // Load all existing paths from DB for this NAS (for move detection)
    const existingByPath = new Map<string, { id: number; sizeBytes: number; modifiedAt: Date | null; contentHash: string | null; quickFingerprint: string | null; scannerVersion: number }>();
    const dbRows = await db.select({
      id: mediaFilesTable.id,
      relativePath: mediaFilesTable.relativePath,
      sizeBytes: mediaFilesTable.sizeBytes,
      modifiedAt: mediaFilesTable.modifiedAt,
      contentHash: mediaFilesTable.contentHash,
      quickFingerprint: mediaFilesTable.quickFingerprint,
      scannerVersion: mediaFilesTable.scannerVersion,
    }).from(mediaFilesTable).where(eq(mediaFilesTable.nasPath, state.nasPath));

    for (const row of dbRows) {
      existingByPath.set(row.relativePath, row);
    }

    // Move detection maps. Preferred: cheap fingerprint match (mass renames
    // never require re-hashing or re-extracting metadata). Fallback for rows
    // indexed before fingerprints existed: full-hash match.
    const existingByFingerprint = new Map<string, number>(); // fingerprint → db id
    const existingByHash        = new Map<string, number>(); // sha256 → db id (legacy rows)
    for (const row of dbRows) {
      if (row.quickFingerprint) existingByFingerprint.set(row.quickFingerprint, row.id);
      else if (row.contentHash) existingByHash.set(row.contentHash, row.id);
    }
    const legacySizes = new Set<number>(); // sizes of legacy rows (hash-only)
    for (const row of dbRows) {
      if (!row.quickFingerprint && row.contentHash) legacySizes.add(row.sizeBytes);
    }

    // Track which DB paths we've seen (for deletion detection)
    const seenPaths = new Set<string>();

    const BATCH = state.throttle.batchSize;

    for (let i = startCursor; i < files.length; i += BATCH) {
      // ── Pause/cancel check ─────────────────────────────────────────────
      if (state.cancelRequested) {
        await db.update(libraryJobsTable).set({
          status: "CANCELLED",
          cancellationReason: state.cancellationReason ?? "USER_CANCELLED",
          cursor: String(i),
          summary: buildPartialSummary(state, scanStartedAt),
          finishedAt: new Date(),
        }).where(eq(libraryJobsTable.id, jobId));
        activeJobs.delete(jobId);
        return;
      }

      if (state.pauseRequested) {
        // Store cursor (file index) + counters so we can resume exactly here
        await db.update(libraryJobsTable).set({
          status:         "PAUSED",
          cursor:         String(i),
          pausedAt:       new Date(),
          processedFiles: state.filesProcessed,
          summary:        buildPartialSummary(state, scanStartedAt),
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
          // Metadata cache hit — never reopen the file. Just stamp it as seen.
          await db.update(mediaFilesTable)
            .set({ lastScanAction: "UNCHANGED" as ScanAction, lastScannedAt: scanStartedAt })
            .where(eq(mediaFilesTable.id, existing!.id));
          state.counters.unchanged++;
        } else {
          // Cheap first: fast content fingerprint (first/last 64 KB + size).
          state.phase = "hashing";
          let quickFingerprint = await computeQuickFingerprint(f.fullPath, f.sizeBytes);
          if (quickFingerprint === null) {
            recordSkip(state, relativePath, "Could not read file (permission denied or unreadable)");
            state.filesProcessed++;
            tickSpeed(state);
            continue;
          }

          let action: ScanAction;
          let targetId: number | undefined;
          let contentHash: string | null = null;

          if (!existing) {
            // Move detection stage 1: fingerprint match (cheap)
            const movedFromId = existingByFingerprint.get(quickFingerprint);
            if (movedFromId !== undefined) {
              action = "MOVED";
              targetId = movedFromId;
              existingByFingerprint.delete(quickFingerprint);
            } else if (legacySizes.has(f.sizeBytes)) {
              // Stage 2 (only for legacy rows without fingerprints): full hash
              contentHash = await hashFile(f.fullPath);
              state.counters.hashed++;
              const legacyId = contentHash ? existingByHash.get(contentHash) : undefined;
              if (legacyId !== undefined) {
                action = "MOVED";
                targetId = legacyId;
                if (contentHash) existingByHash.delete(contentHash);
              } else {
                action = "NEW";
              }
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
          let metaError: string | null = null;

          const extractAll = async (): Promise<void> => {
            if (mediaType === "photo") {
              const meta = await extractPhotoMeta(f.fullPath, f.ext);
              ({ width, height, orientation, dateTaken, cameraMake, cameraModel, lens,
                 iso, aperture, exposure, focalLength, flash, colorProfile,
                 gpsLatitude, gpsLongitude, exifJson } = meta);
              metaError = meta.error;
            } else if (VIDEO_META_EXTS.has(f.ext)) {
              const meta = extractVideoMeta(f.fullPath);
              ({ width, height, durationSeconds, videoCodec, videoBitrate, fps, audioCodec, dateCreated } = meta);
              metaError = meta.error;
            } else if (f.ext === "pdf") {
              const meta = await extractPdfMeta(f.fullPath);
              ({ pageCount, pdfAuthor, pdfTitle, pdfSubject, pdfKeywords } = meta);
              metaError = meta.error;
            }
          };
          await extractAll();

          // ── Conflict detection: file changed while being indexed ─────────
          // Re-stat after extraction; if size/mtime moved under us, re-read
          // the fingerprint and metadata once so we never store a mix of
          // old-file and new-file values.
          try {
            const after = fs.statSync(f.fullPath);
            if (after.size !== f.sizeBytes || after.mtime.getTime() !== f.modifiedAt.getTime()) {
              f.sizeBytes = after.size;
              f.modifiedAt = after.mtime;
              const refreshedFp = await computeQuickFingerprint(f.fullPath, f.sizeBytes);
              if (refreshedFp !== null) quickFingerprint = refreshedFp;
              await extractAll();
              state.counters.reanalyzed++;
            }
          } catch {
            // File vanished mid-index — deletion detection will handle it on
            // the next pass; keep what we read for now.
          }

          // Problem file: metadata could not be extracted. The file is still
          // indexed (name/size/dates) but counted + listed with a plain reason
          // so the scan never stalls on corrupt or password-protected files.
          if (metaError) {
            recordSkip(state, relativePath, metaError);
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
            contentHash, quickFingerprint, scannerVersion: SCANNER_VERSION,
            lastScanAction: action as string, lastScannedAt: scanStartedAt,
            thumbnailPath: null, thumbnailGeneratedAt: null, indexedAt: new Date(),
          };

          if (action === "MOVED" && targetId !== undefined) {
            // Move/rename: update the path on the existing record. All
            // previously extracted metadata is kept — nothing is re-processed.
            await db.update(mediaFilesTable).set({
              relativePath, name: f.name, sizeBytes: f.sizeBytes, modifiedAt: f.modifiedAt,
              quickFingerprint,
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

      // Persist progress + cursor every batch (survives crashes/restarts)
      await db.update(libraryJobsTable)
        .set({ processedFiles: state.filesProcessed, cursor: String(Math.min(i + BATCH, files.length)) })
        .where(eq(libraryJobsTable.id, jobId));

      // Performance throttle: brief pause between batches on Balanced/Low so
      // the NAS stays responsive for other users during the scan.
      if (state.throttle.batchDelayMs > 0) {
        await new Promise((r) => setTimeout(r, state.throttle.batchDelayMs));
      }
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

    // ── Duplicate detection (two-stage: size+fingerprint groups → confirm with
    //    full SHA-256 only for candidates) ──────────────────────────────────
    let duplicateGroups = 0;
    try {
      duplicateGroups = await detectDuplicates(state);
    } catch { /* non-fatal — duplicates are informational */ }

    // ── Phase: finalizing ─────────────────────────────────────────────────
    state.phase = "finalizing";
    const elapsedMs = Date.now() - state.startedAt.getTime();
    const previousElapsedMs = await getPreviousElapsedMs(state.nasPath, state.profile);

    // Per-category counts for this NAS (for the summary card)
    const categoryRows = await db.select({
      mediaType: mediaFilesTable.mediaType,
      count: sql<number>`count(*)::int`,
    }).from(mediaFilesTable)
      .where(and(
        eq(mediaFilesTable.nasPath, state.nasPath),
        sql`${mediaFilesTable.lastScanAction} IS DISTINCT FROM 'DELETED'`,
      ))
      .groupBy(mediaFilesTable.mediaType);
    const categories: Record<string, number> = {};
    for (const row of categoryRows) categories[row.mediaType] = row.count;

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
      skippedFiles:        state.counters.skipped,
      skippedList:         state.skippedList,
      duplicateGroups,
      scanStartedAt:       scanStartedAt.toISOString(),
      categories,
    };

    await db.update(libraryJobsTable).set({
      status:         "DONE",
      finishedAt:     new Date(),
      processedFiles: state.filesProcessed,
      totalFiles:     state.filesTotal,
      summary,
    }).where(eq(libraryJobsTable.id, jobId));

    recordCompletion(state, summary);
    activeJobs.delete(jobId);

    // ── Auto-start thumbnail backfill after scan ───────────────────────────
    try {
      const [{ missing }] = await db
        .select({ missing: sql<number>`count(*)::int` })
        .from(mediaFilesTable)
        .where(and(
          eq(mediaFilesTable.nasPath, state.nasPath),
          isNull(mediaFilesTable.thumbnailPath),
          or(
            eq(mediaFilesTable.mediaType, "photo"),
            eq(mediaFilesTable.mediaType, "video"),
            eq(mediaFilesTable.extension, "pdf"),
          ),
        ));
      const [settingsRow] = await db.select({ paused: appSettingsTable.indexingPaused })
        .from(appSettingsTable).limit(1);
      const isThumbRunning = [...activeJobs.values()].some(
        j => j.jobType === "THUMBNAILS" && j.nasPath === state.nasPath,
      );
      if ((missing ?? 0) > 0 && !isThumbRunning && !settingsRow?.paused) {
        void startJob({ jobType: "THUMBNAILS", profile: "FULL", nasPath: state.nasPath });
      }
    } catch { /* non-fatal */ }

    // ── Library Activity feed entry (only when something actually changed) ──
    const changeText = describeChanges({
      newFiles: state.counters.new,
      modifiedFiles: state.counters.modified,
      movedFiles: state.counters.moved,
      deletedFiles: state.counters.deleted,
    });
    if (changeText) {
      await recordActivity(state.nasPath, "scan_summary", changeText, {
        jobId,
        newFiles: state.counters.new,
        modifiedFiles: state.counters.modified,
        movedFiles: state.counters.moved,
        deletedFiles: state.counters.deleted,
        elapsedMs,
      });
    }

  } catch (err: any) {
    await failJob(jobId, "ERROR", err?.message ?? "Unknown error");
  }
}

// Partial summary persisted on pause/cancel so a resumed run keeps its
// counters, skipped list, and scan anchor.
function buildPartialSummary(state: ActiveJobState, scanStartedAt: Date): Record<string, unknown> {
  return {
    scanStartedAt: scanStartedAt.toISOString(),
    partialCounters: state.counters,
    skippedList: state.skippedList,
  };
}

// ── Duplicate detection ───────────────────────────────────────────────────────
// Stage 1: group by (size, fingerprint) — cheap, no file reads needed here
// because fingerprints were computed during indexing. Stage 2: for groups with
// 2+ members, confirm with full SHA-256 (hashing only rows that lack one).
// Returns the number of confirmed duplicate groups.

async function detectDuplicates(state: ActiveJobState): Promise<number> {
  const candidates = await db.select({
    id: mediaFilesTable.id,
    relativePath: mediaFilesTable.relativePath,
    sizeBytes: mediaFilesTable.sizeBytes,
    quickFingerprint: mediaFilesTable.quickFingerprint,
    contentHash: mediaFilesTable.contentHash,
  }).from(mediaFilesTable)
    .where(and(
      eq(mediaFilesTable.nasPath, state.nasPath),
      sql`${mediaFilesTable.lastScanAction} IS DISTINCT FROM 'DELETED'`,
      sql`${mediaFilesTable.quickFingerprint} IS NOT NULL`,
    ));

  // Group by size + fingerprint
  const groups = new Map<string, typeof candidates>();
  for (const row of candidates) {
    const key = `${row.sizeBytes}:${row.quickFingerprint}`;
    const g = groups.get(key);
    if (g) g.push(row); else groups.set(key, [row]);
  }

  let confirmedGroups = 0;
  for (const [, members] of groups) {
    if (members.length < 2) continue;
    if (state.cancelRequested) break;

    // Confirm with full hash — only hash members that don't have one yet
    const byHash = new Map<string, number>();
    for (const m of members) {
      let hash = m.contentHash;
      if (!hash) {
        hash = await hashFile(path.join(state.nasPath, m.relativePath));
        if (hash) {
          state.counters.hashed++;
          await db.update(mediaFilesTable).set({ contentHash: hash })
            .where(eq(mediaFilesTable.id, m.id));
        }
      }
      if (hash) byHash.set(hash, (byHash.get(hash) ?? 0) + 1);
    }
    for (const [, n] of byHash) {
      if (n >= 2) confirmedGroups++;
    }
  }
  return confirmedGroups;
}

// ── Metadata refresh job (selective re-processing) ────────────────────────────
// Re-extracts metadata only for items indexed with an older scanner version.
// The single canonical media record is updated in place — never duplicated,
// never a full library rebuild.

async function runMetadataRefreshJob(state: ActiveJobState): Promise<void> {
  const jobId = state.id;
  state.phase = "metadata";

  try {
    if (!isNasAvailable(state.nasPath)) {
      await failJob(jobId, "NAS_OFFLINE", "NAS path is not accessible");
      return;
    }

    const outdatedFilter = and(
      eq(mediaFilesTable.nasPath, state.nasPath),
      lt(mediaFilesTable.scannerVersion, SCANNER_VERSION),
      sql`${mediaFilesTable.lastScanAction} IS DISTINCT FROM 'DELETED'`,
    );

    const [{ count: total }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(mediaFilesTable).where(outdatedFilter);

    state.filesTotal = total ?? 0;
    await db.update(libraryJobsTable).set({ totalFiles: state.filesTotal })
      .where(eq(libraryJobsTable.id, jobId));

    const BATCH = state.throttle.batchSize;
    let reprocessed = 0;

    for (;;) {
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
        await db.update(libraryJobsTable).set({
          status: "PAUSED", pausedAt: new Date(), processedFiles: state.filesProcessed,
        }).where(eq(libraryJobsTable.id, jobId));
        activeJobs.delete(jobId);
        return;
      }

      const rows = await db.select({
        id: mediaFilesTable.id,
        relativePath: mediaFilesTable.relativePath,
        extension: mediaFilesTable.extension,
        mediaType: mediaFilesTable.mediaType,
        sizeBytes: mediaFilesTable.sizeBytes,
      }).from(mediaFilesTable).where(outdatedFilter).limit(BATCH);

      if (rows.length === 0) break;

      for (const row of rows) {
        const fullPath = path.join(state.nasPath, row.relativePath);
        state.currentPath = row.relativePath;

        if (!fs.existsSync(fullPath)) {
          // File gone — leave for the next scan's deletion detection, but bump
          // the version so this job terminates.
          await db.update(mediaFilesTable).set({ scannerVersion: SCANNER_VERSION })
            .where(eq(mediaFilesTable.id, row.id));
          state.filesProcessed++;
          continue;
        }

        const updates: Record<string, unknown> = { scannerVersion: SCANNER_VERSION };

        if (row.mediaType === "photo") {
          const meta = await extractPhotoMeta(fullPath, row.extension);
          if (meta.error) recordSkip(state, row.relativePath, meta.error);
          else Object.assign(updates, {
            width: meta.width, height: meta.height, orientation: meta.orientation,
            dateTaken: meta.dateTaken, cameraMake: meta.cameraMake, cameraModel: meta.cameraModel,
            lens: meta.lens, iso: meta.iso, aperture: meta.aperture, exposure: meta.exposure,
            focalLength: meta.focalLength, flash: meta.flash, colorProfile: meta.colorProfile,
            gpsLatitude: meta.gpsLatitude, gpsLongitude: meta.gpsLongitude, exifJson: meta.exifJson,
          });
        } else if (VIDEO_META_EXTS.has(row.extension)) {
          const meta = extractVideoMeta(fullPath);
          if (meta.error) recordSkip(state, row.relativePath, meta.error);
          else Object.assign(updates, {
            width: meta.width, height: meta.height, durationSeconds: meta.durationSeconds,
            videoCodec: meta.videoCodec, videoBitrate: meta.videoBitrate, fps: meta.fps,
            audioCodec: meta.audioCodec, dateCreated: meta.dateCreated,
          });
        } else if (row.extension === "pdf") {
          const meta = await extractPdfMeta(fullPath);
          if (meta.error) recordSkip(state, row.relativePath, meta.error);
          else Object.assign(updates, {
            pageCount: meta.pageCount, pdfAuthor: meta.pdfAuthor, pdfTitle: meta.pdfTitle,
            pdfSubject: meta.pdfSubject, pdfKeywords: meta.pdfKeywords,
          });
        }

        await db.update(mediaFilesTable).set(updates).where(eq(mediaFilesTable.id, row.id));
        reprocessed++;
        state.filesProcessed++;
        tickSpeed(state);
      }

      await db.update(libraryJobsTable).set({ processedFiles: state.filesProcessed })
        .where(eq(libraryJobsTable.id, jobId));

      if (state.throttle.batchDelayMs > 0) {
        await new Promise((r) => setTimeout(r, state.throttle.batchDelayMs));
      }
    }

    const elapsedMs = Date.now() - state.startedAt.getTime();
    const summary: JobSummary = {
      newFiles: 0, modifiedFiles: 0, movedFiles: 0, deletedFiles: 0,
      unchangedFiles: 0, hashedFiles: 0, thumbnailsGenerated: 0,
      elapsedMs, previousElapsedMs: null,
      reprocessedFiles: reprocessed,
      skippedFiles: state.counters.skipped,
      skippedList: state.skippedList,
    };

    await db.update(libraryJobsTable).set({
      status: "DONE", finishedAt: new Date(),
      processedFiles: state.filesProcessed, totalFiles: state.filesTotal,
      summary,
    }).where(eq(libraryJobsTable.id, jobId));

    recordCompletion(state, summary);
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

    // Read thumbnail quality setting
    const [settingsRow] = await db
      .select({ thumbnailQuality: appSettingsTable.thumbnailQuality })
      .from(appSettingsTable).limit(1);
    const thumbQuality = settingsRow?.thumbnailQuality ?? "BALANCED";

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

    // Helper: pause/cancel handling
    const handlePauseCancel = async (): Promise<boolean> => {
      if (state.pauseRequested) {
        await db.update(libraryJobsTable).set({
          status: "PAUSED",
          pausedAt: new Date(),
          cursor: String(cursor),
          processedFiles: state.filesProcessed,
        }).where(eq(libraryJobsTable.id, jobId));
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
        return true; // cancelled
      }
      return false;
    };

    // Helper: process a single file
    const processFile = async (file: { id: number; relativePath: string; extension: string }): Promise<void> => {
      const sourcePath = path.join(nasPath, file.relativePath);
      state.currentPath = file.relativePath;
      tickSpeed(state);
      try {
        const result = await generateThumbnail(file.id, sourcePath, file.extension, nasPath, thumbQuality);
        if (!result.error && result.destPath) {
          await db.update(mediaFilesTable).set({
            thumbnailPath:        result.destPath,
            thumbnailGeneratedAt: new Date(),
          }).where(eq(mediaFilesTable.id, file.id));
          state.counters.thumbnails++;
        }
      } catch { /* skip failed — don't abort the job */ }
      state.filesProcessed++;
    };

    // ── Phase 1: drain priority queue (folder-prioritized files) ────────────
    const prioritySet = thumbPriorityIds.get(nasPath);
    if (prioritySet && prioritySet.size > 0) {
      const priorityList = [...prioritySet];
      clearThumbnailPriority(nasPath);

      for (let i = 0; i < priorityList.length; i += THUMB_BATCH) {
        if (await handlePauseCancel()) return;

        const batchIds = priorityList.slice(i, i + THUMB_BATCH);
        const files = await db.select({
          id: mediaFilesTable.id,
          relativePath: mediaFilesTable.relativePath,
          extension: mediaFilesTable.extension,
        }).from(mediaFilesTable)
          .where(and(
            eq(mediaFilesTable.nasPath, nasPath),
            isNull(mediaFilesTable.thumbnailPath),
            sql`${mediaFilesTable.id} = ANY(${sql.raw(`ARRAY[${batchIds.join(",")}]`)}::int[])`,
          ));

        for (const file of files) {
          if (state.cancelRequested) break;
          await processFile(file);
        }

        await db.update(libraryJobsTable)
          .set({ processedFiles: state.filesProcessed, cursor: String(cursor) })
          .where(eq(libraryJobsTable.id, jobId));
      }
    }

    // ── Phase 2: cursor-based sweep (favorites first, then photos/videos/docs) ─
    while (true) {
      if (await handlePauseCancel()) return;

      // Fetch next batch — favorites first, then by media type priority, then by id
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
        await processFile(file);
      }

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

    recordCompletion(state, summary);
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
