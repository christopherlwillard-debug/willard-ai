import * as fs from "fs";
import * as path from "path";
import { hostname } from "os";
import { randomUUID } from "crypto";

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

export interface ConversionFilesystemJobLock {
  readonly lockPath: string;
  assertOwned(): void;
  release(): void;
}

interface FilesystemLockOwner {
  host: string;
  pid: number;
  token: string;
}

function validateJobId(jobId: number): void {
  if (!Number.isSafeInteger(jobId) || jobId <= 0 || jobId > 2_147_483_647) {
    throw new Error("Invalid conversion job ID for advisory lock");
  }
}

function readFilesystemLockOwner(lockPath: string): FilesystemLockOwner | null {
  try {
    const lockStat = fs.lstatSync(lockPath);
    const ownerPath = path.join(lockPath, "owner.json");
    const ownerStat = fs.lstatSync(ownerPath);
    if (
      !lockStat.isDirectory() ||
      lockStat.isSymbolicLink() ||
      !ownerStat.isFile() ||
      ownerStat.isSymbolicLink()
    ) {
      return null;
    }
    const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as Partial<FilesystemLockOwner>;
    if (
      typeof owner.host !== "string" ||
      !Number.isSafeInteger(owner.pid) ||
      (owner.pid ?? 0) <= 0 ||
      typeof owner.token !== "string" ||
      owner.token.length === 0
    ) {
      return null;
    }
    return owner as FilesystemLockOwner;
  } catch {
    return null;
  }
}

function localProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not signalable by this user.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Claim the NAS-backed mutation gate for a conversion job.
 *
 * `mkdir` is an atomic exclusive operation on the supported NAS filesystems.
 * Unlike a time-based lease, the directory is never stolen from a live process:
 * this keeps a worker with a partitioned PostgreSQL connection from mutating
 * files concurrently with a replacement worker. A crashed local process can
 * be reclaimed after its PID is confirmed absent. Unknown/remote owners fail
 * closed instead of guessing that it is safe to take over.
 */
export function acquireConversionFilesystemJobLock(
  nasPath: string,
  jobId: number,
): ConversionFilesystemJobLock | null {
  validateJobId(jobId);
  if (!path.isAbsolute(nasPath)) {
    throw new Error("Conversion filesystem lock requires an absolute NAS path");
  }

  const locksDir = path.join(path.resolve(nasPath), "WillardAI", "conversions", ".locks");
  const lockPath = path.join(locksDir, `job-${jobId}`);
  fs.mkdirSync(locksDir, { recursive: true });

  const owner: FilesystemLockOwner = {
    host: hostname(),
    pid: process.pid,
    token: randomUUID(),
  };

  const claim = (): boolean => {
    try {
      fs.mkdirSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }

    try {
      fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify(owner), { flag: "wx" });
      return true;
    } catch (error) {
      // The directory is ours because mkdir succeeded. Remove only an empty
      // directory; leave any unexpected contents in place for manual recovery.
      // A crash before owner.json is written is intentionally fail-closed.
      try { fs.rmdirSync(lockPath); } catch { /* preserve an ambiguous lock */ }
      throw error;
    }
  };

  if (!claim()) {
    const priorOwner = readFilesystemLockOwner(lockPath);
    if (
      !priorOwner ||
      priorOwner.host !== hostname() ||
      localProcessIsAlive(priorOwner.pid)
    ) {
      return null;
    }

    // The PostgreSQL advisory lock serializes recovery attempts. The recorded
    // local process is confirmed dead, so its filesystem claim is abandoned.
    fs.rmSync(lockPath, { recursive: true, force: true });
    if (!claim()) return null;
  }

  const assertOwned = (): void => {
    const current = readFilesystemLockOwner(lockPath);
    if (!current || current.host !== owner.host || current.pid !== owner.pid || current.token !== owner.token) {
      throw new Error("Conversion filesystem ownership was lost; no further files may be changed");
    }
  };

  return {
    lockPath,
    assertOwned,
    release() {
      assertOwned();
      fs.rmSync(lockPath, { recursive: true });
    },
  };
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
