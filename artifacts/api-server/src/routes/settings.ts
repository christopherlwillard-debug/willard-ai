import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { GetSettingsResponse, UpdateSettingsBody } from "@workspace/api-zod";
import * as fs from "fs";
import * as path from "path";
import { bootstrapWillardAIDir, getNasDirStatus, checkNasReachable, nasLogStream } from "../lib/nas-storage";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const LOGO_MAX_BYTES = 2 * 1024 * 1024; // 2MB

const LOGO_CONTENT_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
};

const uploadLogo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LOGO_MAX_BYTES, files: 1 },
});

// Wrap multer so its errors (e.g. file too large) become a friendly 400 instead
// of falling through to the generic 500 error handler.
function handleLogoUpload(req: Request, res: Response, next: NextFunction): void {
  uploadLogo.single("file")(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? "File too large. Maximum size is 2MB."
          : "Invalid upload.";
      res.status(400).json({ error: message });
      return;
    }
    if (err) {
      next(err);
      return;
    }
    next();
  });
}

function getBrandingDir(): string {
  return path.join(process.cwd(), "data", "branding");
}

// Defense-in-depth: only ever read/delete files inside the branding dir, even if
// the stored DB path were somehow tampered with.
function isWithinBrandingDir(targetPath: string): boolean {
  const root = path.resolve(getBrandingDir());
  const resolved = path.resolve(targetPath);
  return resolved === root || resolved.startsWith(root + path.sep);
}

async function getOrCreateSettings() {
  const rows = await db.select().from(appSettingsTable).limit(1);
  if (rows.length > 0) return rows[0];
  const [created] = await db.insert(appSettingsTable).values({}).returning();
  return created;
}

// Never send credential hashes to the client.
function sanitizeSettings<T extends Record<string, unknown>>(settings: T): Omit<T, "passwordHash" | "recoveryKeyHash"> {
  const { passwordHash: _p, recoveryKeyHash: _r, ...rest } = settings;
  return rest as Omit<T, "passwordHash" | "recoveryKeyHash">;
}

router.get("/settings", async (_req, res) => {
  try {
    const settings = await getOrCreateSettings();
    res.json(sanitizeSettings(settings));
  } catch (err) {
    res.status(500).json({ error: "Failed to load settings" });
  }
});

router.put("/settings", async (req, res) => {
  try {
    const body = UpdateSettingsBody.parse(req.body);
    const existing = await getOrCreateSettings();

    // Boolean flags → timestamp columns (one-way switches from the UI)
    const { onboardingDismissed, celebrationShown, ...rest } = body;
    const extra: Record<string, unknown> = {};
    if (onboardingDismissed === true) extra["onboardingDismissedAt"] = new Date();
    if (celebrationShown === true) extra["celebrationShownAt"] = new Date();

    // Validate a changed library location BEFORE persisting anything: a failed
    // save must not commit. Also never auto-create a WillardAI directory for a
    // location we cannot reach (e.g. a Windows "Z:" drive) — doing so creates a
    // fake local folder that later masks the offline state by reporting "online".
    if (body.nasPath && body.nasPath !== existing.nasPath) {
      const reach = checkNasReachable(body.nasPath);
      if (!reach.online) {
        res.status(422).json({
          error: `Library Offline — ${reach.message}. The library location was NOT saved because it cannot be reached from this server.`,
        });
        return;
      }
      try {
        bootstrapWillardAIDir(body.nasPath);
        nasLogStream.setNasPath(body.nasPath).catch(() => {});
        logger.info({ nasPath: body.nasPath }, "WillardAI directory bootstrapped on NAS");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        logger.warn({ err, nasPath: body.nasPath }, "Failed to create WillardAI directory on NAS");
        res.status(422).json({
          error: `Library location was NOT saved: the WillardAI directory could not be created at '${body.nasPath}/WillardAI': ${msg}. Ensure the path is mounted and writable.`,
        });
        return;
      }
    }

    const [updated] = await db
      .update(appSettingsTable)
      .set({ ...rest, ...extra })
      .where(eq(appSettingsTable.id, existing.id))
      .returning();

    res.json(sanitizeSettings(updated));
  } catch (err) {
    res.status(400).json({ error: "Invalid request" });
  }
});

