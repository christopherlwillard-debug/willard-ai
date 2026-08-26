export type JobStreamCursor = {
  streamId: string;
  sequence: number;
};

const TERMINAL_JOB_STATUSES = new Set([
  "DONE",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED_BY_RESTART",
]);

export function isTerminalJobStatus(status: unknown): boolean {
  return typeof status === "string" && TERMINAL_JOB_STATUSES.has(status);
}

export function isRecoverableJobStatus(status: unknown): boolean {
  return status === "RUNNING" || status === "PAUSED";
}

export function shouldAcceptJobSnapshot(
  current: JobStreamCursor | null,
  incoming: JobStreamCursor | null,
): boolean {
  if (!incoming) return true;
  if (!current || current.streamId !== incoming.streamId) return true;
  return incoming.sequence > current.sequence;
}

export function progressFromPersistedJob(job: Record<string, unknown>) {
  const filesTotal = Number(job.totalFiles ?? 0);
  const filesProcessed = Number(job.processedFiles ?? 0);

  return {
    jobId: Number(job.id ?? job.jobId),
    jobType: String(job.jobType ?? "SCAN"),
    status: String(job.status ?? "FAILED"),
    phase: isTerminalJobStatus(job.status) ? "finalizing" : "walking",
    profile: typeof job.profile === "string" ? job.profile : null,
    progress: filesTotal > 0 ? Math.min(100, Math.round((filesProcessed / filesTotal) * 100)) : 0,
    filesProcessed,
    filesTotal,
    currentPath: "",
    etaSeconds: null,
    speed: 0,
    counters: {
      new: 0, modified: 0, moved: 0, unchanged: 0, deleted: 0,
      hashed: 0, thumbnails: 0, thumbnailsFailed: 0, skipped: 0, reanalyzed: 0,
    },
    summary: (job.summary as Record<string, number> | null) ?? null,
  };
}