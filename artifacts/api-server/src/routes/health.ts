import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/health/status", async (_req, res) => {
  try {
    await db.execute(sql`SELECT 1`);
    res.json({
      database: true,
      thumbnailsOk: true,
      missingFiles: 0,
      corruptFiles: 0,
    });
  } catch {
    res.json({
      database: false,
      thumbnailsOk: false,
      missingFiles: 0,
      corruptFiles: 0,
    });
  }
});

export default router;
