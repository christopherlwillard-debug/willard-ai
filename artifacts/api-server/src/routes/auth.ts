import { randomBytes } from "crypto";
import { authorizeFirstRunSetup } from "../lib/setup-authorization.ts";
import { Router, type IRouter, type Request, type Response } from "express";
import { db, pool } from "@workspace/db";
import { appSettingsTable } from "@workspace/db";
import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { UAParser } from "ua-parser-js";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { logger } from "../lib/logger.ts";
import { credentialVersion, isSessionCredentialCurrent, persistSessionUnderCredentialLock, type CredentialLock } from "../lib/auth-session-guard.ts";
import { isSessionRevoked, revokeOtherSessions, revokeSession, revokeSessionForCredential } from "../lib/auth-session-revocation.ts";

const router: IRouter = Router();

const BCRYPT_ROUNDS = 12;
const passwordSchema = z.string().min(6, "Password must be at least 6 characters.").max(256, "Password is too long.");
const setupSchema = z.object({ password: passwordSchema, setupToken: z.string().max(256).optional() }).strict();
const loginSchema = z.object({ password: z.string().min(1, "Password required.").max(256, "Password is too long.") }).strict();
const recoverySchema = z.object({
  recoveryKey: z.string().min(1, "Recovery key and new password are required.").max(128),
  newPassword: passwordSchema,
}).strict();
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current and new password are required.").max(256),
  newPassword: passwordSchema,
}).strict();

function validationError(result: { success: false; error: z.ZodError }): string {
  return result.error.issues[0]?.message ?? "Invalid request.";
}

function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

async function establishSession(req: Request): Promise<void> {
  // Session regeneration is also a revocation boundary: an older in-flight
  // request can still save the previous SID after express-session destroys it.
  if ((req.session as any)?.authenticated === true) {
    await revokeSession(req.sessionID);
  }
  await regenerateSession(req);
  const sess = req.session as any;
  const now = new Date().toISOString();
  sess.authenticated = true;
  sess.deviceName = getDeviceName(req);
  sess.ip = req.ip ?? "";
  sess.createdAt = now;
  sess.lastSeenAt = now;
}

function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

async function destroySession(req: Request): Promise<void> {
  const sid = req.sessionID;
  const wasAuthenticated = (req.session as any)?.authenticated === true;
  // Persist the tombstone before deleting the session row. If this write fails,
  // propagate the error so callers cannot report revocation as successful.
  if (wasAuthenticated) await revokeSession(sid);
  try {
    await new Promise<void>((resolve, reject) => {
      req.session.destroy((err) => (err ? reject(err) : resolve()));
    });
  } catch (error) {
    // The tombstone is authoritative even if the session-store delete fails.
    try {
      await pool.query("DELETE FROM session WHERE sid = $1", [sid]);
    } catch (fallbackError) {
      if (!wasAuthenticated) {
        throw new AggregateError([error, fallbackError], "Could not destroy an unauthenticated session");
      }
      logger.warn({ err: fallbackError, operation: "revoked_session_row_cleanup", sid }, "Session row cleanup failed; durable revocation tombstone remains active");
    }
  }
}

