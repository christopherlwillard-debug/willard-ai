import * as fs from "fs";
import * as path from "path";
import { db } from "@workspace/db";
import { mediaFilesTable, libraryJobsTable, appSettingsTable, archivesTable } from "@workspace/db";
import { eq, and, lt, ne, sql, isNull, or, gt, inArray } from "drizzle-orm";
import {
  type JobType, type JobProfile, type JobPriority, type JobStatus,
  type CancellationReason, type ScanPhase, type ScanAction,
  type ActiveJobState, type ProgressEvent, type JobSummary, type JobCounters,
  type ScanPerformance, type ThrottleProfile, type SkippedFile, type ScanDiagnostics,
  EMPTY_COUNTERS, PRIORITY_RANK, THROTTLE_PROFILES, SCANNER_VERSION, MAX_SKIPPED_LISTED,
} from "./types";
import {
  walkNas, walkNasAsync, classifyMediaType, guessMimeType,
  extractPhotoMeta, extractVideoMeta, extractPdfMeta, hashFile,
  computeQuickFingerprint, sortFilesByPriority,
  PHOTO_EXTS, VIDEO_META_EXTS,
  ScanPriorityQueue,
  type DirCacheEntry, type FileEntry,
} from "./indexer";
import { type ScannerSettings, DEFAULT_SCANNER_SETTINGS } from "../system-filter";
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

// ── Library sequence counter ──────────────────────────────────────────────────
// Incremented after every successful DB batch flush so the UI can detect when
// new files have been written and re-fetch only the delta rather than reloading
// the entire library. Resets to 0 on server restart (intentional — the UI
// initialises its "last seen" value on the first poll, so any pending work
// from a previous session is picked up immediately).

let _librarySeq = 0;

export function bumpLibrarySeq(): void { _librarySeq++; }
export function getLibrarySeq(): number { return _librarySeq; }

// ── Startup gate ──────────────────────────────────────────────────────────────
// Defers background scans until the first authenticated UI request arrives, or
// until 30 seconds elapse — whichever is first.  This keeps the app instantly
// browsable at startup without competing with the UI for NAS I/O.

let _uiConnectedResolve: (() => void) | null = null;
const _uiConnectedPromise = new Promise<void>(resolve => {
  _uiConnectedResolve = resolve;
  const t = setTimeout(resolve, 30_000);
  (t as any).unref?.();
});

export function notifyUiConnected(): void {
  if (_uiConnectedResolve) { _uiConnectedResolve(); _uiConnectedResolve = null; }
}

export function waitForUiConnected(): Promise<void> {
  return _uiConnectedPromise;
}

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

/** Returns the profile of the currently active (non-paused, non-cancelled) job, or null if idle. */
export function getActiveJobProfile(): import("./types").JobProfile | null {
  for (const [, state] of activeJobs) {
    if (!state.pauseRequested && !state.cancelRequested) return state.profile;
  }
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

// ── Concurrency semaphore ─────────────────────────────────────────────────────
// Limits the number of concurrent async file-I/O operations (fingerprinting +
// metadata extraction).  On a NAS, having 6–8 concurrent reads saturates the
// SMB connection without overwhelming the NAS CPU or RAM.

function createSemaphore(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  return function run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const execute = () => {
        active++;
        fn().then(resolve, reject).finally(() => {
          active--;
          if (queue.length > 0) queue.shift()!();
        });
      };
      if (active < n) execute();
      else queue.push(execute);
    });
  };
}

// ── Batch upsert set (excluded.* references) ──────────────────────────────────
// Used by onConflictDoUpdate for multi-row batch inserts so each row's own
// values are applied (not the first row's values for all).

const MEDIA_FILE_UPSERT_SET = {
  name:                 sql`excluded.name`,
  extension:            sql`excluded.extension`,
  mimeType:             sql`excluded.mime_type`,
  mediaType:            sql`excluded.media_type`,
  sizeBytes:            sql`excluded.size_bytes`,
  modifiedAt:           sql`excluded.modified_at`,
  width:                sql`excluded.width`,
  height:               sql`excluded.height`,
  orientation:          sql`excluded.orientation`,
  durationSeconds:      sql`excluded.duration_seconds`,
  dateTaken:            sql`excluded.date_taken`,
  cameraMake:           sql`excluded.camera_make`,
  cameraModel:          sql`excluded.camera_model`,
  lens:                 sql`excluded.lens`,
  iso:                  sql`excluded.iso`,
  aperture:             sql`excluded.aperture`,
  exposure:             sql`excluded.exposure`,
  focalLength:          sql`excluded.focal_length`,
  flash:                sql`excluded.flash`,
  colorProfile:         sql`excluded.color_profile`,
  gpsLatitude:          sql`excluded.gps_latitude`,
  gpsLongitude:         sql`excluded.gps_longitude`,
  exifJson:             sql`excluded.exif_json`,
  videoCodec:           sql`excluded.video_codec`,
  videoBitrate:         sql`excluded.video_bitrate`,
  fps:                  sql`excluded.fps`,
  audioCodec:           sql`excluded.audio_codec`,
  dateCreated:          sql`excluded.date_created`,
  pageCount:            sql`excluded.page_count`,
  pdfAuthor:            sql`excluded.pdf_author`,
  pdfTitle:             sql`excluded.pdf_title`,
  pdfSubject:           sql`excluded.pdf_subject`,
  pdfKeywords:          sql`excluded.pdf_keywords`,
  contentHash:          sql`excluded.content_hash`,
  quickFingerprint:     sql`excluded.quick_fingerprint`,
  scannerVersion:       sql`excluded.scanner_version`,
  lastScanAction:       sql`excluded.last_scan_action`,
  lastScannedAt:        sql`excluded.last_scanned_at`,
  thumbnailPath:        sql`excluded.thumbnail_path`,
  thumbnailGeneratedAt: sql`excluded.thumbnail_generated_at`,
  indexedAt:            sql`excluded.indexed_at`,
} as const;

