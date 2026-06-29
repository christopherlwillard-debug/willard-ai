import { Router, type Request, type Response } from "express";
import * as fs from "fs";
import * as path from "path";
import { db } from "@workspace/db";
import { mediaFilesTable, mediaScanJobsTable, appSettingsTable } from "@workspace/db";
import { eq, and, like, desc, asc, sql, count } from "drizzle-orm";
import { runMediaScan, getActiveScanJobId } from "../lib/media-scanner";
import { generateThumbnail, getThumbnailDir, thumbnailFilename } from "../lib/thumbnail-engine";

const router = Router();

// ── Helper: get NAS path ──────────────────────────────────────────────────────

async function getNasPath(): Promise<string | null> {
  const [row] = await db.select({ nasPath: appSettingsTable.nasPath }).from(appSettingsTable).limit(1);
  return row?.nasPath ?? null;
}

// ── POST /api/media/scan — start a new scan ───────────────────────────────────

router.post("/media/scan", async (req: Request, res: Response) => {
  const nasPath = await getNasPath();
  if (!nasPath) {
    res.status(400).json({ error: "NAS path not configured. Visit Settings to configure it." });
    return;
  }
  if (!fs.existsSync(nasPath)) {
    res.status(400).json({ error: "NAS path is not accessible." });
    return;
  }

  const existingId = getActiveScanJobId();
  if (existingId !== null) {
    res.json({ jobId: existingId, alreadyRunning: true });
    return;
  }

  const jobId = await runMediaScan(nasPath);
  res.json({ jobId, alreadyRunning: false });
});

// ── GET /api/media/scan/status — latest scan job status ──────────────────────

router.get("/media/scan/status", async (_req: Request, res: Response) => {
  const activeId = getActiveScanJobId();

  if (activeId !== null) {
    const [job] = await db
      .select()
      .from(mediaScanJobsTable)
      .where(eq(mediaScanJobsTable.id, activeId))
      .limit(1);
    if (job) {
      res.json(job);
      return;
    }
  }

  // Return most recent completed job
  const [job] = await db
    .select()
    .from(mediaScanJobsTable)
    .orderBy(desc(mediaScanJobsTable.startedAt))
    .limit(1);

  if (!job) {
    res.json(null);
    return;
  }
  res.json(job);
});

// ── GET /api/media/files — paginated, filtered file listing ──────────────────

router.get("/media/files", async (req: Request, res: Response) => {
  const nasPath = await getNasPath();
  if (!nasPath) {
    res.json({ files: [], total: 0 });
    return;
  }

  const mediaType = req.query["mediaType"] as string | undefined;
  const folder    = req.query["folder"]    as string | undefined;
  const search    = req.query["search"]    as string | undefined;
  const sort      = (req.query["sort"]     as string) || "indexed_desc";
  const page      = Math.max(1, parseInt(req.query["page"] as string) || 1);
  const limit     = Math.min(200, Math.max(1, parseInt(req.query["limit"] as string) || 60));
  const offset    = (page - 1) * limit;

  const conditions = [eq(mediaFilesTable.nasPath, nasPath)];
  if (mediaType && mediaType !== "all") {
    conditions.push(eq(mediaFilesTable.mediaType, mediaType));
  }
  if (folder) {
    const prefix = folder.endsWith("/") ? folder : folder + "/";
    conditions.push(
      sql`(${mediaFilesTable.relativePath} = ${folder} OR ${mediaFilesTable.relativePath} LIKE ${prefix + "%"})`
    );
  }
  if (search) {
    conditions.push(like(mediaFilesTable.name, `%${search}%`));
  }

  const where = conditions.length === 1 ? conditions[0] : and(...conditions);

  const [totalRow] = await db
    .select({ total: count() })
    .from(mediaFilesTable)
    .where(where);
  const total = Number(totalRow?.total ?? 0);

  let orderBy;
  switch (sort) {
    case "name_asc":      orderBy = asc(mediaFilesTable.name);        break;
    case "name_desc":     orderBy = desc(mediaFilesTable.name);       break;
    case "size_asc":      orderBy = asc(mediaFilesTable.sizeBytes);   break;
    case "size_desc":     orderBy = desc(mediaFilesTable.sizeBytes);  break;
    case "modified_asc":  orderBy = asc(mediaFilesTable.modifiedAt);  break;
    case "modified_desc": orderBy = desc(mediaFilesTable.modifiedAt); break;
    default:              orderBy = desc(mediaFilesTable.indexedAt);  break;
  }

  const files = await db
    .select()
    .from(mediaFilesTable)
    .where(where)
    .orderBy(orderBy)
    .limit(limit)
    .offset(offset);

  res.json({ files, total, page, limit });
});

