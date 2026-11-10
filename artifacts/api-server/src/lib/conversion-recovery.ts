import { db, pool, conversionJobsTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import {
  assertConversionJobLockOwned,
  acquireConversionFilesystemJobLock,
  acquireConversionJobLock,
  releaseConversionJobLock,
} from "./conversion-job-lock.ts";
import { recoverConversionFinalizationMoves } from "./conversion-finalize.ts";
import type { FileMoveRecord } from "./organize-helpers.ts";

export const INTERRUPTED_CONVERSION_ERROR =
  "Interrupted by server restart — partial backup preserved";

/**
 * Mark abandoned running jobs as retryable failures.
 *
 * A live worker holds the same session advisory lock for its full execution.
 * Recovery skips locked jobs, so a second API process starting during a
 * rolling restart cannot mark another process's active conversion as failed.
 */
export async function recoverInterruptedConversionJobs(): Promise<number> {
  const runningJobs = await db.select({
    id: conversionJobsTable.id,
    nasPath: conversionJobsTable.nasPath,
    activeAttemptId: conversionJobsTable.activeAttemptId,
  })
    .from(conversionJobsTable)
    .where(eq(conversionJobsTable.status, "running"));

  let recovered = 0;
  for (const job of runningJobs) {
    const lockClient = await acquireConversionJobLock(job.id, () => pool.connect());
    if (!lockClient) continue;

    let filesystemLock;
    try {
      filesystemLock = acquireConversionFilesystemJobLock(job.nasPath, job.id);
    } catch (error) {
      try { await releaseConversionJobLock(lockClient, job.id); } catch { /* connection was discarded */ }
      throw error;
    }
    if (!filesystemLock) {
      try { await releaseConversionJobLock(lockClient, job.id); } catch { /* connection was discarded */ }
      continue;
    }
    try {
      assertConversionJobLockOwned(lockClient);
      const [updated] = await db.update(conversionJobsTable)
        .set({ status: "failed", activeAttemptId: null, error: INTERRUPTED_CONVERSION_ERROR })
        .where(and(
          eq(conversionJobsTable.id, job.id),
          eq(conversionJobsTable.status, "running"),
          job.activeAttemptId
            ? eq(conversionJobsTable.activeAttemptId, job.activeAttemptId)
            : isNull(conversionJobsTable.activeAttemptId),
        ))
        .returning({ id: conversionJobsTable.id });
      if (updated) recovered++;
    } finally {
      try { filesystemLock.release(); } catch { /* preserve uncertain ownership */ }
      // The helper discards the client if it cannot verify the unlock.
      try { await releaseConversionJobLock(lockClient, job.id); } catch { /* connection was discarded */ }
    }
  }
  // Finalization has its own durable per-move intent journal. A process can
  // stop after a filesystem move but before the final "done" database update;
  // reconcile those jobs under the same advisory lock before accepting retries.
  const pendingFinalizations = await db.select({
    id: conversionJobsTable.id,
    nasPath: conversionJobsTable.nasPath,
    activeAttemptId: conversionJobsTable.activeAttemptId,
    resultJson: conversionJobsTable.resultJson,
  })
    .from(conversionJobsTable)
    .where(eq(conversionJobsTable.status, "awaiting_action"));

  for (const job of pendingFinalizations) {
    const initialResult = job.resultJson as {
      finalizationJournal?: unknown;
    } | null;
    if (!Array.isArray(initialResult?.finalizationJournal) || initialResult.finalizationJournal.length === 0) {
      continue;
    }

    const lockClient = await acquireConversionJobLock(job.id, () => pool.connect());
    if (!lockClient) continue;

    let filesystemLock;
    try {
      filesystemLock = acquireConversionFilesystemJobLock(job.nasPath, job.id);
    } catch (error) {
      try { await releaseConversionJobLock(lockClient, job.id); } catch { /* connection was discarded */ }
      throw error;
    }
    if (!filesystemLock) {
      try { await releaseConversionJobLock(lockClient, job.id); } catch { /* connection was discarded */ }
      continue;
    }
    try {
      const [current] = await db.select({ resultJson: conversionJobsTable.resultJson })
        .from(conversionJobsTable)
        .where(and(
          eq(conversionJobsTable.id, job.id),
          eq(conversionJobsTable.nasPath, job.nasPath),
          eq(conversionJobsTable.status, "awaiting_action"),
          job.activeAttemptId
            ? eq(conversionJobsTable.activeAttemptId, job.activeAttemptId)
            : isNull(conversionJobsTable.activeAttemptId),
        ))
        .limit(1);
      const currentResult = current?.resultJson as {
        finalizationJournal?: unknown;
        [key: string]: unknown;
      } | null | undefined;
      const journal = currentResult?.finalizationJournal;
      if (!currentResult || !Array.isArray(journal) || journal.length === 0) continue;

      assertConversionJobLockOwned(lockClient);
      const recovery = await recoverConversionFinalizationMoves(
        journal as FileMoveRecord[],
        job.nasPath,
        () => assertConversionJobLockOwned(lockClient),
      );
      const message = recovery.complete
        ? "Interrupted finalization was rolled back during startup; retry is available."
        : "Interrupted finalization could not be fully rolled back; remaining files are preserved for manual recovery.";
      const nextResult = {
        ...currentResult,
        finalizationJournal: recovery.complete ? [] : journal,
        finalizationRecoveryMoves: recovery.unresolvedMoves,
        finalizationError: message,
      };
      assertConversionJobLockOwned(lockClient);
      const [updated] = await db.update(conversionJobsTable)
        .set({ resultJson: nextResult, error: message })
        .where(and(
          eq(conversionJobsTable.id, job.id),
          eq(conversionJobsTable.nasPath, job.nasPath),
          eq(conversionJobsTable.status, "awaiting_action"),
          job.activeAttemptId
            ? eq(conversionJobsTable.activeAttemptId, job.activeAttemptId)
            : isNull(conversionJobsTable.activeAttemptId),
        ))
        .returning({ id: conversionJobsTable.id });
      if (updated && recovery.complete) recovered++;
    } catch {
      // Keep the durable journal untouched if recovery or its database
      // checkpoint fails. A later startup/request can safely retry it.
    } finally {
      try { filesystemLock.release(); } catch { /* preserve uncertain ownership */ }
      try { await releaseConversionJobLock(lockClient, job.id); } catch { /* connection was discarded */ }
    }
  }

  return recovered;
}
