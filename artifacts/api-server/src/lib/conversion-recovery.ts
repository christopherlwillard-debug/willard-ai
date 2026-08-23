import { db, conversionJobsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export const INTERRUPTED_CONVERSION_ERROR =
  "Interrupted by server restart — partial backup preserved";

/** Mark jobs left running by a crashed process as retryable failures. */
export async function recoverInterruptedConversionJobs(): Promise<number> {
  const result = await db.update(conversionJobsTable)
    .set({ status: "failed", error: INTERRUPTED_CONVERSION_ERROR })
    .where(eq(conversionJobsTable.status, "running"));
  return result.rowCount ?? 0;
}