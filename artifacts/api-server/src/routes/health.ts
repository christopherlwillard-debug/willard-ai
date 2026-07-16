import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db, appSettingsTable } from "@workspace/db";
import { HealthCheckResponse } from "@workspace/api-zod";
import { checkNasReachable } from "../lib/nas-storage";
import * as fs from "node:fs";
import * as path from "node:path";

// Cap the per-request disk sweep so health polling stays cheap on huge
// libraries; beyond this we report null (unknown) instead of a stale guess.
const INTEGRITY_SWEEP_LIMIT = 20000;

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

  // Integrity sweep: verify indexed (non-deleted) files still exist on disk.
  // Missing = row present but file gone; corrupt = file exists but is empty.
  // Only meaningful when the library is reachable; null = unknown.
  let missingFiles: number | null = null;
  let corruptFiles: number | null = null;
  if (reach.online && nasPath) {
    try {
      const { rows } = await db.execute(sql`
        SELECT relative_path, size_bytes FROM media_files
         WHERE nas_path = ${nasPath}
           AND last_scan_action IS DISTINCT FROM 'DELETED'
         LIMIT ${INTEGRITY_SWEEP_LIMIT + 1}
      `);
      if (rows.length <= INTEGRITY_SWEEP_LIMIT) {
        let missing = 0;
        let corrupt = 0;
        for (const row of rows as { relative_path: string; size_bytes: number }[]) {
          const abs = path.join(nasPath, row.relative_path);
          try {
            const st = fs.statSync(abs);
            if (st.size === 0 && Number(row.size_bytes) > 0) corrupt++;
          } catch {
            missing++;
          }
        }
        missingFiles = missing;
        corruptFiles = corrupt;
      }
    } catch { /* leave as null (unknown) */ }
  }

  res.json({
    database,
    libraryOnline: reach.online,
    libraryPath: reach.path,
    libraryMessage: reach.message,
    thumbnailsOk: reach.online,
    missingFiles,
    corruptFiles,
  });
});

export default router;