async function acquireCredentialLock(settingsId: number): Promise<CredentialLock> {
  const client = await pool.connect();
  let finished = false;
  try {
    await client.query("BEGIN");
    const result = await client.query<{ password_hash: string | null }>(
      "SELECT password_hash FROM app_settings WHERE id = $1 FOR SHARE",
      [settingsId],
    );
    return {
      passwordHash: result.rows[0]?.password_hash ?? null,
      commit: async () => {
        if (finished) return;
        await client.query("COMMIT");
        finished = true;
        client.release();
      },
      rollback: async () => {
        if (finished) return;
        try {
          await client.query("ROLLBACK");
        } finally {
          finished = true;
          client.release();
        }
      },
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    throw error;
  }
}

/**
 * Regenerate and persist the session while holding a shared lock on the
 * credential row. Password changes take an update lock on that same row
 * before deleting sessions, so neither operation can pass the other between
 * credential verification and session persistence.
 */
async function establishSessionForPassword(
  req: Request,
  settingsId: number,
  expectedPasswordHash: string,
): Promise<boolean> {
  return persistSessionUnderCredentialLock(
    expectedPasswordHash,
    () => acquireCredentialLock(settingsId),
    async () => {
      await establishSession(req);
      const sess = req.session as any;
      sess.credentialSettingsId = settingsId;
      sess.credentialVersion = credentialVersion(expectedPasswordHash);
      await saveSession(req);
    },
    () => destroySession(req),
  );
}

function normalizeRecoveryKey(key: string): string {
  return key.replace(/[\s-]/g, "").toUpperCase();
}

function generateRecoveryKey(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const groups = Array.from({ length: 4 }, () =>
    Array.from({ length: 4 }, () => {
      const byte = randomBytes(1)[0];
      return chars[byte % chars.length];
    }).join("")
  );
  return groups.join("-");
}

function getDeviceName(req: Request): string {
  const ua = req.headers["user-agent"] ?? "";
  const parser = new UAParser(ua);
  const browser = parser.getBrowser().name ?? "Unknown Browser";
  const os = parser.getOS().name ?? "Unknown OS";
  return `${browser} on ${os}`;
}

function isAuthenticated(req: Request): boolean {
  const sess = req.session as any;
  return sess?.authenticated === true;
}

/**
 * Change the credential and revoke every existing session as one database
 * transaction. If session deletion fails, the password change must roll back
 * too; otherwise old authenticated sessions could survive a credential reset.
 */
async function updatePasswordAndRevokeSessions(
  settingsId: number,
  expectedHash: string,
  newHash: string,
  consumeRecoveryKey = false,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const update = consumeRecoveryKey
      ? await client.query(
          "UPDATE app_settings SET password_hash = $1, recovery_key_hash = NULL WHERE id = $2 AND recovery_key_hash = $3 RETURNING id",
          [newHash, settingsId, expectedHash],
        )
      : await client.query(
          "UPDATE app_settings SET password_hash = $1 WHERE id = $2 AND password_hash = $3 RETURNING id",
          [newHash, settingsId, expectedHash],
        );
    if (update.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query("DELETE FROM session");
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getOrCreateSettings() {
  // app_settings is logically a singleton, but older installs can contain
  // duplicate rows after concurrent first-run requests. Prefer the row that
  // actually owns authentication so setup and login cannot disagree.
  const rows = await db.select().from(appSettingsTable)
    .orderBy(desc(isNotNull(appSettingsTable.passwordHash)), asc(appSettingsTable.id))
    .limit(1);
  if (rows.length > 0) return rows[0];
  try {
    const [created] = await db.insert(appSettingsTable).values({}).returning();
    return created;
  } catch (error: any) {
    // A singleton unique index can race two first requests. The loser reads
    // the row created by the winner instead of exposing a database error.
    if (error?.code !== "23505") throw error;
    const [existing] = await db.select().from(appSettingsTable)
      .orderBy(desc(isNotNull(appSettingsTable.passwordHash)), asc(appSettingsTable.id))
      .limit(1);
    if (!existing) throw error;
    return existing;
  }
}

export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  // Successful logins should not consume the failed-attempt budget. This
  // keeps repeated health/audit sessions independent while continuing to
  // throttle incorrect-password attempts.
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again in 15 minutes." },
});

const setupRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many first-run setup attempts. Try again in 15 minutes." },
});

const recoverRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many recovery attempts. Try again in 15 minutes." },
});

router.get("/auth/status", async (req: Request, res: Response) => {
  try {
    const settings = await getOrCreateSettings();
    if (!settings.passwordHash) {
      res.json({ setup: true, authenticated: false });
      return;
    }
    const sess = req.session as any;
    const sessionRevoked = sess?.authenticated === true ? await isSessionRevoked(req.sessionID) : false;
    const authenticated = sess?.authenticated === true && !sessionRevoked &&
      sess.credentialSettingsId === settings.id &&
      isSessionCredentialCurrent(sess.credentialVersion, settings.passwordHash);
    if (sess?.authenticated === true && !authenticated) {
      await destroySession(req);
      res.clearCookie("willard.sid");
    }
    res.json({ setup: false, authenticated });
  } catch {
    res.clearCookie("willard.sid");
    res.status(503).json({ error: "Session status could not be verified. Please retry." });
  }
});

