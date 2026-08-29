import { Router } from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import { db, appSettingsTable, mediaFilesTable, mediaAiTable, libraryJobsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { generateThumbnail, getThumbnailDir, thumbnailFilename, isThumbnailFileValid } from "../lib/thumbnail-engine";
import { getWillardAIDir, resolveLibraryPath, resolveWithinRoot } from "../lib/nas-storage";
import { activeMediaCondition } from "../lib/media-scope.ts";
import { getActiveLibraryContext } from "../lib/active-library.ts";
import { purgeDerivedDataForMedia, purgeOrphanedDerivedData } from "../lib/derived-cleanup.ts";

const router = Router();
const ACTIVE = activeMediaCondition;

type HealthRow = {
  id: number;
  relativePath: string;
  thumbnailPath: string | null;
  mediaType: string;
  sizeBytes: number;
  lastScanAction: string | null;
};

type HealthReport = {
  checkedAt: string;
  libraryPath: string | null;
  status: "healthy" | "attention" | "action_required";
  issues: {
    missingFiles: number;
    orphanedIndexRecords: number;
    missingThumbnails: number;
    orphanedThumbnails: number;
    emptyFolders: number;
    brokenMetadataReferences: number;
    unusedCacheBytes: number;
    unusedCacheFiles: number;
  };
};

function walkDirectories(root: string, skip: string): { empty: string[]; files: string[] } {
  const empty: string[] = [];
  const files: string[] = [];
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const visible = entries.filter(e => e.name !== ".DS_Store");
    if (visible.length === 0) empty.push(dir);
    for (const entry of visible) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (path.resolve(full) !== path.resolve(skip)) visit(full);
      } else if (entry.isFile()) files.push(full);
    }
  };
  visit(root);
  return { empty, files };
}

function cacheInventory(nasPath: string): { orphaned: string[]; unused: string[]; unusedBytes: number } {
  const thumbDir = getThumbnailDir(nasPath);
  const cacheRoot = path.join(getWillardAIDir(nasPath), "cache");
  const result = { orphaned: [] as string[], unused: [] as string[], unusedBytes: 0 };
  const visit = (dir: string, isThumb: boolean) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full, isThumb || path.resolve(full) === path.resolve(thumbDir));
      else if (entry.isFile()) {
        if (isThumb) result.orphaned.push(full);
        else {
          result.unused.push(full);
          try { result.unusedBytes += fs.statSync(full).size; } catch { /* best effort */ }
        }
      }
    }
  };
  visit(cacheRoot, false);
  return result;
}

