import { pool } from "@workspace/db";

export interface SessionCredentialScope {
  settingsId: number;
  credentialVersion: string;
}

type SessionRevocationClient = Awaited<ReturnType<typeof pool.connect>>;

async function inTransaction(work: (client: SessionRevocationClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await work(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function assertCredentialScope(scope: SessionCredentialScope): void {
  if (!Number.isSafeInteger(scope.settingsId) || scope.settingsId <= 0 ||
      !/^[a-f0-9]{64}$/.test(scope.credentialVersion)) {
    throw new Error("A valid current credential scope is required to revoke sessions.");
  }
}

/** A tombstone remains authoritative even if connect-pg-simple later upserts the SID again. */
export async function isSessionRevoked(sid: string): Promise<boolean> {
  const result = await pool.query<{ revoked: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM revoked_sessions WHERE sid = $1) AS revoked",
    [sid],
  );
  return result.rows[0]?.revoked === true;
}

/** Revoke one known SID; callers use this for logout and authenticated-session cleanup. */
export async function revokeSession(sid: string): Promise<void> {
  await inTransaction(async (client) => {
    await client.query(
      "INSERT INTO revoked_sessions (sid) VALUES ($1) ON CONFLICT (sid) DO NOTHING",
      [sid],
    );
    await client.query("DELETE FROM session WHERE sid = $1", [sid]);
  });
}

/** Revoke a listed device only when its row belongs to the caller's current credential version. */
export async function revokeSessionForCredential(
  sid: string,
  scope: SessionCredentialScope,
): Promise<void> {
  assertCredentialScope(scope);
  await inTransaction(async (client) => {
    await client.query(
      `INSERT INTO revoked_sessions (sid)
       SELECT sid FROM session
        WHERE sid = $1
          AND sess->>'credentialSettingsId' = $2
          AND sess->>'credentialVersion' = $3
       ON CONFLICT (sid) DO NOTHING`,
      [sid, String(scope.settingsId), scope.credentialVersion],
    );
    await client.query(
      `DELETE FROM session
        WHERE sid = $1
          AND EXISTS (SELECT 1 FROM revoked_sessions WHERE sid = $1)`,
      [sid],
    );
  });
}

/** Tombstone every other session in this credential generation before deleting its row. */
export async function revokeOtherSessions(
  currentSid: string,
  scope: SessionCredentialScope,
): Promise<void> {
  assertCredentialScope(scope);
  await inTransaction(async (client) => {
    // Do not filter by expire: an in-flight request may have loaded a row just
    // before expiry and still attempt a late session-store upsert afterward.
    await client.query(
      `INSERT INTO revoked_sessions (sid)
       SELECT sid FROM session
        WHERE sid <> $1
          AND sess->>'credentialSettingsId' = $2
          AND sess->>'credentialVersion' = $3
       ON CONFLICT (sid) DO NOTHING`,
      [currentSid, String(scope.settingsId), scope.credentialVersion],
    );
    await client.query(
      `DELETE FROM session
        WHERE sid <> $1
          AND sess->>'credentialSettingsId' = $2
          AND sess->>'credentialVersion' = $3
          AND sid IN (SELECT sid FROM revoked_sessions)`,
      [currentSid, String(scope.settingsId), scope.credentialVersion],
    );
  });
}