router.post("/auth/setup", setupRateLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = setupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: validationError(parsed) });
      return;
    }

    const authorization = authorizeFirstRunSetup({
      remoteAddress: req.socket.remoteAddress,
      allowLoopbackSetup:
        process.env["WILLARD_LOCAL_SETUP"] === "true" &&
        process.env["REPL_ID"] === undefined &&
        process.env["HOST"]?.trim() === "127.0.0.1",
      configuredToken: process.env["WILLARD_SETUP_TOKEN"],
      suppliedToken: parsed.data.setupToken,
    });
    if (authorization === "token_misconfigured") {
      res.status(503).json({
        error: "Remote first-run setup is locked. Configure WILLARD_SETUP_TOKEN with a secret of at least 32 characters, then restart the server.",
      });
      return;
    }
    if (authorization === "token_required" || authorization === "token_invalid") {
      res.status(403).json({ error: "A valid remote setup token is required to claim the first administrator account." });
      return;
    }

    const settings = await getOrCreateSettings();
    if (settings.passwordHash) {
      res.status(409).json({ error: "Password already set. Use change-password instead." });
      return;
    }
    const { password } = parsed.data;
    const recoveryKey = generateRecoveryKey();
    const recoveryKeyNormalized = normalizeRecoveryKey(recoveryKey);
    const [passwordHash, recoveryKeyHash] = await Promise.all([
      bcrypt.hash(password, BCRYPT_ROUNDS),
      bcrypt.hash(recoveryKeyNormalized, BCRYPT_ROUNDS),
    ]);
    const [updated] = await db.update(appSettingsTable)
      .set({ passwordHash, recoveryKeyHash })
      .where(and(eq(appSettingsTable.id, settings.id), isNull(appSettingsTable.passwordHash)))
      .returning();
    if (!updated) {
      res.status(409).json({ error: "Password already set. Use change-password instead." });
      return;
    }

    if (!await establishSessionForPassword(req, updated.id, passwordHash)) {
      res.clearCookie("willard.sid");
      res.status(409).json({ error: "Password changed while setup was finishing. Please log in again." });
      return;
    }

    res.json({ ok: true, recoveryKey });
  } catch (err) {
    logger.error({ err, operation: "auth_setup" }, "Authentication setup failed");
    res.clearCookie("willard.sid");
    res.status(500).json({ error: "Setup failed" });
  }
});

router.post("/auth/login", loginRateLimiter, async (req: Request, res: Response) => {
  try {
    const settings = await getOrCreateSettings();
    if (!settings.passwordHash) {
      res.status(400).json({ error: "No password set. Complete setup first." });
      return;
    }
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: validationError(parsed) });
      return;
    }
    const { password } = parsed.data;
    const valid = await bcrypt.compare(password, settings.passwordHash);
    if (!valid) {
      res.status(401).json({ error: "Incorrect password." });
      return;
    }
    if (!await establishSessionForPassword(req, settings.id, settings.passwordHash)) {
      res.clearCookie("willard.sid");
      res.status(401).json({ error: "Password changed during login. Please try again." });
      return;
    }

    res.json({ ok: true });
  } catch {
    res.clearCookie("willard.sid");
    res.status(500).json({ error: "Login failed" });
  }
});

router.post("/auth/logout", async (req: Request, res: Response) => {
  try {
    await destroySession(req);
    res.clearCookie("willard.sid");
    res.json({ ok: true });
  } catch (error) {
    logger.error({ err: error, operation: "auth_logout_revocation" }, "Logout could not be durably confirmed");
    res.clearCookie("willard.sid");
    res.status(503).json({ error: "Logout could not be confirmed. Please retry." });
  }
});

