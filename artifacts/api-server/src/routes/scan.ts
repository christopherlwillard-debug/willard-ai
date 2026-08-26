/**
 * Compatibility adapter for the original scan endpoints.
 *
 * These URLs remain available for older clients and saved bookmarks, but they
 * no longer own a scanner or write to scan_jobs. Every request is translated
 * to the durable library-engine job model in library_jobs.
 *
 * New code should use:
 *   POST /api/library/scan
 *   GET  /api/library/jobs/active
 *   GET  /api/diagnostics/scans
 */
import { Router, type Request, type Response } from "express";
import { db, appSettingsTable, libraryJobsTable } from "@workspace/db";
import { and, desc, eq, or } from "drizzle-orm";
import {
  getActiveJobId,
  getJobProgress,
  startJob,
  type JobProfile,
} from "../lib/library-engine";

const router = Router();

type DurableJob = typeof libraryJobsTable.$inferSelect;

function markDeprecated(res: Response): void {
  res.setHeader("Deprecation", "true");
  res.setHeader("Link", '</api/library/scan>; rel="successor-version"');
}

async function getNasPath(): Promise<string | null> {
  const [settings] = await db
    .select({ nasPath: appSettingsTable.nasPath })
    .from(appSettingsTable)
    .limit(1);
  const nasPath = settings?.nasPath?.trim();
  return nasPath || null;
}

function legacyStatus(status: string): "running" | "completed" | "failed" | "idle" {
  if (status === "RUNNING") return "running";
  if (status === "DONE") return "completed";
  if (status === "FAILED") return "failed";
  return "idle";
}

function legacyStage(status: string, phase?: string | null): string {
  if (status === "DONE") return "Complete";
  if (status === "FAILED") return "Failed";
  if (status === "PAUSED") return "Paused";
  if (status === "INTERRUPTED_BY_RESTART") return "Interrupted";
  if (phase) return phase.replaceAll("_", " ");
  return "Starting";
}

function toLegacyJob(
  job: DurableJob,
  progress?: {
    phase?: string | null;
    filesProcessed?: number;
    filesTotal?: number;
  } | null,
) {
  return {
    id: job.id,
    status: legacyStatus(job.status),
    filesScanned: progress?.filesProcessed ?? job.processedFiles ?? 0,
    totalFiles: progress?.filesTotal ?? job.totalFiles ?? null,
    stage: legacyStage(job.status, progress?.phase),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    error: job.error ?? null,
  };
}

async function getJob(id: number, nasPath: string): Promise<DurableJob | null> {
  const [job] = await db
    .select()
    .from(libraryJobsTable)
    .where(and(
      eq(libraryJobsTable.id, id),
      eq(libraryJobsTable.jobType, "SCAN"),
      eq(libraryJobsTable.nasPath, nasPath),
    ))
    .limit(1);
  return job ?? null;
}

async function getRecentScanJobs(nasPath: string | null): Promise<DurableJob[]> {
  const conditions = [eq(libraryJobsTable.jobType, "SCAN")];
  if (nasPath) conditions.push(eq(libraryJobsTable.nasPath, nasPath));
  return db
    .select()
    .from(libraryJobsTable)
    .where(and(...conditions))
    .orderBy(desc(libraryJobsTable.createdAt), desc(libraryJobsTable.id))
    .limit(20);
}

function requestedProfile(body: unknown): JobProfile {
  const profile = (body as { profile?: unknown } | null)?.profile;
  if (profile === "QUICK" || profile === "FULL" || profile === "HEALTH_SCAN") {
    return profile;
  }
  // The old endpoint always performed a complete scan, so preserve that
  // behavior for clients that POST an empty body.
  return "FULL";
}

router.post("/scan", async (req: Request, res: Response) => {
  markDeprecated(res);
  const nasPath = await getNasPath();
  if (!nasPath) {
    res.status(400).json({ error: "NAS path not configured. Visit Settings to configure it." });
    return;
  }

  try {
    const result = await startJob({
      jobType: "SCAN",
      profile: requestedProfile(req.body),
      nasPath,
    });
    const job = await getJob(result.jobId, nasPath);
    if (!job) {
      res.status(500).json({ error: "Scan job was created but could not be read back." });
      return;
    }

    if (result.errorCode === "NAS_OFFLINE") {
      res.status(503).json(toLegacyJob(job));
      return;
    }

    const progress = result.alreadyRunning ? getJobProgress(result.jobId) : null;
    res.status(202).json(toLegacyJob(job, progress));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Failed to start scan";
    res.status(500).json({ error: detail });
  }
});

router.get("/scan/status", async (_req: Request, res: Response) => {
  markDeprecated(res);
  try {
    const nasPath = await getNasPath();
    const recent = await getRecentScanJobs(nasPath);
    let current: ReturnType<typeof toLegacyJob> | null = null;

    if (nasPath) {
      const activeId = getActiveJobId(nasPath);
      if (activeId !== null) {
        const job = await getJob(activeId, nasPath);
        if (job) current = toLegacyJob(job, getJobProgress(activeId));
      }

      // A second API process may own the worker. The durable row remains the
      // source of truth when no local in-memory progress is available.
      if (!current) {
        const durableActive = recent.find(job =>
          job.status === "RUNNING" || job.status === "PENDING",
        );
        if (durableActive) current = toLegacyJob(durableActive);
      }
    }

    const lastCompleted = recent.find(job => job.status === "DONE");
    const lastFailed = recent.find(job => job.status === "FAILED");
    res.json({
      isRunning: current?.status === "running",
      current,
      lastCompleted: lastCompleted ? toLegacyJob(lastCompleted) : null,
      lastFailed: lastFailed ? toLegacyJob(lastFailed) : null,
    });
  } catch {
    res.status(500).json({ error: "Failed to get scan status" });
  }
});

router.get("/scan/history", async (_req: Request, res: Response) => {
  markDeprecated(res);
  try {
    const nasPath = await getNasPath();
    const jobs = await getRecentScanJobs(nasPath);
    res.json(jobs.map(job => toLegacyJob(job)));
  } catch {
    res.status(500).json({ error: "Failed to get scan history" });
  }
});

export default router;