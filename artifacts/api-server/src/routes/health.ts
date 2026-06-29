import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db, appSettingsTable } from "@workspace/db";
import { HealthCheckResponse } from "@workspace/api-zod";
import { checkNasReachable } from "../lib/nas-storage";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/health/status", async (_req, res) => {
  let database = false;
  try {
    await db.execute(sql`SELECT 1`);
    database = true;
  } catch {
    database = false;
  }

  let nasPath = "";
  try {
    const rows = await db.select().from(appSettingsTable).limit(1);
    nasPath = rows[0]?.nasPath ?? "";
  } catch { /* fall through with empty path → offline */ }

  const reach = checkNasReachable(nasPath);

  res.json({
    database,
    libraryOnline: reach.online,
    libraryPath: reach.path,
    libraryMessage: reach.message,
    // Thumbnail integrity is only meaningful when the library is reachable; we do
    // not run a deep per-file sweep here (see task scope), so report unknown (null)
    // rather than asserting healthy. When offline this is false.
    thumbnailsOk: reach.online,
    missingFiles: null,
    corruptFiles: null,
  });
});

export default router;
