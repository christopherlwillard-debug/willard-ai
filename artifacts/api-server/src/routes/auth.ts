import { randomBytes } from "crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { db, pool } from "@workspace/db";
import { appSettingsTable } from "@workspace/db";
import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { UAParser } from "ua-parser-js";
import rateLimit from "express-rate-limit";
import { z } from "zod";

const router: IRouter = Router();

const BCRYPT_ROUNDS = 12;
const passwordSchema = z.string().min(6, "Password must be at least 6 characters.").max(256, "Password is too long.");
const setupSchema = z.object({ password: passwordSchema }).strict();
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
  await regenerateSession(req);
  const sess = req.session as any;
  const now = new Date().toISOString();
  sess.authenticated = true;
  sess.deviceName = getDeviceName(req);
  sess.ip = req.ip ?? "";
  sess.createdAt = now;
  sess.lastSeenAt = now;
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
    res.json({ setup: false, authenticated: sess?.authenticated === true });
  } catch {
    res.status(500).json({ error: "Failed to check auth status" });
  }
});

router.post("/auth/setup", async (req: Request, res: Response) => {
  try {
    const settings = await getOrCreateSettings();
    if (settings.passwordHash) {
      res.status(409).json({ error: "Password already set. Use change-password instead." });
      return;
    }
    const parsed = setupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: validationError(parsed) });
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

    await establishSession(req);

    res.json({ ok: true, recoveryKey });
  } catch (err) {
    console.error("Setup error:", err);
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
    await establishSession(req);

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Login failed" });
  }
});

router.post("/auth/logout", (req: Request, res: Response) => {
  req.session.destroy((err) => {
    if (err) {
      res.status(500).json({ error: "Logout failed" });
      return;
    }
    res.clearCookie("willard.sid");
    res.json({ ok: true });
  });
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
    const consumed = await pool.query(
      `UPDATE app_settings
       SET password_hash = $1, recovery_key_hash = NULL
       WHERE id = $2 AND recovery_key_hash = $3
       RETURNING id`,
      [newHash, settings.id, settings.recoveryKeyHash],
    );
    if (consumed.rowCount !== 1) {
      res.status(401).json({ error: "Recovery key has already been used." });
      return;
    }

    await pool.query("DELETE FROM session");
    await establishSession(req);

    res.json({ ok: true });
  } catch {
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
    const result = await pool.query<{ sid: string; sess: any; expire: Date }>(
      `SELECT sid, sess, expire FROM session WHERE expire > NOW() ORDER BY (sess->>'createdAt') DESC NULLS LAST`
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
    const { sid } = req.params;
    if (sid === req.sessionID) {
      res.status(400).json({ error: "Use /auth/logout to end the current session." });
      return;
    }
    await pool.query("DELETE FROM session WHERE sid = $1", [sid]);
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
    await pool.query("DELETE FROM session WHERE sid != $1 AND expire > NOW()", [currentSid]);
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
    await db.update(appSettingsTable)
      .set({ passwordHash: newHash })
      .where(eq(appSettingsTable.id, settings.id));
    await pool.query("DELETE FROM session");
    await establishSession(req);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to change password" });
  }
});

export default router;