// ── Adaptive concurrency controller ──────────────────────────────────────────
// Tracks a rolling average of per-file I/O latency (last 50 samples) and the
// current queue depth.  Every CTRL_INTERVAL_MS it adjusts the active worker
// count by ±2, clamped to [MIN_WORKERS, profileCeiling].
//
// Logic:
//   avg latency > LATENCY_BACKOFF_MS  → back off (NAS is overwhelmed)
//   queue depth  === 0                → back off (workers are idle)
//   avg latency < LATENCY_CLIMB_MS
//   AND queue depth > 0               → climb (NAS has headroom)

const INITIAL_WORKERS    = 4;
const MIN_WORKERS        = 2;
const LATENCY_CLIMB_MS   = 20;
const LATENCY_BACKOFF_MS = 60;
const CTRL_INTERVAL_MS   = 5_000;
const LATENCY_WINDOW_MAX = 50;

class ConcurrencyController {
  private readonly samples: number[] = [];
  private _count: number;
  private readonly ceiling: number;

  constructor(initial: number, ceiling: number) {
    this._count  = Math.max(MIN_WORKERS, Math.min(initial, ceiling));
    this.ceiling = Math.max(MIN_WORKERS, ceiling);
  }

  get count(): number { return this._count; }

  recordLatency(ms: number): void {
    this.samples.push(ms);
    if (this.samples.length > LATENCY_WINDOW_MAX) this.samples.shift();
  }

  /**
   * Called every CTRL_INTERVAL_MS.
   * Returns the new target count and whether it changed.
   */
  adjust(queueDepth: number): { newCount: number; changed: boolean; reason: string } {
    const n = this.samples.length;
    if (n === 0) return { newCount: this._count, changed: false, reason: "no latency samples yet" };

    const avg  = this.samples.reduce((a, b) => a + b, 0) / n;
    const prev = this._count;
    let reason = "";

    if (avg > LATENCY_BACKOFF_MS) {
      this._count = Math.max(MIN_WORKERS, this._count - 2);
      reason = `avg latency ${avg.toFixed(0)} ms > ${LATENCY_BACKOFF_MS} ms — backing off`;
    } else if (queueDepth === 0) {
      this._count = Math.max(MIN_WORKERS, this._count - 2);
      reason = `queue empty — backing off`;
    } else if (avg < LATENCY_CLIMB_MS) {
      this._count = Math.min(this.ceiling, this._count + 2);
      reason = `avg latency ${avg.toFixed(0)} ms < ${LATENCY_CLIMB_MS} ms, queue depth ${queueDepth} — climbing`;
    } else {
      reason = `avg latency ${avg.toFixed(0)} ms, queue depth ${queueDepth} — holding at ${this._count}`;
    }

    return { newCount: this._count, changed: this._count !== prev, reason };
  }

  get avgLatencyMs(): number {
    if (this.samples.length === 0) return 0;
    return Math.round(this.samples.reduce((a, b) => a + b, 0) / this.samples.length);
  }
  get maxLatencyMs(): number {
    return this.samples.length === 0 ? 0 : Math.round(Math.max(...this.samples));
  }
}

// ── Directory mtime cache (rescan short-circuit) ──────────────────────────────
// Saved as JSON after each successful scan so the next rescan can skip entire
// directory trees that haven't changed.  Stored in the WillardAI cache folder
// on the NAS itself.

function dirMtimeCachePath(nasPath: string): string {
  return path.join(getWillardAIDir(nasPath), "cache", "dir-scan-cache.json");
}

function loadDirMtimeCache(nasPath: string): Map<string, DirCacheEntry> {
  try {
    const raw = fs.readFileSync(dirMtimeCachePath(nasPath), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.v === 2 && typeof parsed.dirs === "object") {
      return new Map(
        Object.entries(parsed.dirs as Record<string, { m: number; c: number }>).map(
          ([k, v]) => [k, { mtimeMs: v.m, entryCount: v.c }],
        ),
      );
    }
    // v1 caches lack entry-count — discard; one extra full walk is acceptable.
  } catch { /* no cache yet — first scan */ }
  return new Map();
}