router.get("/settings/nas-dir-status", async (_req, res) => {
  try {
    const settings = await getOrCreateSettings();
    if (!settings.nasPath) {
      res.json({ nasPath: "", willardAiPath: "", exists: false, allPresent: false, subdirs: [] });
      return;
    }
    const status = getNasDirStatus(settings.nasPath);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: "Failed to check NAS directory status" });
  }
});

router.post("/settings/reinit-nas-dirs", async (_req, res) => {
  try {
    const settings = await getOrCreateSettings();
    if (!settings.nasPath) {
      res.status(400).json({ error: "NAS path not configured" });
      return;
    }
    const result = bootstrapWillardAIDir(settings.nasPath);
    nasLogStream.setNasPath(settings.nasPath).catch(() => {});
    logger.info({ nasPath: settings.nasPath }, "WillardAI directories reinitialized");
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Failed to reinitialize NAS directories" });
  }
});

router.post("/settings/test-nas", async (req, res) => {
  try {
    const { path: nasPath } = req.body as { path: string };
    const r = checkNasReachable(nasPath);
    res.json({
      accessible: r.online,
      message: r.online ? r.message.replace(/^Online/, "Accessible") : r.message,
      path: r.path,
      isDirectory: r.isDirectory,
      readable: r.readable,
    });
  } catch (err) {
    res.json({ accessible: false, message: `Error: ${err instanceof Error ? err.message : "Unknown"}`, path: "", isDirectory: false, readable: false });
  }
});

router.get("/settings/logo", async (_req, res) => {
  try {
    const settings = await getOrCreateSettings();
    if (!settings.logoPath || !isWithinBrandingDir(settings.logoPath) || !fs.existsSync(settings.logoPath)) {
      res.status(404).json({ error: "No logo set" });
      return;
    }
    const ext = path.extname(settings.logoPath).toLowerCase();
    const contentType =
      ext === ".png" ? "image/png" :
      ext === ".svg" ? "image/svg+xml" :
      ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
      "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-cache");
    fs.createReadStream(settings.logoPath).pipe(res);
  } catch (err) {
    res.status(500).json({ error: "Failed to load logo" });
  }
});

router.post(
  "/settings/logo",
  handleLogoUpload,
  async (req, res) => {
    try {
      const file = req.file;
      if (!file || file.size === 0) {
        res.status(400).json({ error: "No file data received" });
        return;
      }
      const contentType = (file.mimetype ?? "").split(";")[0].trim();
      const ext = LOGO_CONTENT_TYPES[contentType];
      if (!ext) {
        res.status(400).json({ error: "Unsupported file type. Use PNG, JPG, or SVG." });
        return;
      }
      const body = file.buffer;

      const settings = await getOrCreateSettings();
      const dir = getBrandingDir();
      fs.mkdirSync(dir, { recursive: true });

      // Remove any previously stored logo (it may have a different extension)
      if (settings.logoPath && isWithinBrandingDir(settings.logoPath) && fs.existsSync(settings.logoPath)) {
        try { fs.unlinkSync(settings.logoPath); } catch { /* non-fatal */ }
      }

      const destPath = path.join(dir, `logo.${ext}`);
      fs.writeFileSync(destPath, body);

      const [updated] = await db
        .update(appSettingsTable)
        .set({ logoPath: destPath })
        .where(eq(appSettingsTable.id, settings.id))
        .returning();

      logger.info({ destPath }, "Branding logo uploaded");
      res.json(sanitizeSettings(updated));
    } catch (err) {
      logger.error({ err }, "Failed to upload logo");
      res.status(500).json({ error: "Failed to upload logo" });
    }
  },
);

router.delete("/settings/logo", async (_req, res) => {
  try {
    const settings = await getOrCreateSettings();
    if (settings.logoPath && isWithinBrandingDir(settings.logoPath) && fs.existsSync(settings.logoPath)) {
      try { fs.unlinkSync(settings.logoPath); } catch { /* non-fatal */ }
    }
    const [updated] = await db
      .update(appSettingsTable)
      .set({ logoPath: null })
      .where(eq(appSettingsTable.id, settings.id))
      .returning();
    res.json(sanitizeSettings(updated));
  } catch (err) {
    res.status(500).json({ error: "Failed to remove logo" });
  }
});

export default router;