async function inspectLibrary(nasPath: string): Promise<{ report: HealthReport; rows: HealthRow[]; missing: HealthRow[]; missingThumbs: HealthRow[]; orphanThumbs: string[]; emptyFolders: string[] }> {
  const rows = await db.select({
    id: mediaFilesTable.id,
    relativePath: mediaFilesTable.relativePath,
    thumbnailPath: mediaFilesTable.thumbnailPath,
    mediaType: mediaFilesTable.mediaType,
    sizeBytes: mediaFilesTable.sizeBytes,
    lastScanAction: mediaFilesTable.lastScanAction,
  }).from(mediaFilesTable).where(and(eq(mediaFilesTable.nasPath, nasPath), ACTIVE));

  const missing: HealthRow[] = [];
  const missingThumbs: HealthRow[] = [];
  const validIds = new Set<number>();
  for (const row of rows) {
    validIds.add(row.id);
    try {
      const source = resolveLibraryPath(nasPath, row.relativePath);
      if (!fs.existsSync(source)) missing.push(row);
    } catch {
      missing.push(row);
    }
    const needsThumb = row.mediaType === "photo" || row.mediaType === "video";
    if (needsThumb) {
      try {
        const thumb = row.thumbnailPath
          ? resolveWithinRoot(row.thumbnailPath, getWillardAIDir(nasPath))
          : path.join(getThumbnailDir(nasPath), thumbnailFilename(row.id));
        if (!isThumbnailFileValid(thumb)) missingThumbs.push(row);
      } catch { missingThumbs.push(row); }
    }
  }

  const cache = cacheInventory(nasPath);
  const orphanThumbs = cache.orphaned.filter(file => {
    const id = Number(path.basename(file, path.extname(file)));
    return path.extname(file).toLowerCase() === ".webp" && (!Number.isInteger(id) || !validIds.has(id));
  });
  const folders = walkDirectories(nasPath, getWillardAIDir(nasPath));
  const [metadataRows, orphanFaceRows, orphanStateRows] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` })
    .from(mediaAiTable)
    .leftJoin(mediaFilesTable, eq(mediaAiTable.mediaFileId, mediaFilesTable.id))
    .where(sql`${mediaFilesTable.id} IS NULL`),
    db.execute(sql`
      SELECT count(*)::int AS count
        FROM faces fc
       WHERE NOT EXISTS (SELECT 1 FROM media_files mf WHERE mf.id = fc.media_file_id)
    `),
    db.execute(sql`
      SELECT count(*)::int AS count
        FROM face_scan_state s
       WHERE NOT EXISTS (SELECT 1 FROM media_files mf WHERE mf.id = s.media_file_id)
    `),
  ]);
  const orphanedDerivedRows =
    Number(metadataRows?.[0]?.count ?? 0) +
    Number((orphanFaceRows.rows[0] as { count?: number | string } | undefined)?.count ?? 0) +
    Number((orphanStateRows.rows[0] as { count?: number | string } | undefined)?.count ?? 0);

  const issues = {
    missingFiles: missing.length,
    orphanedIndexRecords: missing.length,
    missingThumbnails: missingThumbs.length,
    orphanedThumbnails: orphanThumbs.length,
    emptyFolders: folders.empty.filter(dir => path.resolve(dir) !== path.resolve(nasPath)).length,
    brokenMetadataReferences: orphanedDerivedRows,
    unusedCacheBytes: cache.unusedBytes,
    unusedCacheFiles: cache.unused.length,
  };
  const total = Object.values(issues).some(value => value > 0);
  const severe = issues.missingFiles > 0 || issues.orphanedIndexRecords > 0 || issues.brokenMetadataReferences > 0;
  return {
    report: {
      checkedAt: new Date().toISOString(),
      libraryPath: nasPath,
      status: severe ? "action_required" : total ? "attention" : "healthy",
      issues,
    },
    rows, missing, missingThumbs, orphanThumbs, emptyFolders: folders.empty,
  };
}

router.get("/media/health", async (_req, res) => {
  try {
    const library = await getActiveLibraryContext();
    if (!library) return res.json({
      checkedAt: new Date().toISOString(), libraryPath: null, libraryKey: null, indexedFiles: 0, status: "attention",
      issues: { missingFiles: 0, orphanedIndexRecords: 0, missingThumbnails: 0, orphanedThumbnails: 0, emptyFolders: 0, brokenMetadataReferences: 0, unusedCacheBytes: 0, unusedCacheFiles: 0 },
      error: "No library is configured",
    });
    const inspected = await inspectLibrary(library.nasPath);
    return res.json({ ...inspected.report, libraryKey: library.libraryKey, indexedFiles: inspected.rows.length });
  } catch { return res.status(500).json({ error: "Health scan failed" }); }
});

router.post("/media/cleanup", async (req, res) => {
  const requested = Array.isArray(req.body?.actions) ? req.body.actions : [];
  const allowed = new Set(["orphanedRecords", "orphanedDerivedData", "orphanedThumbnails", "missingThumbnails", "emptyFolders", "rebuildMetadata", "fullThumbnailRebuild"]);
  const actions = requested.filter((action: unknown): action is string => typeof action === "string" && allowed.has(action));
  const nasPath = (await getActiveLibraryContext())?.nasPath ?? null;
  if (!nasPath) return res.status(409).json({ error: "No library is configured" });

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const [job] = await db.insert(libraryJobsTable).values({
    jobType: "HEALTH_CLEANUP", profile: "HEALTH", priority: "HIGH", status: "RUNNING", nasPath,
  }).returning({ id: libraryJobsTable.id });
  try {
    const inspected = await inspectLibrary(nasPath);
    let done = 0;
    const total = Math.max(1, inspected.missing.length + inspected.orphanThumbs.length + inspected.missingThumbs.length + inspected.emptyFolders.length);
    const progress = (message: string) => send("progress", { processed: done, total, message });
    let derivedCleanup: Record<string, unknown> | undefined;

    if (actions.includes("orphanedRecords")) {
      for (const row of inspected.missing) {
        await purgeDerivedDataForMedia(nasPath, [row.id]);
        await db.delete(mediaFilesTable).where(and(eq(mediaFilesTable.id, row.id), eq(mediaFilesTable.nasPath, nasPath)));
        done++; progress("Removing orphaned index records…");
      }
    }
    if (actions.includes("orphanedDerivedData")) {
      const cleaned = await purgeOrphanedDerivedData(nasPath);
      done += cleaned.orphanRows + cleaned.staleCropsRemoved;
      derivedCleanup = {
        orphanRows: cleaned.orphanRows,
        staleCropsRemoved: cleaned.staleCropsRemoved,
        peopleRows: cleaned.peopleRows,
        cropErrors: cleaned.cropErrors.length,
      };
      progress(`Removed ${cleaned.orphanRows} orphaned derived rows and ${cleaned.staleCropsRemoved} stale face crops…`);
    }
    if (actions.includes("orphanedThumbnails")) {
      for (const file of inspected.orphanThumbs) {
        try { fs.unlinkSync(resolveWithinRoot(file, getWillardAIDir(nasPath))); } catch { /* stale or already gone */ }
        done++; progress("Removing orphaned thumbnails…");
      }
    }
    if (actions.includes("missingThumbnails") || actions.includes("fullThumbnailRebuild")) {
      const targets = actions.includes("fullThumbnailRebuild") ? inspected.rows : inspected.missingThumbs;
      for (const row of targets) {
        if (row.mediaType !== "photo" && row.mediaType !== "video") continue;
        try {
          const source = resolveLibraryPath(nasPath, row.relativePath);
          await generateThumbnail(row.id, source, path.extname(row.relativePath).slice(1), nasPath);
        } catch { /* reported by the next health scan */ }
        done++; progress("Regenerating thumbnails…");
      }
    }
    if (actions.includes("emptyFolders")) {
      for (const folder of inspected.emptyFolders) {
        if (path.resolve(folder) === path.resolve(nasPath) || path.resolve(folder).startsWith(path.resolve(getWillardAIDir(nasPath)) + path.sep)) continue;
        try { fs.rmdirSync(resolveWithinRoot(folder, nasPath)); } catch { /* changed since scan */ }
        done++; progress("Removing empty folders…");
      }
    }
    if (actions.includes("rebuildMetadata")) send("progress", { processed: done, total, message: "Metadata rebuild is queued for the next library scan." });
    await db.update(libraryJobsTable).set({
      status: "DONE",
      processedFiles: done,
      totalFiles: total,
      finishedAt: new Date(),
      summary: { actions, ...(derivedCleanup ? { derivedCleanup } : {}) },
    }).where(eq(libraryJobsTable.id, job.id));
    send("done", { ok: true, processed: done, total });
  } catch (error) {
    await db.update(libraryJobsTable).set({ status: "FAILED", error: String(error), finishedAt: new Date() }).where(eq(libraryJobsTable.id, job.id));
    send("error", { message: "Cleanup failed safely; original media was not removed." });
  } finally { return res.end(); }
});

export default router;