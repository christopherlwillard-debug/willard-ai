import { db, pool, conversionJobsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { acquireConversionJobLock, releaseConversionJobLock } from "./conversion-job-lock.ts";

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
  const runningJobs = await db.select({ id: conversionJobsTable.id })
    .from(conversionJobsTable)
    .where(eq(conversionJobsTable.status, "running"));

  let recovered = 0;
  for (const job of runningJobs) {
    const lockClient = await acquireConversionJobLock(job.id, () => pool.connect());
    if (!lockClient) continue;

    try {
      const [updated] = await db.update(conversionJobsTable)
        .set({ status: "failed", error: INTERRUPTED_CONVERSION_ERROR })
        .where(and(
          eq(conversionJobsTable.id, job.id),
          eq(conversionJobsTable.status, "running"),
        ))
        .returning({ id: conversionJobsTable.id });
      if (updated) recovered++;
    } finally {
      // The helper discards the client if it cannot verify the unlock.
      try { await releaseConversionJobLock(lockClient, job.id); } catch { /* connection was discarded */ }
    }
  }
  return recovered;
}
