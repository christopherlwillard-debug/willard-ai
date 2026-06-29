// ── Job type constants ─────────────────────────────────────────────────────────

export type JobType     = "SCAN" | "THUMBNAILS" | "REPAIR" | "VERIFY" | "OPTIMIZE" | "METADATA";
export type JobProfile  = "QUICK" | "FULL" | "HEALTH_SCAN";
export type JobPriority = "HIGH" | "NORMAL" | "LOW";
export type JobStatus   = "PENDING" | "RUNNING" | "PAUSED" | "DONE" | "FAILED" | "CANCELLED";
export type CancellationReason = "USER_CANCELLED" | "NAS_OFFLINE" | "SYSTEM_SLEEP" | "POWER_LOSS" | "ERROR";
export type ScanAction  = "NEW" | "MODIFIED" | "MOVED" | "UNCHANGED" | "DELETED" | "VERIFIED";
export type ScanPhase   = "walking" | "indexing" | "hashing" | "metadata" | "detecting_moves" | "detecting_deletions" | "finalizing" | "thumbnailing";

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
}

export const EMPTY_COUNTERS = (): JobCounters => ({
  new: 0, modified: 0, moved: 0, unchanged: 0, deleted: 0, hashed: 0, thumbnails: 0,
});

export const PRIORITY_RANK: Record<JobPriority, number> = { HIGH: 3, NORMAL: 2, LOW: 1 };