// ── GET /api/media/folders — unique top-level folder list ────────────────────

router.get("/media/folders", async (_req: Request, res: Response) => {
  const nasPath = await getNasPath();
  if (!nasPath) {
    res.json({ folders: [] });
    return;
  }

  const rows = await db
    .selectDistinct({ relativePath: mediaFilesTable.relativePath })
    .from(mediaFilesTable)
    .where(eq(mediaFilesTable.nasPath, nasPath));

  // Extract unique top-level folders from relative paths
  const folderSet = new Set<string>();
  for (const row of rows) {
    const parts = row.relativePath.split("/");
    if (parts.length > 1) {
      folderSet.add(parts[0]);
    }
  }

  res.json({ folders: Array.from(folderSet).sort() });
});

// ── GET /api/media/thumbnail/:id — serve or generate thumbnail ───────────────

router.get("/media/thumbnail/:id", async (req: Request, res: Response) => {
  const id = parseInt(req.params["id"] as string);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const nasPath = await getNasPath();
  if (!nasPath) {
    res.status(404).json({ error: "NAS not configured" });
    return;
  }

  const [file] = await db
    .select()
    .from(mediaFilesTable)
    .where(eq(mediaFilesTable.id, id))
    .limit(1);

  if (!file) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  // Check for existing thumbnail
  if (file.thumbnailPath && fs.existsSync(file.thumbnailPath)) {
    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Cache-Control", "public, max-age=86400");
    fs.createReadStream(file.thumbnailPath).pipe(res);
    return;
  }

  // Check by id-based filename in thumbdir (fast path without DB query)
  const thumbDir = getThumbnailDir(nasPath);
  const thumbFile = path.join(thumbDir, thumbnailFilename(id));
  if (fs.existsSync(thumbFile)) {
    // Update DB record with this path
    await db.update(mediaFilesTable)
      .set({ thumbnailPath: thumbFile, thumbnailGeneratedAt: new Date() })
      .where(eq(mediaFilesTable.id, id));
    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Cache-Control", "public, max-age=86400");
    fs.createReadStream(thumbFile).pipe(res);
    return;
  }

  // Generate on-demand
  const sourcePath = path.join(nasPath, file.relativePath);
  if (!fs.existsSync(sourcePath)) {
    res.status(404).json({ error: "Source file not found on NAS" });
    return;
  }

  const result = await generateThumbnail(id, sourcePath, file.extension, nasPath);
  if (result.error || !result.destPath || !fs.existsSync(result.destPath)) {
    res.status(500).json({ error: result.error ?? "Thumbnail generation failed" });
    return;
  }

  // Persist thumbnail path to DB
  await db.update(mediaFilesTable)
    .set({ thumbnailPath: result.destPath, thumbnailGeneratedAt: new Date() })
    .where(eq(mediaFilesTable.id, id));

  res.setHeader("Content-Type", "image/webp");
  res.setHeader("Cache-Control", "public, max-age=86400");
  fs.createReadStream(result.destPath).pipe(res);
});

// ── GET /api/media/file/:id/stream — stream original file ────────────────────

router.get("/media/file/:id/stream", async (req: Request, res: Response) => {
  const id = parseInt(req.params["id"] as string);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const nasPath = await getNasPath();
  if (!nasPath) {
    res.status(404).json({ error: "NAS not configured" });
    return;
  }

  const [file] = await db
    .select()
    .from(mediaFilesTable)
    .where(eq(mediaFilesTable.id, id))
    .limit(1);

  if (!file) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  const sourcePath = path.join(nasPath, file.relativePath);
  if (!fs.existsSync(sourcePath)) {
    res.status(404).json({ error: "Source file not found on NAS" });
    return;
  }

  const stat = fs.statSync(sourcePath);
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end   = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunkSize = end - start + 1;

    res.status(206);
    res.setHeader("Content-Range",  `bytes ${start}-${end}/${stat.size}`);
    res.setHeader("Accept-Ranges",  "bytes");
    res.setHeader("Content-Length", chunkSize);
    res.setHeader("Content-Type",   file.mimeType || "application/octet-stream");
    fs.createReadStream(sourcePath, { start, end }).pipe(res);
  } else {
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Type",   file.mimeType || "application/octet-stream");
    res.setHeader("Accept-Ranges",  "bytes");
    fs.createReadStream(sourcePath).pipe(res);
  }
});

export default router;
