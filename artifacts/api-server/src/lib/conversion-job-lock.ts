/**
 * Cross-process ownership for a conversion job.
 *
 * The lock is session-scoped: callers must keep the same PostgreSQL client
 * checked out until the operation is complete. Releasing or losing that
 * connection releases the lock automatically, allowing startup recovery to
 * distinguish a live worker from a job abandoned by a crashed process.
 */
export const CONVERSION_JOB_LOCK_NAMESPACE = 1464427596; // "WILL"

export interface ConversionJobLockClient {
  query: (text: string, values?: any[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  release: (error?: Error | boolean) => void;
}

export type ConversionJobLockConnect = () => Promise<ConversionJobLockClient>;

function validateJobId(jobId: number): void {
  if (!Number.isSafeInteger(jobId) || jobId <= 0 || jobId > 2_147_483_647) {
    throw new Error("Invalid conversion job ID for advisory lock");
  }
}

/** Return null when another process currently owns this job. */
export async function acquireConversionJobLock(
  jobId: number,
  connect: ConversionJobLockConnect,
): Promise<ConversionJobLockClient | null> {
  validateJobId(jobId);
  const client = await connect();
  try {
    const result = await client.query(
      "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS locked",
      [CONVERSION_JOB_LOCK_NAMESPACE, jobId],
    );
    if (result.rows[0]?.["locked"] !== true) {
      client.release();
      return null;
    }
    return client;
  } catch (error) {
    client.release(error instanceof Error ? error : true);
    throw error;
  }
}

/** Unlock and return the connection; discard it if unlock cannot be verified. */
export async function releaseConversionJobLock(
  client: ConversionJobLockClient,
  jobId: number,
): Promise<void> {
  validateJobId(jobId);
  let releaseError: Error | undefined;
  try {
    const result = await client.query(
      "SELECT pg_advisory_unlock($1::integer, $2::integer) AS unlocked",
      [CONVERSION_JOB_LOCK_NAMESPACE, jobId],
    );
    if (result.rows[0]?.["unlocked"] !== true) {
      releaseError = new Error("Conversion job advisory lock was not held by its connection");
    }
  } catch (error) {
    releaseError = error instanceof Error ? error : new Error(String(error));
  }
  // A connection with an unverified session lock must never return to the pool.
  client.release(releaseError);
  if (releaseError) throw releaseError;
}
