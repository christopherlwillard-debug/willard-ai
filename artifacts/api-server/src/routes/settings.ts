import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { GetSettingsResponse, UpdateSettingsBody } from "@workspace/api-zod";
import * as fs from "fs";
import * as path from "path";
import { bootstrapWillardAIDir, getNasDirStatus, nasLogStream } from "../lib/nas-storage";
import { logger } from "../lib/logger";

const router: IRouter = Router();

async function getOrCreateSettings() {
  const rows = await db.select().from(appSettingsTable).limit(1);
  if (rows.length > 0) return rows[0];
  const [created] = await db.insert(appSettingsTable).values({}).returning();
  return created;
}

router.get("/settings", async (_req, res) => {
  try {
    const settings = await getOrCreateSettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: "Failed to load settings" });
  }
});

router.put("/settings", async (req, res) => {
  try {
    const body = UpdateSettingsBody.parse(req.body);
    const existing = await getOrCreateSettings();
    const [updated] = await db
      .update(appSettingsTable)
      .set({ ...body })
      .where(eq(appSettingsTable.id, existing.id))
      .returning();

    if (body.nasPath && body.nasPath !== existing.nasPath) {
      try {
        bootstrapWillardAIDir(body.nasPath);
        nasLogStream.setNasPath(body.nasPath).catch(() => {});
        logger.info({ nasPath: body.nasPath }, "WillardAI directory bootstrapped on NAS");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        logger.warn({ err, nasPath: body.nasPath }, "Failed to create WillardAI directory on NAS");
        res.status(422).json({
          error: `Settings saved, but WillardAI directory could not be created at '${body.nasPath}/WillardAI': ${msg}. Ensure the NAS path is mounted and writable.`,
        });
        return;
      }
    }

    res.json(updated);
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
    if (!nasPath || typeof nasPath !== "string") {
      res.json({ accessible: false, message: "No path provided", path: nasPath ?? "", isDirectory: false, readable: false });
      return;
    }
    const resolved = path.resolve(nasPath);
    if (!fs.existsSync(resolved)) {
      res.json({ accessible: false, message: `Path not found: ${resolved}`, path: resolved, isDirectory: false, readable: false });
      return;
    }
    const stat = fs.statSync(resolved);
    const isDirectory = stat.isDirectory();
    if (!isDirectory) {
      res.json({ accessible: false, message: "Path exists but is not a directory", path: resolved, isDirectory: false, readable: false });
      return;
    }
    try {
      fs.accessSync(resolved, fs.constants.R_OK);
    } catch {
      res.json({ accessible: false, message: "Directory exists but is not readable (permission denied)", path: resolved, isDirectory: true, readable: false });
      return;
    }
    const entries = fs.readdirSync(resolved);
    res.json({
      accessible: true,
      message: `Accessible — ${entries.length} item${entries.length !== 1 ? "s" : ""} at root`,
      path: resolved,
      isDirectory: true,
      readable: true,
    });
  } catch (err) {
    res.json({ accessible: false, message: `Error: ${err instanceof Error ? err.message : "Unknown"}`, path: "", isDirectory: false, readable: false });
  }
});

export default router;
