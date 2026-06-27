import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { GetSettingsResponse, UpdateSettingsBody, TestImmichConnectionBody } from "@workspace/api-zod";
import * as fs from "fs";
import * as path from "path";

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
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: "Invalid request" });
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

router.post("/settings/test-immich", async (req, res) => {
  try {
    const { baseUrl, apiKey } = TestImmichConnectionBody.parse(req.body);
    const url = `${baseUrl.replace(/\/$/, "")}/api/server/statistics`;
    const response = await fetch(url, {
      headers: { "x-api-key": apiKey },
    });
    if (!response.ok) {
      res.json({ connected: false, message: `Immich returned ${response.status}`, photoCount: null, videoCount: null });
      return;
    }
    const data = await response.json() as any;
    res.json({
      connected: true,
      message: "Connected successfully",
      photoCount: data.photos ?? 0,
      videoCount: data.videos ?? 0,
    });
  } catch (err) {
    res.json({ connected: false, message: `Connection failed: ${err instanceof Error ? err.message : "Unknown error"}`, photoCount: null, videoCount: null });
  }
});

export default router;
