import { createHash } from "node:crypto";

/**
 * Store only a one-way fingerprint of the password hash in each session.
 * A password change produces a new bcrypt hash, invalidating every old
 * session even if an in-flight request later upserts its deleted session row.
 */
export function credentialVersion(passwordHash: unknown): string | null {
  if (typeof passwordHash !== "string" || passwordHash.length === 0) return null;
  return createHash("sha256").update(passwordHash, "utf8").digest("hex");
}

export function isSessionCredentialCurrent(sessionVersion: unknown, passwordHash: unknown): boolean {
  const currentVersion = credentialVersion(passwordHash);
  return typeof sessionVersion === "string" &&
    /^[a-f0-9]{64}$/.test(sessionVersion) &&
    currentVersion !== null &&
    sessionVersion === currentVersion;
}

/**
 * Missing, malformed, or implausibly future activity timestamps must not
 * silently disable the server's inactivity timeout.
 */
export function isSessionInactive(
  lastSeenAt: unknown,
  now = Date.now(),
  inactivityTimeoutMs = 30 * 60 * 1000,
): boolean {
  const timestamp = lastSeenAt instanceof Date
    ? lastSeenAt.getTime()
    : typeof lastSeenAt === "string" || typeof lastSeenAt === "number"
      ? new Date(lastSeenAt).getTime()
      : Number.NaN;
  return !Number.isFinite(timestamp) ||
    timestamp > now + 60_000 ||
    now - timestamp > inactivityTimeoutMs;
}

export interface CredentialLock {
  passwordHash: string | null;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * Persist an authenticated session while holding a shared lock on the
 * credential row. Password changes update that row before deleting sessions,
 * so the lock gives the two operations a strict order:
 *
 * - If this operation locks first, the password change waits, then deletes
 *   the newly saved session after this transaction commits.
 * - If the password change locks first, this operation waits and sees the
 *   new hash before it can create a session.
 *
 * The session store uses its own pool connection, but the credential lock is
 * held until that save has completed.
 */
export async function persistSessionUnderCredentialLock(
  expectedPasswordHash: string,
  acquireCredentialLock: () => Promise<CredentialLock>,
  saveSession: () => Promise<void>,
  destroySession: () => Promise<void>,
): Promise<boolean> {
  const lock = await acquireCredentialLock();
  if (lock.passwordHash !== expectedPasswordHash) {
    await lock.rollback();
    return false;
  }

  try {
    await saveSession();
    await lock.commit();
    return true;
  } catch (error) {
    let rollbackError: unknown;
    try {
      await lock.rollback();
    } catch (failure) {
      rollbackError = failure;
    }

    try {
      await destroySession();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, ...(rollbackError ? [rollbackError] : []), cleanupError],
        "Authentication session could not be safely finalized",
      );
    }

    if (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Authentication session failed and its credential lock could not be rolled back",
      );
    }
    throw error;
  }
}
