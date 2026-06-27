import { randomBytes } from "crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { db, pool } from "@workspace/db";
import { appSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { UAParser } from "ua-parser-js";
import rateLimit from "express-rate-limit";

const router: IRouter = Router();

const BCRYPT_ROUNDS = 12;

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
  const rows = await db.select().from(appSettingsTable).limit(1);
  if (rows.length > 0) return rows[0];
  const [created] = await db.insert(appSettingsTable).values({}).returning();
  return created;
}

export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
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
    const { password } = req.body as { password?: string };
    if (!password || password.length < 6) {
      res.status(400).json({ error: "Password must be at least 6 characters." });
      return;
    }
    const recoveryKey = generateRecoveryKey();
    const recoveryKeyNormalized = normalizeRecoveryKey(recoveryKey);
    const [passwordHash, recoveryKeyHash] = await Promise.all([
      bcrypt.hash(password, BCRYPT_ROUNDS),
      bcrypt.hash(recoveryKeyNormalized, BCRYPT_ROUNDS),
    ]);
    await db.update(appSettingsTable)
      .set({ passwordHash, recoveryKeyHash })
      .where(eq(appSettingsTable.id, settings.id));

    const sess = req.session as any;
    sess.authenticated = true;
    sess.deviceName = getDeviceName(req);
    sess.ip = req.ip ?? "";
    sess.createdAt = new Date().toISOString();
    sess.lastSeenAt = new Date().toISOString();

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
    const { password } = req.body as { password?: string };
    if (!password) {
      res.status(400).json({ error: "Password required." });
      return;
    }
    const valid = await bcrypt.compare(password, settings.passwordHash);
    if (!valid) {
      res.status(401).json({ error: "Incorrect password." });
      return;
    }
    const sess = req.session as any;
    sess.authenticated = true;
    sess.deviceName = getDeviceName(req);
    sess.ip = req.ip ?? "";
    sess.createdAt = new Date().toISOString();
    sess.lastSeenAt = new Date().toISOString();

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
    const { recoveryKey, newPassword } = req.body as { recoveryKey?: string; newPassword?: string };
    if (!recoveryKey || !newPassword) {
      res.status(400).json({ error: "Recovery key and new password are required." });
      return;
    }
    if (newPassword.length < 6) {
      res.status(400).json({ error: "Password must be at least 6 characters." });
      return;
    }
    const normalizedKey = normalizeRecoveryKey(recoveryKey);
    const valid = await bcrypt.compare(normalizedKey, settings.recoveryKeyHash);
    if (!valid) {
      res.status(401).json({ error: "Invalid recovery key." });
      return;
    }
    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await db.update(appSettingsTable)
      .set({ passwordHash: newHash })
      .where(eq(appSettingsTable.id, settings.id));

    const sess = req.session as any;
    sess.authenticated = true;
    sess.deviceName = getDeviceName(req);
    sess.ip = req.ip ?? "";
    sess.createdAt = new Date().toISOString();
    sess.lastSeenAt = new Date().toISOString();

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
    const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };
    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: "Current and new password are required." });
      return;
    }
    if (newPassword.length < 6) {
      res.status(400).json({ error: "New password must be at least 6 characters." });
      return;
    }
    const valid = await bcrypt.compare(currentPassword, settings.passwordHash!);
    if (!valid) {
      res.status(401).json({ error: "Current password is incorrect." });
      return;
    }
    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await db.update(appSettingsTable)
      .set({ passwordHash: newHash })
      .where(eq(appSettingsTable.id, settings.id));
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to change password" });
  }
});

export default router;
