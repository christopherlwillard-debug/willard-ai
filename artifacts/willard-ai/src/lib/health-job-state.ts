export type HealthJobSnapshot = {
  id: number;
  jobType: string;
  status: string;
  processed: number;
  total: number | null;
  phase: string | null;
  message: string | null;
  summary: Record<string, unknown> | null;
  error: string | null;
  actions?: string[];
  retryAvailable?: boolean;
};

export function shouldPollHealthJob(job: HealthJobSnapshot): boolean {
  return job.status === "RUNNING" || job.summary?.followUpPending === true;
}

export function getFollowUpHealthJobId(job: HealthJobSnapshot): number | null {
  const id = Number(job.summary?.followUpJobId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function shouldClearCleanupActions(job: HealthJobSnapshot): boolean {
  return job.jobType === "HEALTH_CLEANUP" && job.status === "DONE";
}
