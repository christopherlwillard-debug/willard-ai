import { db, libraryJobsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import {
  createMediaHealthWorkerManager,
  type MediaHealthAfterComplete,
  type MediaHealthJobStore,
  type MediaHealthOutcome,
  type MediaHealthProgress,
  type MediaHealthRunner,
} from "./media-health-worker.ts";

export function mediaHealthJobOwnershipCondition(jobId: number, token: string) {
  return and(
    eq(libraryJobsTable.id, jobId),
    eq(libraryJobsTable.status, "RUNNING"),
    sql`${libraryJobsTable.diagnostics}->'healthJob'->>'workerToken' = ${token}`,
  );
}

const store: MediaHealthJobStore = {
  async owns(jobId, token) {
    const [row] = await db.select({ id: libraryJobsTable.id })
      .from(libraryJobsTable)
      .where(mediaHealthJobOwnershipCondition(jobId, token))
      .limit(1);
    return Boolean(row);
  },

  async progress(jobId, token, progress: MediaHealthProgress) {
    const [row] = await db.update(libraryJobsTable).set({
      processedFiles: progress.processed,
      totalFiles: progress.total,
      diagnostics: sql`jsonb_set(
        COALESCE(${libraryJobsTable.diagnostics}, '{}'::jsonb),
        '{healthJob}',
        COALESCE(${libraryJobsTable.diagnostics}->'healthJob', '{}'::jsonb) ||
          jsonb_build_object(
            'workerToken', ${token},
            'phase', ${progress.phase},
            'message', ${progress.message}
          ),
        true
      )`,
    }).where(mediaHealthJobOwnershipCondition(jobId, token))
      .returning({ id: libraryJobsTable.id });
    return Boolean(row);
  },

  async complete(jobId, token, outcome: MediaHealthOutcome) {
    const status = outcome.status ?? "DONE";
    const [row] = await db.update(libraryJobsTable).set({
      status,
      finishedAt: new Date(),
      summary: outcome.summary,
      error: status === "FAILED" ? (outcome.error ?? "Health job completed with items requiring attention.") : null,
      diagnostics: sql`jsonb_set(
        COALESCE(${libraryJobsTable.diagnostics}, '{}'::jsonb),
        '{healthJob}',
        COALESCE(${libraryJobsTable.diagnostics}->'healthJob', '{}'::jsonb) ||
          jsonb_build_object('workerToken', ${token}, 'phase', 'complete'),
        true
      )`,
    }).where(mediaHealthJobOwnershipCondition(jobId, token))
      .returning({ id: libraryJobsTable.id });
    return Boolean(row);
  },

  async fail(jobId, token, message) {
    const [row] = await db.update(libraryJobsTable).set({
      status: "FAILED",
      cancellationReason: "ERROR",
      finishedAt: new Date(),
      error: message,
      diagnostics: sql`jsonb_set(
        COALESCE(${libraryJobsTable.diagnostics}, '{}'::jsonb),
        '{healthJob}',
        COALESCE(${libraryJobsTable.diagnostics}->'healthJob', '{}'::jsonb) ||
          jsonb_build_object('workerToken', ${token}, 'phase', 'failed'),
        true
      )`,
    }).where(mediaHealthJobOwnershipCondition(jobId, token))
      .returning({ id: libraryJobsTable.id });
    return Boolean(row);
  },

  async pause(jobId, token) {
    const [row] = await db.update(libraryJobsTable).set({
      status: "PAUSED",
      pausedAt: new Date(),
      error: "Health job paused for API shutdown; verify the library again after restart.",
      diagnostics: sql`jsonb_set(
        COALESCE(${libraryJobsTable.diagnostics}, '{}'::jsonb),
        '{healthJob}',
        COALESCE(${libraryJobsTable.diagnostics}->'healthJob', '{}'::jsonb) ||
          jsonb_build_object('workerToken', ${token}, 'phase', 'paused'),
        true
      )`,
    }).where(mediaHealthJobOwnershipCondition(jobId, token))
      .returning({ id: libraryJobsTable.id });
    return Boolean(row);
  },
};

const workers = createMediaHealthWorkerManager(store, 1);

export function canStartMediaHealthWorker(): boolean {
  return workers.activeCount < 1;
}

export function scheduleMediaHealthWorker(
  jobId: number,
  token: string,
  runner: MediaHealthRunner,
  afterComplete?: MediaHealthAfterComplete,
): boolean {
  return workers.schedule(jobId, token, runner, afterComplete);
}

export async function stopMediaHealthWorkers(): Promise<void> {
  await workers.stopAll();
}

export async function appendMediaHealthJobSummary(
  jobId: number,
  token: string,
  extra: Record<string, unknown>,
): Promise<boolean> {
  const [updated] = await db.update(libraryJobsTable).set({
    summary: sql`COALESCE(${libraryJobsTable.summary}, '{}'::jsonb) || ${JSON.stringify(extra)}::jsonb`,
  }).where(and(
    eq(libraryJobsTable.id, jobId),
    sql`${libraryJobsTable.diagnostics}->'healthJob'->>'workerToken' = ${token}`,
    sql`${libraryJobsTable.status} <> 'RUNNING'`,
  )).returning({ id: libraryJobsTable.id });
  return Boolean(updated);
}