router.post("/auth/recover", recoverRateLimiter, async (req: Request, res: Response) => {
  try {
    const settings = await getOrCreateSettings();
    if (!settings.recoveryKeyHash) {
      res.status(400).json({ error: "No recovery key configured." });
      return;
    }
    const parsed = recoverySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: validationError(parsed) });
      return;
    }
    const { recoveryKey, newPassword } = parsed.data;
    const normalizedKey = normalizeRecoveryKey(recoveryKey);
    const valid = await bcrypt.compare(normalizedKey, settings.recoveryKeyHash);
    if (!valid) {
      res.status(401).json({ error: "Invalid recovery key." });
      return;
    }
    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    const consumed = await updatePasswordAndRevokeSessions(
      settings.id,
      settings.recoveryKeyHash,
      newHash,
      true,
    );
    if (!consumed) {
      res.status(401).json({ error: "Recovery key has already been used." });
      return;
    }

    if (!await establishSessionForPassword(req, settings.id, newHash)) {
      res.clearCookie("willard.sid");
      res.status(409).json({ error: "Password changed while recovery was finishing. Please log in again." });
      return;
    }

    res.json({ ok: true });
  } catch {
    res.clearCookie("willard.sid");
    res.status(500).json({ error: "Recovery failed" });
  }
});

router.get("/auth/sessions", async (req: Request, res: Response) => {
  if (!isAuthenticated(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const currentSid = req.sessionID;
    const currentSession = req.session as any;
    const result = await pool.query<{ sid: string; sess: any; expire: Date }>(
      `SELECT sid, sess, expire
         FROM session
        WHERE expire > NOW()
          AND sess->>'credentialSettingsId' = $1
          AND sess->>'credentialVersion' = $2
          AND NOT EXISTS (SELECT 1 FROM revoked_sessions r WHERE r.sid = session.sid)
        ORDER BY (sess->>'createdAt') DESC NULLS LAST`,
      [String(currentSession.credentialSettingsId), currentSession.credentialVersion],
    );
    const sessions = result.rows.map((row) => ({
      sid: row.sid,
      deviceName: (row.sess?.deviceName as string) ?? "Unknown device",
      ip: (row.sess?.ip as string) ?? "",
      createdAt: (row.sess?.createdAt as string) ?? null,
      lastSeenAt: (row.sess?.lastSeenAt as string) ?? null,
      expiresAt: row.expire,
      isCurrent: row.sid === currentSid,
    }));
    res.json({ sessions });
  } catch {
    res.status(500).json({ error: "Failed to list sessions" });
  }
});

router.delete("/auth/sessions/:sid", async (req: Request, res: Response) => {
  if (!isAuthenticated(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const sidParam = req.params.sid;
    const sid = Array.isArray(sidParam) ? sidParam[0] : sidParam;
    if (typeof sid !== "string" || sid.length === 0 || sid.length > 256) {
      res.status(400).json({ error: "Invalid session id." });
      return;
    }
    if (sid === req.sessionID) {
      res.status(400).json({ error: "Use /auth/logout to end the current session." });
      return;
    }
    const currentSession = req.session as any;
    await revokeSessionForCredential(sid, {
      settingsId: currentSession.credentialSettingsId,
      credentialVersion: currentSession.credentialVersion,
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to revoke session" });
  }
});

router.delete("/auth/sessions", async (req: Request, res: Response) => {
  if (!isAuthenticated(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const currentSid = req.sessionID;
    const currentSession = req.session as any;
    await revokeOtherSessions(currentSid, {
      settingsId: currentSession.credentialSettingsId,
      credentialVersion: currentSession.credentialVersion,
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to revoke other sessions" });
  }
});

router.post("/auth/change-password", async (req: Request, res: Response) => {
  if (!isAuthenticated(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const settings = await getOrCreateSettings();
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: validationError(parsed) });
      return;
    }
    const { currentPassword, newPassword } = parsed.data;
    const valid = await bcrypt.compare(currentPassword, settings.passwordHash!);
    if (!valid) {
      res.status(401).json({ error: "Current password is incorrect." });
      return;
    }
    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    const changed = await updatePasswordAndRevokeSessions(
      settings.id,
      settings.passwordHash!,
      newHash,
    );
    if (!changed) {
      res.status(409).json({ error: "Password changed in another session. Please log in again." });
      return;
    }
    if (!await establishSessionForPassword(req, settings.id, newHash)) {
      res.clearCookie("willard.sid");
      res.status(409).json({ error: "Password changed while the update was finishing. Please log in again." });
      return;
    }
    res.json({ ok: true });
  } catch {
    res.clearCookie("willard.sid");
    res.status(500).json({ error: "Failed to change password" });
  }
});

export default router;