function saveDirMtimeCache(nasPath: string, cache: Map<string, DirCacheEntry>): void {
  try {
    const cacheDir = path.join(getWillardAIDir(nasPath), "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const dirs: Record<string, { m: number; c: number }> = {};
    for (const [k, v] of cache) dirs[k] = { m: v.mtimeMs, c: v.entryCount };
    fs.writeFileSync(
      dirMtimeCachePath(nasPath),
      JSON.stringify({ v: 2, dirs }),
    );
  } catch { /* non-fatal */ }
}

// Resolve files in directories that were short-circuited by the dir-mtime cache.
//
// The dir-mtime cache tells us no entries were added, removed, or renamed inside
// the directory (directory mtime reflects structural changes only).  However,
// in-place file content modifications do NOT update parent directory mtime on
// most filesystems — so we MUST still stat every individual file to detect them.
//
// This function:
//   1. Queries all non-deleted DB records for the skipped dirs
//   2. Stats each file on disk
//   3. Returns:
//      - unchangedIds  — IDs whose size+mtime still match the DB record
//      - filesToProcess — entries where size or mtime changed (need full indexing)
//   4. Adds all seen paths to seenPaths for deletion detection
//
// Files that can no longer be stat'd are NOT added to unchangedIds or
// filesToProcess — they stay out of seenPaths so deletion detection catches them.

interface SkippedDirResult {
  unchangedIds:   number[];
  filesToProcess: Array<{ fullPath: string; name: string; ext: string; sizeBytes: number; modifiedAt: Date }>;
}

async function resolveSkippedDirs(
  skippedDirs: string[],
  nasPath: string,
  seenPaths: Set<string>,
  profile: JobProfile,
): Promise<SkippedDirResult> {
  if (skippedDirs.length === 0) return { unchangedIds: [], filesToProcess: [] };

  const unchangedIds:   number[]  = [];
  const filesToProcess: SkippedDirResult["filesToProcess"] = [];
  const DIRS_PER_QUERY = 50;

  for (let i = 0; i < skippedDirs.length; i += DIRS_PER_QUERY) {
    const batch = skippedDirs.slice(i, i + DIRS_PER_QUERY);
    const conditions = batch.map(d => sql`${mediaFilesTable.relativePath} LIKE ${d + "/%"}`);
    const rows = await db
      .select({
        id:           mediaFilesTable.id,
        relativePath: mediaFilesTable.relativePath,
        sizeBytes:    mediaFilesTable.sizeBytes,
        modifiedAt:   mediaFilesTable.modifiedAt,
      })
      .from(mediaFilesTable)
      .where(and(
        eq(mediaFilesTable.nasPath, nasPath),
        sql`${mediaFilesTable.lastScanAction} IS DISTINCT FROM 'DELETED'`,
        or(...conditions),
      ));

    for (const row of rows) {
      const fullPath = path.join(nasPath, row.relativePath.replace(/\//g, path.sep));
      try {
        const stat = fs.statSync(fullPath);
        seenPaths.add(row.relativePath);

        const sizeMatch  = stat.size === row.sizeBytes;
        const mtimeMatch = row.modifiedAt !== null &&
          stat.mtime.getTime() === row.modifiedAt.getTime();

        if (sizeMatch && mtimeMatch && profile !== "FULL") {
          unchangedIds.push(row.id);
        } else {
          const name = row.relativePath.split("/").pop()!;
          const ext  = path.extname(name).replace(/^\./, "").toLowerCase();
          filesToProcess.push({ fullPath, name, ext, sizeBytes: stat.size, modifiedAt: stat.mtime });
        }
      } catch {
        // File is gone — intentionally not added to seenPaths so deletion detection handles it
      }
    }
  }

  return { unchangedIds, filesToProcess };
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

    // ── Streaming pipeline setup ──────────────────────────────────────────
    // Walk and indexing run concurrently: the async walker pushes files into
    // a priority queue as they are discovered; a worker pool consumes them
    // immediately so photos appear in the library before the walk finishes.
    state.phase = "walking";
    const willardDir = path.resolve(getWillardAIDir(state.nasPath));
    const skipDirs   = new Set([willardDir]);

    // Load scanner settings (user-configured exclusion rules)
    let scannerSettings: ScannerSettings = DEFAULT_SCANNER_SETTINGS;
    try {
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
      if (settingsRow) scannerSettings = {
        ignoredFolders:    settingsRow.ignoredFolders ?? [],
        ignoredExtensions: settingsRow.ignoredExtensions ?? [],
        ignoreHiddenFiles:  settingsRow.ignoreHiddenFiles ?? true,
        ignoreSystemFiles:  settingsRow.ignoreSystemFiles ?? true,
        ignoreTempFiles:    settingsRow.ignoreTempFiles ?? true,
        ignoreSidecarFiles: settingsRow.ignoreSidecarFiles ?? true,
        ignoreEmptyFolders: settingsRow.ignoreEmptyFolders ?? false,
        followSymlinks:     settingsRow.followSymlinks ?? false,
        indexOtherFiles:    settingsRow.indexOtherFiles ?? true,
      };
    } catch { /* use defaults if settings table not yet migrated */ }

    // Load the directory mtime cache from the previous scan so we can skip
    // entire unchanged directory trees without stat'ing every file inside them.
    const dirCacheIn  = loadDirMtimeCache(state.nasPath);
    const dirCacheOut = new Map<string, DirCacheEntry>();
    const skippedDirs: string[] = [];

    // Reuse the original scan anchor on resume so files indexed before the
    // pause are not misdetected as deleted at the end of this run.
    const scanStartedAt = resumedScanStartedAt ?? new Date();

    // Persist the anchor immediately (survives pause and server restart)
    await db.update(libraryJobsTable)
      .set({ summary: { scanStartedAt: scanStartedAt.toISOString() } })
      .where(eq(libraryJobsTable.id, jobId));

    // ── Phase: indexing ───────────────────────────────────────────────────
    state.phase = "indexing";

    // Streaming pipeline always re-walks from scratch; reset any counters that
    // were restored from a paused run to avoid summary inflation across
    // pause/resume cycles.
    state.counters      = EMPTY_COUNTERS();
    state.skippedList   = [];
    state.filesProcessed = 0;
    state.filesTotal     = 0;

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

    // ── Optimization 1: skip fingerprinting on first scan ────────────────
    // When no existing records exist, move detection is impossible — skip the
    // 128 KB per-file read that computeQuickFingerprint requires entirely.
    const isFirstScan = existingByPath.size === 0;

    // ── Unchanged buffer ──────────────────────────────────────────────────
    // Batch-updates unchanged file timestamps instead of one UPDATE per file.
    // Guard prevents concurrent flush from two workers.
    const unchangedBuf: number[] = [];
    const UNCHANGED_FLUSH = 500;
    let unchangedFlushing = false;
    const flushUnchanged = async (): Promise<void> => {
      if (unchangedFlushing || unchangedBuf.length === 0) return;
      unchangedFlushing = true;
      const ids = unchangedBuf.splice(0);
      try {
        await db.update(mediaFilesTable)
          .set({ lastScanAction: "UNCHANGED" as ScanAction, lastScannedAt: scanStartedAt })
          .where(inArray(mediaFilesTable.id, ids));
      } finally { unchangedFlushing = false; }
    };

    // ── DB batch writer ────────────────────────────────────────────────────
    // Flush when: 500 rows queued OR > 500 ms since last flush.
    // Guard prevents concurrent flushes from two workers.
    const BATCH_FLUSH_SIZE = 500;
    const BATCH_FLUSH_MS  = 500;
    const upsertBuf: (typeof mediaFilesTable.$inferInsert)[] = [];
    let lastBatchFlushAt = Date.now();
    let batchFlushing = false;
    const flushBatch = async (): Promise<void> => {
      if (batchFlushing || upsertBuf.length === 0) return;
      batchFlushing = true;
      const rows = upsertBuf.splice(0);
      try {
        for (let j = 0; j < rows.length; j += BATCH_FLUSH_SIZE) {
          const _dbT0 = Date.now();
          await db.insert(mediaFilesTable).values(rows.slice(j, j + BATCH_FLUSH_SIZE)).onConflictDoUpdate({
            target: [mediaFilesTable.nasPath, mediaFilesTable.relativePath],
            set: MEDIA_FILE_UPSERT_SET,
          });
          diagDbWriteTimeMs += Date.now() - _dbT0;
          diagDbWriteBatches++;
          bumpLibrarySeq();
        }
        lastBatchFlushAt = Date.now();
      } finally { batchFlushing = false; }
    };

    // ── Diagnostics tracking ──────────────────────────────────────────────
    let diagWalkTimeMs          = 0;
    let diagMetadataExtracted   = 0;
    let diagDbWriteBatches      = 0;
    let diagDbWriteTimeMs       = 0;
    let diagMetaExtractionMs    = 0;
    let diagPeakConcurrency     = INITIAL_WORKERS;
    let diagPeakQueueDepth      = 0;
    let diagTotalSizeBytes      = 0;
    const diagSkippedByReason: Record<string, number> = {};

    const maybeFlushBatch = async (): Promise<void> => {
      const qDepth = queue.size;
      // Near-empty queue: flush immediately so results appear in the library sooner
      if (qDepth < 50 && upsertBuf.length > 0) {
        await flushBatch();
      } else if (qDepth > 2000) {
        // High queue pressure: hold until 500 rows accumulate (fewer DB round-trips)
        if (upsertBuf.length >= 500) await flushBatch();
      } else if (upsertBuf.length >= BATCH_FLUSH_SIZE ||
                 (upsertBuf.length > 0 && Date.now() - lastBatchFlushAt >= BATCH_FLUSH_MS)) {
        await flushBatch();
      }
    };

    // Persist cursor on a 10-second time-gate instead of every file
    const PERSIST_INTERVAL_MS = 10_000;
    let lastPersistAt = Date.now();

    // ── processOneFile closure ────────────────────────────────────────────
    // Handles fingerprinting + metadata extraction for a single changed file.
    // Returns a result describing what to write; all DB writes are batched by
    // the caller so Promise.all can run multiple of these concurrently.
    interface FileResult {
      action:            "NEW" | "MODIFIED" | "MOVED" | "SKIP";
      relativePath:      string;
      name:              string;
      targetId?:         number;
      quickFingerprint?: string | null;
      sizeBytes?:        number;
      modifiedAt?:       Date;
      values?:           typeof mediaFilesTable.$inferInsert;
      skipReason?:       string;
    }

    const processOneFile = async (f: { fullPath: string; name: string; ext: string; sizeBytes: number; modifiedAt: Date }): Promise<FileResult> => {
      const relativePath = path.relative(state.nasPath, f.fullPath).replace(/\\/g, "/");
      state.currentPath = relativePath;

      const existing = existingByPath.get(relativePath);
      let quickFingerprint: string | null = null;
      let action: "NEW" | "MODIFIED" | "MOVED";
      let targetId: number | undefined;
      let contentHash: string | null = null;
      let currentSize  = f.sizeBytes;
      let currentMtime = f.modifiedAt;

      if (!existing) {
        if (!isFirstScan) {
          // Compute fingerprint for move detection
          state.phase = "hashing";
          quickFingerprint = await computeQuickFingerprint(f.fullPath, f.sizeBytes);
          if (quickFingerprint === null) {
            state.filesProcessed++;
            tickSpeed(state);
            return { action: "SKIP", relativePath, name: f.name, skipReason: "Could not read file (permission denied or unreadable)" };
          }

          // Stage 1: fingerprint match — atomic (JS single-threaded, no await between check+delete)
          const movedFromId = existingByFingerprint.get(quickFingerprint);
          if (movedFromId !== undefined) {
            existingByFingerprint.delete(quickFingerprint);
            state.counters.moved++;
            state.filesProcessed++;
            tickSpeed(state);
            return { action: "MOVED", relativePath, name: f.name, targetId: movedFromId, quickFingerprint, sizeBytes: currentSize, modifiedAt: currentMtime };
          }

          // Stage 2: legacy full-hash rows (rows without fingerprints from before v2)
          if (legacySizes.has(f.sizeBytes)) {
            contentHash = await hashFile(f.fullPath);
            state.counters.hashed++;
            const legacyId = contentHash ? existingByHash.get(contentHash) : undefined;
            if (legacyId !== undefined) {
              if (contentHash) existingByHash.delete(contentHash);
              state.counters.moved++;
              state.filesProcessed++;
              tickSpeed(state);
              return { action: "MOVED", relativePath, name: f.name, targetId: legacyId, quickFingerprint, sizeBytes: currentSize, modifiedAt: currentMtime };
            }
          }
        }
        action = "NEW";
        // On first scan quickFingerprint stays null — move detection is impossible anyway
      } else {
        // MODIFIED — delete stale thumbnail file so it gets regenerated
        const thumbDir = getThumbnailDir(state.nasPath);
        const oldThumb = path.join(thumbDir, thumbnailFilename(existing.id));
        try { fs.unlinkSync(oldThumb); } catch { /* gone */ }

        state.phase = "hashing";
        quickFingerprint = await computeQuickFingerprint(f.fullPath, f.sizeBytes);
        if (quickFingerprint === null) {
          state.filesProcessed++;
          tickSpeed(state);
          return { action: "SKIP", relativePath, name: f.name, skipReason: "Could not read file (permission denied or unreadable)" };
        }
        action = "MODIFIED";
      }

      // ── Extract metadata ──────────────────────────────────────────────
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
      const _metaT0 = Date.now();
      await extractAll();
      diagMetaExtractionMs += Date.now() - _metaT0;
      if (mediaType === "photo" || VIDEO_META_EXTS.has(f.ext) || f.ext === "pdf") {
        diagMetadataExtracted++;
      }

      // ── Conflict detection: file changed while being indexed ──────────
      // Re-stat after extraction; if size/mtime moved, re-read once so we
      // never store a mix of old-file and new-file values.
      try {
        const after = fs.statSync(f.fullPath);
        if (after.size !== currentSize || after.mtime.getTime() !== currentMtime.getTime()) {
          currentSize  = after.size;
          currentMtime = after.mtime;
          const refreshedFp = await computeQuickFingerprint(f.fullPath, currentSize);
          if (refreshedFp !== null) quickFingerprint = refreshedFp;
          await extractAll();
          state.counters.reanalyzed++;
        }
      } catch {
        // File vanished mid-index — deletion detection will handle it on the next pass
      }

      if (metaError) recordSkip(state, relativePath, metaError);

      const values: typeof mediaFilesTable.$inferInsert = {
        nasPath: state.nasPath, relativePath,
        name: f.name, extension: f.ext, mimeType, mediaType,
        sizeBytes: currentSize, modifiedAt: currentMtime,
        width, height, orientation, durationSeconds,
        dateTaken, cameraMake, cameraModel, lens, iso, aperture,
        exposure, focalLength, flash, colorProfile, gpsLatitude, gpsLongitude, exifJson,
        videoCodec, videoBitrate, fps, audioCodec, dateCreated,
        pageCount, pdfAuthor, pdfTitle, pdfSubject, pdfKeywords,
        contentHash, quickFingerprint, scannerVersion: SCANNER_VERSION,
        lastScanAction: action, lastScannedAt: scanStartedAt,
        thumbnailPath: null, thumbnailGeneratedAt: null, indexedAt: new Date(),
      };

      state.filesProcessed++;
      tickSpeed(state);
      return { action, relativePath, name: f.name, values };
    };

    // ── Priority queue + streaming worker pool ────────────────────────────
    // Walker pushes files into the queue as they're discovered; workers pull
    // from it immediately so metadata extraction starts before walk finishes.
    const queue = new ScanPriorityQueue();
    const ARCHIVE_EXTS_SET = new Set(["zip","rar","7z","tar","gz","bz2","xz","tgz","tbz2","txz","cab","iso"]);
    const discoveredArchives: FileEntry[] = [];

    // stopSignal / requestStop ─────────────────────────────────────────────
    // Workers call requestStop() when they detect pause/cancel.  This marks
    // the signal, closes the queue (unblocking any waiting workers and causing
    // walkDone.then to skip the post-walk heavy lifting), and lets the walker
    // exit at its next directory-level check — so pause/cancel responds in
    // seconds rather than waiting for the full NAS walk to finish.
    const stopSignal = { stop: false };
    let _queueClosed = false;
    const requestStop = (): void => {
      stopSignal.stop = true;
      if (!_queueClosed) { _queueClosed = true; queue.close(); }
    };

    // walkDone: async walk → resolveSkippedDirs → archive upsert → close queue
    state.phase = "walking";
    const diagWalkStart = Date.now();
    const walkDone = walkNasAsync(
      path.resolve(scanRoot),
      skipDirs,
      queue,
      (fileEntry) => {
        // Called for each discovered file — update running total and collect archives
        state.filesTotal++;
        if (ARCHIVE_EXTS_SET.has(fileEntry.ext.toLowerCase())) discoveredArchives.push(fileEntry);
      },
      undefined, // onDir
      (skippedPath, reason) => {
        recordSkip(state, path.relative(state.nasPath, skippedPath).replace(/\\/g, "/"), reason);
        diagSkippedByReason[reason] = (diagSkippedByReason[reason] ?? 0) + 1;
      },
      dirCacheIn,
      dirCacheOut,
      skippedDirs,
      path.resolve(state.nasPath),
      scannerSettings,
      stopSignal,
    ).then(async () => {
      // If a worker called requestStop() the queue is already closed; skip all
      // post-walk work so walkDone resolves immediately.
      if (stopSignal.stop) return;

      // Walk finished — switch phase so the UI knows we're now processing.
      state.phase = "indexing";

      // Walk finished — resolve dir-cache skipped dirs and inject their files.
      // Resolve skipped-directory files: directory mtime only reflects structural
      // changes; in-place edits do NOT update parent mtime, so we still stat each
      // known file to detect content changes.
      if (!isFirstScan && skippedDirs.length > 0) {
        const { unchangedIds, filesToProcess } = await resolveSkippedDirs(
          skippedDirs, state.nasPath, seenPaths, state.profile,
        );
        unchangedBuf.push(...unchangedIds);
        state.counters.unchanged += unchangedIds.length;
        state.filesProcessed    += unchangedIds.length;
        state.filesTotal        += unchangedIds.length + filesToProcess.length;
        for (const f of filesToProcess) queue.push(f);
        await db.update(libraryJobsTable)
          .set({ totalFiles: state.filesTotal })
          .where(eq(libraryJobsTable.id, jobId));
      }

      // Archive upsert — on conflict only refresh size/folder/timestamp so
      // already-peeked archives keep their content metadata.
      if (discoveredArchives.length > 0) {
        for (let ai = 0; ai < discoveredArchives.length; ai += 100) {
          const chunk = discoveredArchives.slice(ai, ai + 100).map(f => ({
            path: f.fullPath, filename: f.name,
            sizeBytes: f.sizeBytes, modifiedAt: f.modifiedAt,
            folder: path.dirname(f.fullPath), category: "General", peekStatus: "pending",
          }));
          await db.insert(archivesTable).values(chunk).onConflictDoUpdate({
            target: archivesTable.path,
            set: {
              sizeBytes: sql`excluded.size_bytes`,
              modifiedAt: sql`excluded.modified_at`,
              folder:     sql`excluded.folder`,
              indexedAt:  sql`NOW()`,
            },
          });
        }
      }

      // Close queue — workers drain remaining items and exit
      if (!_queueClosed) { _queueClosed = true; queue.close(); }
    });

    // ── Adaptive worker pool ──────────────────────────────────────────────
    // Workers start at INITIAL_WORKERS. ConcurrencyController adjusts the
    // target count every CTRL_INTERVAL_MS based on rolling I/O latency and
    // queue depth, staying within [MIN_WORKERS, profile ceiling].
    //
    // Scale-down: each worker checks whether the live count exceeds the target
    //   at the top of its loop and voluntarily exits if it is over-provisioned.
    //   Using a live counter (not a monotonic ID) means scale-up after
    //   scale-down always produces eligible workers — no permanent ratchet.
    // Scale-up:   spawnWorker() increments the counter and adds a new promise.

    const concCtrl = new ConcurrencyController(INITIAL_WORKERS, state.throttle.concurrencyCeiling);
    let targetWorkerCount  = concCtrl.count;
    let activeWorkerCount  = 0;
    const allWorkerPromises: Promise<void>[] = [];

    const spawnWorker = (): void => {
      activeWorkerCount++;
      allWorkerPromises.push((async (): Promise<void> => {
        try {
          for (;;) {
            // Check BEFORE blocking on queue.pop() — if already signalled, stop
            // without waiting for another item (which might never arrive).
            if (state.cancelRequested || state.pauseRequested) {
              requestStop();
              break;
            }

            // Graceful scale-down: if more workers are running than the current
            // target, volunteer to exit.  JS is single-threaded so this check
            // is safe — no other continuation can change activeWorkerCount
            // between here and the break below.
            if (activeWorkerCount > targetWorkerCount) break;

            state.phase = "indexing";
            const f = await queue.pop(); // waits until item available OR queue closed
            if (f === null) break;       // queue closed + empty → done

            // We already hold this file — complete its processing (drain semantics).
            // Do NOT discard it, even if pause/cancel was set while we were waiting.
            const relativePath = path.relative(state.nasPath, f.fullPath).replace(/\\/g, "/");
            seenPaths.add(relativePath);

            const existing = existingByPath.get(relativePath);
            const isUnchanged = existing &&
              existing.sizeBytes === f.sizeBytes &&
              existing.modifiedAt?.getTime() === f.modifiedAt.getTime() &&
              state.profile !== "FULL";

            if (isUnchanged) {
              unchangedBuf.push(existing!.id);
              state.counters.unchanged++;
              state.filesProcessed++;
              tickSpeed(state);
              if (unchangedBuf.length >= UNCHANGED_FLUSH) await flushUnchanged();
            } else {
              if (activeWorkerCount > diagPeakConcurrency) diagPeakConcurrency = activeWorkerCount;
              const t0     = Date.now();
              const result = await processOneFile(f);
              concCtrl.recordLatency(Date.now() - t0);
              diagTotalSizeBytes += f.sizeBytes;

              if (result.action === "SKIP") {
                recordSkip(state, result.relativePath, result.skipReason!);
              } else if (result.action === "MOVED" && result.targetId !== undefined) {
                await db.update(mediaFilesTable).set({
                  relativePath:     result.relativePath,
                  name:             result.name,
                  sizeBytes:        result.sizeBytes ?? 0,
                  modifiedAt:       result.modifiedAt ?? new Date(),
                  quickFingerprint: result.quickFingerprint ?? null,
                  lastScanAction:   "MOVED" as ScanAction,
                  lastScannedAt:    scanStartedAt,
                  indexedAt:        new Date(),
                }).where(eq(mediaFilesTable.id, result.targetId));
              } else if (result.values) {
                upsertBuf.push(result.values);
                if (result.action === "NEW") state.counters.new++;
                else state.counters.modified++;
                await maybeFlushBatch();
              }
            }

            // After completing this file, check if we should stop.
            // requestStop() closes the queue so other waiting workers unblock too.
            if (state.cancelRequested || state.pauseRequested) {
              requestStop();
              break;
            }

            // Periodic progress persist (time-gated to avoid DB noise)
            const now = Date.now();
            if (now - lastPersistAt >= PERSIST_INTERVAL_MS) {
              await flushUnchanged();
              await db.update(libraryJobsTable)
                .set({ processedFiles: state.filesProcessed })
                .where(eq(libraryJobsTable.id, jobId));
              lastPersistAt = now;
            }
          }
        } finally {
          // Always decrement so scale-up after scale-down spawns eligible workers
          activeWorkerCount--;
        }
      })());
    };

    // Spawn initial workers
    for (let i = 0; i < targetWorkerCount; i++) spawnWorker();

    // Concurrency controller — runs every 5 s until the walk completes
    const ctrlInterval = setInterval(() => {
      if (queue.size > diagPeakQueueDepth) diagPeakQueueDepth = queue.size;
      const { newCount, changed, reason } = concCtrl.adjust(queue.size);
      if (changed) {
        const prev    = targetWorkerCount;
        targetWorkerCount = newCount;
        console.info(`[scan #${jobId}] concurrency ${prev} → ${newCount}: ${reason}`);
        if (newCount > prev) {
          for (let i = 0; i < newCount - prev; i++) spawnWorker();
        }
        // Scale-down is handled by the activeWorkerCount > targetWorkerCount guard in each worker
      }
    }, CTRL_INTERVAL_MS);

    // Walk and workers run concurrently; walk closes the queue when done
    await walkDone;
    diagWalkTimeMs = Date.now() - diagWalkStart;

    // Queue is now closed; drain all remaining work.  Keep the controller
    // alive through the drain so concurrency still adapts while a large
    // post-walk queue empties, then shut it down once all workers finish.
    await Promise.all(allWorkerPromises);
    clearInterval(ctrlInterval);

    // ── Handle pause / cancel ─────────────────────────────────────────────
    if (state.cancelRequested) {
      await flushBatch();
      await flushUnchanged();
      await db.update(libraryJobsTable).set({
        status: "CANCELLED",
        cancellationReason: state.cancellationReason ?? "USER_CANCELLED",
        cursor: null,
        summary: buildPartialSummary(state, scanStartedAt),
        finishedAt: new Date(),
      }).where(eq(libraryJobsTable.id, jobId));
      activeJobs.delete(jobId);
      return;
    }

    if (state.pauseRequested) {
      await flushBatch();
      await flushUnchanged();
      await db.update(libraryJobsTable).set({
        status:         "PAUSED",
        pausedAt:       new Date(),
        processedFiles: state.filesProcessed,
        summary:        buildPartialSummary(state, scanStartedAt),
      }).where(eq(libraryJobsTable.id, jobId));
      activeJobs.delete(jobId);
      return;
    }

    // Final flush of all remaining buffered rows
    await flushBatch();
    await flushUnchanged();
    await db.update(libraryJobsTable)
      .set({ processedFiles: state.filesProcessed, totalFiles: state.filesTotal })
      .where(eq(libraryJobsTable.id, jobId));

    // Save the current directory mtime cache for the next rescan
    saveDirMtimeCache(state.nasPath, dirCacheOut);

    // ── Phase: detecting deletions ─────────────────────────────────────────
    state.phase = "detecting_deletions";

    // Any DB record for this nasPath not seen in this scan → DELETED
    // Exclude already-DELETED records so they aren't re-counted on every subsequent scan.
    const deletedRows = await db.update(mediaFilesTable)
      .set({ lastScanAction: "DELETED", lastScannedAt: scanStartedAt })
      .where(and(
        eq(mediaFilesTable.nasPath, state.nasPath),
        lt(mediaFilesTable.lastScannedAt, scanStartedAt),
        ne(mediaFilesTable.lastScanAction, "DELETED"),
      ))
      .returning({ id: mediaFilesTable.id });

    state.counters.deleted = deletedRows.length;

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

    const _diagElapsedSecs = elapsedMs / 1000;
    const diagnostics: ScanDiagnostics = {
      walkTimeMs:               diagWalkTimeMs,
      dirCacheHits:             skippedDirs.length,
      dirCacheMisses:           Math.max(0, dirCacheOut.size - skippedDirs.length),
      skippedByReason:          diagSkippedByReason,
      metadataExtracted:        diagMetadataExtracted,
      hashesGenerated:          state.counters.hashed,
      dbWriteBatches:           diagDbWriteBatches,
      avgNasLatencyMs:          concCtrl.avgLatencyMs,
      maxNasLatencyMs:          concCtrl.maxLatencyMs,
      peakConcurrency:          diagPeakConcurrency,
      throughputFilesPerSec:    _diagElapsedSecs > 0 ? Math.round((state.filesProcessed / _diagElapsedSecs) * 10) / 10 : 0,
      throughputMBPerSec:       _diagElapsedSecs > 0 ? Math.round((diagTotalSizeBytes / (1024 * 1024) / _diagElapsedSecs) * 100) / 100 : 0,
      peakQueueDepth:           diagPeakQueueDepth,
      dbWriteTimeMs:            diagDbWriteTimeMs,
      metadataExtractionTimeMs: diagMetaExtractionMs,
      totalSizeBytes:           diagTotalSizeBytes,
    };

    await db.update(libraryJobsTable).set({
      status:         "DONE",
      finishedAt:     new Date(),
      processedFiles: state.filesProcessed,
      totalFiles:     state.filesTotal,
      summary,
      diagnostics:    diagnostics as unknown as Record<string, unknown>,
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
