import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { libraryJobsTable, appSettingsTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { redactOperationalData } from "../lib/log-redaction.ts";
import { getStoragePolicyStatus } from "../lib/storage-policy.ts";
import { checkNasReachableAsync } from "../lib/nas-storage.ts";

const router = Router();

async function getNasPath(): Promise<string | null> {
  const [row] = await db.select({ nasPath: appSettingsTable.nasPath }).from(appSettingsTable).limit(1);
  return row?.nasPath ?? null;
}

// ── GET /api/diagnostics/scans — last 20 completed scan records with metrics ──

router.get("/diagnostics/scans", async (_req: Request, res: Response) => {
  const nasPath = await getNasPath();

  const conditions = [
    eq(libraryJobsTable.jobType, "SCAN"),
    eq(libraryJobsTable.status, "DONE"),
  ];
  if (nasPath) conditions.push(eq(libraryJobsTable.nasPath, nasPath));

  const jobs = await db.select({
    id:             libraryJobsTable.id,
    profile:        libraryJobsTable.profile,
    status:         libraryJobsTable.status,
    startedAt:      libraryJobsTable.startedAt,
    finishedAt:     libraryJobsTable.finishedAt,
    processedFiles: libraryJobsTable.processedFiles,
    totalFiles:     libraryJobsTable.totalFiles,
    summary:        libraryJobsTable.summary,
    diagnostics:    libraryJobsTable.diagnostics,
  }).from(libraryJobsTable)
    .where(and(...conditions))
    .orderBy(desc(libraryJobsTable.createdAt))
    .limit(20);

  // Diagnostics is an export surface. Preserve metrics and lifecycle state,
  // but never send stored paths, hashes, filenames, OCR, or free-form reports
  // back to a client by default.
  res.json({ scans: redactOperationalData(jobs) });
});

// Storage policy is deliberately a separate diagnostics surface as well as a
// health field: operators can inspect capacity and classification without
// receiving the configured library path or other sensitive filenames.
router.get("/diagnostics/storage-policy", async (_req: Request, res: Response) => {
  try {
    const [settings] = await db
      .select({ nasPath: appSettingsTable.nasPath })
      .from(appSettingsTable)
      .limit(1);
    const nasPath = settings?.nasPath?.trim() || null;
    const reach = await checkNasReachableAsync(nasPath);
    const policy = await getStoragePolicyStatus(nasPath, reach);
    res.json(policy);
  } catch {
    res.status(500).json({ error: "Storage policy diagnostics unavailable" });
  }
});

export default router;
