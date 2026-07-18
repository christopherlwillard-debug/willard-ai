// ── Scanner version ────────────────────────────────────────────────────────────
// Bump this whenever metadata extraction improves (e.g. new EXIF fields). Items
// indexed with an older version can be selectively re-processed via the
// METADATA job — never a full library rebuild.

export const SCANNER_VERSION = 2;

// ── Job type constants ─────────────────────────────────────────────────────────

export type JobType     = "SCAN" | "THUMBNAILS" | "REPAIR" | "VERIFY" | "OPTIMIZE" | "METADATA";
export type JobProfile  = "QUICK" | "FULL" | "HEALTH_SCAN";
export type JobPriority = "HIGH" | "NORMAL" | "LOW";
export type JobStatus   = "PENDING" | "RUNNING" | "PAUSED" | "DONE" | "FAILED" | "CANCELLED";
export type CancellationReason = "USER_CANCELLED" | "NAS_OFFLINE" | "SYSTEM_SLEEP" | "POWER_LOSS" | "ERROR";
export type ScanAction  = "NEW" | "MODIFIED" | "MOVED" | "UNCHANGED" | "DELETED" | "VERIFIED";
export type ScanPhase   = "walking" | "indexing" | "hashing" | "metadata" | "detecting_moves" | "detecting_deletions" | "finalizing" | "thumbnailing";

// ── Performance throttle ───────────────────────────────────────────────────────

export type ScanPerformance = "HIGH" | "BALANCED" | "LOW";

export interface ThrottleProfile {
  batchSize:    number;
  batchDelayMs: number;
  concurrency:  number;
}

export const THROTTLE_PROFILES: Record<ScanPerformance, ThrottleProfile> = {
  HIGH:     { batchSize: 200, batchDelayMs: 0,   concurrency: 8 },
  BALANCED: { batchSize: 100, batchDelayMs: 0,   concurrency: 6 },
  LOW:      { batchSize: 20,  batchDelayMs: 200, concurrency: 2 },
};

// ── Skipped files ──────────────────────────────────────────────────────────────

export interface SkippedFile {
  path:   string;
  reason: string; // plain English, e.g. "Corrupt or unreadable JPG image"
}

export const MAX_SKIPPED_LISTED = 500;

// ── Summary stored in library_jobs.summary (jsonb) ────────────────────────────

export interface JobSummary {
  newFiles:           number;
  modifiedFiles:      number;
  movedFiles:         number;
  deletedFiles:       number;
  unchangedFiles:     number;
  hashedFiles:        number;
  thumbnailsGenerated:number;
  elapsedMs:          number;
  previousElapsedMs:  number | null;
  skippedFiles?:      number;
  skippedList?:       SkippedFile[];
  duplicateGroups?:   number;
  scanStartedAt?:     string; // ISO — key for querying per-action file subsets
  categories?:        Record<string, number>; // files per media type in this scan
  reprocessedFiles?:  number; // METADATA jobs
}

// ── Progress event structure (stable contract — never break clients) ───────────

export interface JobCounters {
  new:        number;
  modified:   number;
  moved:      number;
  unchanged:  number;
  deleted:    number;
  hashed:     number;
  thumbnails: number;
  skipped:    number;
  reanalyzed: number; // files that changed mid-index and were re-analyzed
}

export interface ProgressEvent {
  jobId:          number;
  status:         JobStatus;
  phase:          ScanPhase;
  profile:        JobProfile | null;
  progress:       number;           // 0–100
  filesProcessed: number;
  filesTotal:     number;
  currentPath:    string;
  etaSeconds:     number | null;
  speed:          number;           // files/second (rolling)
  counters:       JobCounters;
  summary:        JobSummary | null; // populated when status === "DONE"
}

// ── In-memory job state ────────────────────────────────────────────────────────

export interface ActiveJobState {
  id:               number;
  nasPath:          string;
  profile:          JobProfile;
  priority:         JobPriority;
  pauseRequested:   boolean;
  cancelRequested:  boolean;
  cancellationReason: CancellationReason | null;
  startedAt:        Date;
  // Progress
  phase:            ScanPhase;
  filesTotal:       number;
  filesProcessed:   number;
  currentPath:      string;
  counters:         JobCounters;
  speedWindow:      number[];       // epoch ms timestamps for rolling ETA
  throttle:         ThrottleProfile;
  skippedList:      SkippedFile[];
}

export const EMPTY_COUNTERS = (): JobCounters => ({
  new: 0, modified: 0, moved: 0, unchanged: 0, deleted: 0, hashed: 0, thumbnails: 0, skipped: 0, reanalyzed: 0,
});

export const PRIORITY_RANK: Record<JobPriority, number> = { HIGH: 3, NORMAL: 2, LOW: 1 };
