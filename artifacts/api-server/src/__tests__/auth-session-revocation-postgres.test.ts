import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { pool } from "@workspace/db";
import {
  isSessionRevoked,
  revokeOtherSessions,
  revokeSession,
  revokeSessionForCredential,
} from "../lib/auth-session-revocation.ts";

const settingsId = 1_987_654_321;
const credentialVersion = "a".repeat(64);
const sidPrefix = `audit-revocation-${randomUUID()}-`;
const sids = {
  logout: `${sidPrefix}logout`,
  targeted: `${sidPrefix}targeted`,
  wrongScope: `${sidPrefix}wrong-scope`,
  current: `${sidPrefix}current`,
  otherOne: `${sidPrefix}other-one`,
  otherExpired: `${sidPrefix}other-expired`,
  unrelated: `${sidPrefix}unrelated`,
};

async function ensureTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "session" (
      sid varchar PRIMARY KEY,
      sess json NOT NULL,
      expire timestamp(6) NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS revoked_sessions (
      sid varchar PRIMARY KEY,
      revoked_at timestamp NOT NULL DEFAULT now()
    )
  `);
}

async function writeSession(
  sid: string,
  ownerSettingsId = settingsId,
  version = credentialVersion,
  expired = false,
): Promise<void> {
  const sess = JSON.stringify({
    authenticated: true,
    credentialSettingsId: ownerSettingsId,
    credentialVersion: version,
  });
  await pool.query(
    `INSERT INTO "session" (sid, sess, expire)
     VALUES ($1, $2::json, $3)
     ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
    [sid, sess, expired ? new Date(Date.now() - 60_000) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)],
  );
}

async function simulateLateSessionStoreUpsert(sid: string): Promise<void> {
  // connect-pg-simple's set() uses an upsert; simulate a request that loaded
  // the session before revocation and saves it after the session row is deleted.
  await writeSession(sid);
}

after(async () => {
  const ids = Object.values(sids);
  await pool.query('DELETE FROM "session" WHERE sid = ANY($1::varchar[])', [ids]).catch(() => {});
  await pool.query("DELETE FROM revoked_sessions WHERE sid = ANY($1::varchar[])", [ids]).catch(() => {});
  await pool.end();
});

test("durable revocation tombstones survive late session-store upserts", async () => {
  await ensureTables();

  // Logout: the old session row is deleted, then an in-flight response saves it again.
  await writeSession(sids.logout);
  await revokeSession(sids.logout);
  await simulateLateSessionStoreUpsert(sids.logout);
  assert.equal(await isSessionRevoked(sids.logout), true);
  const resurrectedLogout = await pool.query('SELECT sid FROM "session" WHERE sid = $1', [sids.logout]);
  assert.equal(resurrectedLogout.rowCount, 1, "test must reproduce the late upsert rather than only testing row deletion");

  // Targeted device revocation is scoped to the current account credential.
  await writeSession(sids.targeted);
  await writeSession(sids.wrongScope);
  await revokeSessionForCredential(sids.wrongScope, {
    settingsId: settingsId + 1,
    credentialVersion,
  });
  assert.equal(await isSessionRevoked(sids.wrongScope), false);
  await revokeSessionForCredential(sids.targeted, { settingsId, credentialVersion });
  await simulateLateSessionStoreUpsert(sids.targeted);
  assert.equal(await isSessionRevoked(sids.targeted), true);

  // Revoke-all preserves the current SID, captures expired rows that can still
  // be held by an in-flight request, and fences late upserts for every target.
  await writeSession(sids.current);
  await writeSession(sids.otherOne);
  await writeSession(sids.otherExpired, settingsId, credentialVersion, true);
  await writeSession(sids.unrelated, settingsId + 1, credentialVersion);
  await revokeOtherSessions(sids.current, { settingsId, credentialVersion });
  await simulateLateSessionStoreUpsert(sids.otherOne);
  await simulateLateSessionStoreUpsert(sids.otherExpired);
  assert.equal(await isSessionRevoked(sids.current), false);
  assert.equal(await isSessionRevoked(sids.otherOne), true);
  assert.equal(await isSessionRevoked(sids.otherExpired), true);
  assert.equal(await isSessionRevoked(sids.unrelated), false);
  const current = await pool.query('SELECT sid FROM "session" WHERE sid = $1', [sids.current]);
  assert.equal(current.rowCount, 1, "revoke-all must preserve the current session");
});
