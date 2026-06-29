import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { libraryJobsTable, appSettingsTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import {
  getActiveJobId, getJobProgress, startJob, requestPause, requestCancel, resumeJob,
} from "../lib/library-engine";

const router = Router();

async function getNasPath(): Promise<string | null> {
  const [row] = await db.select({ nasPath: appSettingsTable.nasPath }).from(appSettingsTable).limit(1);
  return row?.nasPath ?? null;
}

// ── POST /api/library/scan — start a scan job ────────────────────────────────

router.post("/library/scan", async (req: Request, res: Response) => {
  const nasPath = await getNasPath();
  if (!nasPath) {
    res.status(400).json({ error: "NAS path not configured. Visit Settings to configure it." });
    return;
  }

  const profile = (req.body?.profile as string) ?? "QUICK";
  const rootPath = req.body?.rootPath as string | undefined;

  const result = await startJob({
    jobType: "SCAN",
    profile: profile as any,
    nasPath,
    rootPath,
  });

  res.json(result);
});

// ── GET /api/library/jobs/active — live progress of the running job ───────────

router.get("/library/jobs/active", async (_req: Request, res: Response) => {
  const activeId = getActiveJobId();
  if (activeId === null) {
    res.json(null);
    return;
  }
  const progress = getJobProgress(activeId);
  res.json(progress);
});

// ── GET /api/library/jobs — paginated job history ────────────────────────────

router.get("/library/jobs", async (req: Request, res: Response) => {
  const nasPath = await getNasPath();
  const type    = req.query["type"] as string | undefined;
  const limit   = Math.min(100, parseInt(req.query["limit"] as string) || 20);

  const conditions = [];
  if (nasPath) conditions.push(eq(libraryJobsTable.nasPath, nasPath));
  if (type)    conditions.push(eq(libraryJobsTable.jobType, type));

  const jobs = await db.select().from(libraryJobsTable)
    .where(conditions.length === 1 ? conditions[0] : conditions.length > 1 ? and(...conditions) : undefined)
    .orderBy(desc(libraryJobsTable.createdAt))
    .limit(limit);

  res.json({ jobs });
});

// ── GET /api/library/jobs/:id — single job ────────────────────────────────────

router.get("/library/jobs/:id", async (req: Request, res: Response) => {
  const id = parseInt(req.params["id"] as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  // Check in-memory first for live progress
  const liveProgress = getJobProgress(id);
  if (liveProgress) { res.json({ ...liveProgress, fromMemory: true }); return; }

  const [job] = await db.select().from(libraryJobsTable)
    .where(eq(libraryJobsTable.id, id)).limit(1);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  res.json(job);
});

// ── POST /api/library/jobs/:id/pause ─────────────────────────────────────────

router.post("/library/jobs/:id/pause", async (req: Request, res: Response) => {
  const id = parseInt(req.params["id"] as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const ok = requestPause(id);
  res.json({ ok, jobId: id });
});

// ── POST /api/library/jobs/:id/resume ────────────────────────────────────────

router.post("/library/jobs/:id/resume", async (req: Request, res: Response) => {
  const id = parseInt(req.params["id"] as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const ok = await resumeJob(id);
  if (!ok) { res.status(400).json({ error: "Job not found or not paused" }); return; }
  res.json({ ok, jobId: id });
});

// ── POST /api/library/jobs/:id/cancel ────────────────────────────────────────

router.post("/library/jobs/:id/cancel", async (req: Request, res: Response) => {
  const id = parseInt(req.params["id"] as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const reason = req.body?.reason ?? "USER_CANCELLED";
  const ok = requestCancel(id, reason);
  res.json({ ok, jobId: id });
});

// ── POST /api/library/thumbnails — start a thumbnail backfill job ─────────────

router.post("/library/thumbnails", async (req: Request, res: Response) => {
  const nasPath = await getNasPath();
  if (!nasPath) {
    res.status(400).json({ error: "NAS path not configured." });
    return;
  }

  const result = await startJob({
    jobType: "THUMBNAILS",
    profile: "FULL",
    nasPath,
  });

  res.json(result);
});

export default router;
