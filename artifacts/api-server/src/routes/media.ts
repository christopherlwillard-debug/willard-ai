import { Router, type Request, type Response } from "express";
import * as fs from "fs";
import * as path from "path";
import { db } from "@workspace/db";
import { mediaFilesTable, appSettingsTable, mediaTagsTable, mediaFileTagsTable } from "@workspace/db";
import { eq, and, like, desc, asc, sql, count, isNotNull, inArray } from "drizzle-orm";
import { generateThumbnail, getThumbnailDir, thumbnailFilename, isThumbnailFileValid } from "../lib/thumbnail-engine";
import { getWillardAIDir, resolveLibraryPath, resolveWithinRoot } from "../lib/nas-storage";
import { activeMediaCondition } from "../lib/media-scope.ts";
import { purgeDerivedDataForMedia } from "../lib/derived-cleanup.ts";
import { parseBoundedInteger, RequestValidationError } from "../lib/request-validation.ts";
import { parseSingleByteRange, sendRangeNotSatisfiable, streamFileWithErrorHandling } from "../lib/media-range.ts";

const router = Router();

// ── NAS path cache ────────────────────────────────────────────────────────────
// The NAS path never changes during a session; cache it so every thumbnail
// request does not hit the database just to read the same row.

let _nasPathCached: string | null | undefined = undefined;
let _nasPathCachedAt = 0;
const NAS_PATH_TTL_MS = 60_000;
const ACTIVE_MEDIA = activeMediaCondition;

async function getNasPath(): Promise<string | null> {
  const now = Date.now();
  if (_nasPathCached !== undefined && now - _nasPathCachedAt < NAS_PATH_TTL_MS) {
    return _nasPathCached;
  }
  const [row] = await db.select({ nasPath: appSettingsTable.nasPath }).from(appSettingsTable).limit(1);
  _nasPathCached = row?.nasPath ?? null;
  _nasPathCachedAt = now;
  return _nasPathCached;
}

export function invalidateNasPathCache(): void {
  _nasPathCached = undefined;
}

function normalizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLocaleLowerCase())
    .filter((value) => value.length > 0 && value.length <= 64))]
    .slice(0, 50);
}

async function addTagsToFiles<T extends { id: number }>(files: T[], nasPath: string) {
  if (files.length === 0) return files.map((file) => ({ ...file, tags: [] as string[] }));
  const rows = await db
    .select({ mediaFileId: mediaFileTagsTable.mediaFileId, name: mediaTagsTable.name })
    .from(mediaFileTagsTable)
    .innerJoin(mediaTagsTable, eq(mediaTagsTable.id, mediaFileTagsTable.tagId))
    .where(and(
      eq(mediaTagsTable.nasPath, nasPath),
      inArray(mediaFileTagsTable.mediaFileId, files.map((file) => file.id)),
    ));
  const byFile = new Map<number, string[]>();
  for (const row of rows) byFile.set(row.mediaFileId, [...(byFile.get(row.mediaFileId) ?? []), row.name]);
  return files.map((file) => ({ ...file, tags: byFile.get(file.id) ?? [] }));
}

// ── GET /api/media/tags — tags in the active library, with active-file counts ──
router.get("/media/tags", async (_req: Request, res: Response) => {
  const nasPath = await getNasPath();
  if (!nasPath) { res.json({ tags: [] }); return; }
  const rows = await db
    .select({ id: mediaTagsTable.id, name: mediaTagsTable.name, count: count(mediaFileTagsTable.mediaFileId) })
    .from(mediaTagsTable)
    .leftJoin(mediaFileTagsTable, eq(mediaTagsTable.id, mediaFileTagsTable.tagId))
    .leftJoin(mediaFilesTable, and(
      eq(mediaFilesTable.id, mediaFileTagsTable.mediaFileId),
      eq(mediaFilesTable.nasPath, nasPath),
      ACTIVE_MEDIA,
    ))
    .where(eq(mediaTagsTable.nasPath, nasPath))
    .groupBy(mediaTagsTable.id, mediaTagsTable.name)
    .orderBy(asc(mediaTagsTable.name));
  res.json({ tags: rows.map((row) => ({ ...row, count: Number(row.count) })) });
});

// ── Thumbnail path in-memory cache ────────────────────────────────────────────
// Maps file id → confirmed absolute path on disk.
// Populated at startup via warmThumbnailCache() and on every successful serve.
// Eliminates the DB query + NAS fs.existsSync() on every subsequent request.

const _thumbCache = new Map<number, { nasPath: string; path: string }>();

export async function warmThumbnailCache(): Promise<void> {
  try {
    const nasPath = await getNasPath();
    if (!nasPath) return;
    const rows = await db
      .select({ id: mediaFilesTable.id, thumbnailPath: mediaFilesTable.thumbnailPath })
      .from(mediaFilesTable)
      .where(and(eq(mediaFilesTable.nasPath, nasPath), ACTIVE_MEDIA, isNotNull(mediaFilesTable.thumbnailPath)));
    for (const row of rows) {
      if (!row.thumbnailPath) continue;
      try {
        const thumbPath = resolveWithinRoot(row.thumbnailPath, getWillardAIDir(nasPath));
        if (isThumbnailFileValid(thumbPath)) _thumbCache.set(row.id, { nasPath, path: thumbPath });
      } catch {
        // A stale or poisoned thumbnail path is ignored and regenerated on demand.
      }
    }
    console.log(`[thumbnail-cache] Warmed with ${_thumbCache.size} entries`);
  } catch (err) {
    console.warn("[thumbnail-cache] Warm-up failed (non-fatal):", err);
  }
}

// ── GET /api/media/files — paginated, filtered file listing ──────────────────

router.get("/media/files", async (req: Request, res: Response) => {
  let page: number;
  let limit: number;
  try {
    page = parseBoundedInteger(req.query["page"], { name: "page", min: 1, max: 10_000_000, defaultValue: 1 });
    limit = parseBoundedInteger(req.query["limit"], { name: "limit", min: 1, max: 200, defaultValue: 60 });
  } catch (error) {
    if (error instanceof RequestValidationError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    throw error;
  }

  const nasPath = await getNasPath();
  if (!nasPath) {
    res.json({ files: [], total: 0 });
    return;
  }

  const mediaType = req.query["mediaType"] as string | undefined;
  const favorites = req.query["favorites"] as string | undefined;
  const folder    = req.query["folder"]    as string | undefined;
  const search    = req.query["search"]    as string | undefined;
  const tags = normalizeTags(typeof req.query["tags"] === "string" ? (req.query["tags"] as string).split(",") : req.query["tags"]);
  const sort      = (req.query["sort"]     as string) || "indexed_desc";
  const offset    = (page - 1) * limit;

  const conditions = [eq(mediaFilesTable.nasPath, nasPath), ACTIVE_MEDIA];
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
  if (favorites === "true") {
    conditions.push(eq(mediaFilesTable.favorite, true));
  }
  for (const tag of tags) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM media_file_tags mft
      INNER JOIN media_tags mt ON mt.id = mft.tag_id
      WHERE mft.media_file_id = ${mediaFilesTable.id}
        AND mt.nas_path = ${nasPath}
        AND mt.name = ${tag}
    )`);
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

  res.json({ files: await addTagsToFiles(files, nasPath), total, page, limit });
});

// ── PUT /api/media/files/:id/tags — replace a file's user tags ────────────────
router.put("/media/files/:id/tags", async (req: Request, res: Response) => {
  const id = parseInt(req.params["id"] as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const nasPath = await getNasPath();
  if (!nasPath) { res.status(409).json({ error: "No library configured" }); return; }
  const [file] = await db.select({ id: mediaFilesTable.id })
    .from(mediaFilesTable)
    .where(and(eq(mediaFilesTable.id, id), eq(mediaFilesTable.nasPath, nasPath), ACTIVE_MEDIA))
    .limit(1);
  if (!file) { res.status(404).json({ error: "File not found" }); return; }
  const tags = normalizeTags(req.body?.tags);
  await db.transaction(async (tx) => {
    await tx.delete(mediaFileTagsTable).where(eq(mediaFileTagsTable.mediaFileId, id));
    if (tags.length === 0) return;
    const tagRows = await Promise.all(tags.map(async (name) => {
      const [row] = await tx.insert(mediaTagsTable)
        .values({ nasPath, name })
        .onConflictDoNothing({ target: [mediaTagsTable.nasPath, mediaTagsTable.name] })
        .returning({ id: mediaTagsTable.id });
      if (row) return row;
      const [existing] = await tx.select({ id: mediaTagsTable.id }).from(mediaTagsTable)
        .where(and(eq(mediaTagsTable.nasPath, nasPath), eq(mediaTagsTable.name, name))).limit(1);
      return existing;
    }));
    await tx.insert(mediaFileTagsTable).values(tagRows.filter((row): row is { id: number } => !!row).map((row) => ({ mediaFileId: id, tagId: row.id })));
  });
  res.json({ id, tags });
});

// ── GET /api/media/folders — hierarchical folder tree ────────────────────────

interface FolderNode {
  name: string;
  path: string;
  children: FolderNode[];
}

function buildFolderTree(folderPaths: string[]): FolderNode[] {
  const nodeMap = new Map<string, FolderNode>();
  const roots: FolderNode[] = [];

  for (const fp of [...folderPaths].sort()) {
    const parts = fp.split("/");
    let parentList = roots;

    for (let depth = 1; depth <= parts.length; depth++) {
      const currentPath = parts.slice(0, depth).join("/");
      if (!nodeMap.has(currentPath)) {
        const node: FolderNode = { name: parts[depth - 1], path: currentPath, children: [] };
        nodeMap.set(currentPath, node);
        parentList.push(node);
      }
      parentList = nodeMap.get(currentPath)!.children;
    }
  }

  return roots;
}

router.get("/media/folders", async (_req: Request, res: Response) => {
  const nasPath = await getNasPath();
  if (!nasPath) {
    res.json({ tree: [] });
    return;
  }

  const rows = await db
    .selectDistinct({ relativePath: mediaFilesTable.relativePath })
    .from(mediaFilesTable)
    .where(and(eq(mediaFilesTable.nasPath, nasPath), activeMediaCondition));

  // Collect all unique ancestor folder paths (strip filename from each relative path)
  const folderSet = new Set<string>();
  for (const row of rows) {
    const parts = row.relativePath.split("/");
    // Each path like "a/b/c/file.jpg" → folders "a", "a/b", "a/b/c"
    for (let i = 1; i < parts.length; i++) {
      folderSet.add(parts.slice(0, i).join("/"));
    }
  }

  const tree = buildFolderTree(Array.from(folderSet));
  res.json({ tree });
});

// ── POST /api/media/files/:id/favorite — toggle favorite flag ────────────────

router.post("/media/files/:id/favorite", async (req: Request, res: Response) => {
  const id = parseInt(req.params["id"] as string);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const favorite = req.body?.favorite === true;

  const [updated] = await db
    .update(mediaFilesTable)
    .set({ favorite, favoritedAt: favorite ? new Date() : null })
    .where(and(eq(mediaFilesTable.id, id), eq(mediaFilesTable.nasPath, await getNasPath() ?? ""), ACTIVE_MEDIA))
    .returning({ id: mediaFilesTable.id, favorite: mediaFilesTable.favorite });

  if (!updated) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  res.json(updated);
});

// ── DELETE /api/media/files/:id — soft-delete from library ──────────────────

router.delete("/media/files/:id", async (req: Request, res: Response) => {
  const id = parseInt(req.params["id"] as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const nasPath = await getNasPath();
  if (!nasPath) { res.status(409).json({ error: "No library configured" }); return; }

  const [updated] = await db
    .update(mediaFilesTable)
    .set({ lastScanAction: "DELETED" } as any)
    .where(and(eq(mediaFilesTable.id, id), eq(mediaFilesTable.nasPath, nasPath), ACTIVE_MEDIA))
    .returning({ id: mediaFilesTable.id });

  if (!updated) { res.status(404).json({ error: "File not found" }); return; }
  await purgeDerivedDataForMedia(nasPath, [updated.id]);
  res.json({ id: updated.id, deleted: true });
});

// ── PATCH /api/media/files/:id/rename — rename file on disk + DB ─────────────

router.patch("/media/files/:id/rename", async (req: Request, res: Response) => {
  const id = parseInt(req.params["id"] as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const newName: string = (req.body?.name ?? "").trim();
  if (!newName || newName.length > 255 || /[/\\<>:"|?*]/.test(newName)) {
    res.status(400).json({ error: "Invalid file name" }); return;
  }

  const nasPath = await getNasPath();
  if (!nasPath) { res.status(409).json({ error: "No library configured" }); return; }

  const [file] = await db.select().from(mediaFilesTable)
    .where(and(eq(mediaFilesTable.id, id), eq(mediaFilesTable.nasPath, nasPath), ACTIVE_MEDIA))
    .limit(1);
  if (!file) { res.status(404).json({ error: "File not found" }); return; }

  const fs = await import("fs");
  const path = await import("path");
  let oldAbs: string;
  try {
    oldAbs = resolveLibraryPath(nasPath, file.relativePath);
  } catch {
    res.status(400).json({ error: "Stored media path is outside the configured library" });
    return;
  }
  const dir = path.dirname(file.relativePath);
  const newRelPath = dir === "." ? newName : `${dir}/${newName}`;
  let newAbs: string;
  try {
    newAbs = resolveLibraryPath(nasPath, newRelPath);
  } catch {
    res.status(400).json({ error: "New file path is outside the configured library" });
    return;
  }

  if (!fs.existsSync(oldAbs)) { res.status(409).json({ error: "Source file not found on disk" }); return; }
  if (fs.existsSync(newAbs))  { res.status(409).json({ error: "A file with that name already exists" }); return; }

  fs.renameSync(oldAbs, newAbs);
  const [updated] = await db
    .update(mediaFilesTable)
    .set({ name: newName, relativePath: newRelPath })
    .where(and(eq(mediaFilesTable.id, id), eq(mediaFilesTable.nasPath, nasPath), ACTIVE_MEDIA))
    .returning({ id: mediaFilesTable.id, name: mediaFilesTable.name, relativePath: mediaFilesTable.relativePath });

  res.json(updated);
});

// ── GET /api/media/timeline — year/month buckets ─────────────────────────────

router.get("/media/timeline", async (_req: Request, res: Response) => {
  const nasPath = await getNasPath();
  if (!nasPath) {
    res.json({ buckets: [], undatedCount: 0 });
    return;
  }

  // Timeline buckets by taken/created only; files missing both go to "undated"
  // (modifiedAt would misclassify undated items into modified-date buckets).
  const bestDate = sql`COALESCE(${mediaFilesTable.dateTaken}, ${mediaFilesTable.dateCreated})`;
  const baseWhere = and(
    eq(mediaFilesTable.nasPath, nasPath),
    sql`${mediaFilesTable.mediaType} IN ('photo', 'video')`,
    activeMediaCondition,
  );

  const rows = await db
    .select({
      ym: sql<string | null>`to_char(${bestDate}, 'YYYY-MM')`,
      total: count(),
      coverId: sql<number>`MAX(${mediaFilesTable.id})`,
    })
    .from(mediaFilesTable)
    .where(baseWhere)
    .groupBy(sql`to_char(${bestDate}, 'YYYY-MM')`)
    .orderBy(sql`to_char(${bestDate}, 'YYYY-MM') DESC NULLS LAST`);

  const buckets = rows
    .filter((r) => r.ym != null)
    .map((r) => {
      const [year, month] = (r.ym as string).split("-");
      return { year: parseInt(year, 10), month: parseInt(month, 10), count: Number(r.total), coverFileId: r.coverId };
    });
  const undatedCount = rows
    .filter((r) => r.ym == null)
    .reduce((acc, r) => acc + Number(r.total), 0);

  res.json({ buckets, undatedCount });
});

// ── GET /api/media/timeline/items — files for one month (or undated) ─────────

router.get("/media/timeline/items", async (req: Request, res: Response) => {
  let page: number;
  let limit: number;
  const yearStr = req.query["year"] as string | undefined;
  const monthStr = req.query["month"] as string | undefined;
  let year: number | undefined;
  let month: number | undefined;
  try {
    page = parseBoundedInteger(req.query["page"], { name: "page", min: 1, max: 10_000_000, defaultValue: 1 });
    limit = parseBoundedInteger(req.query["limit"], { name: "limit", min: 1, max: 200, defaultValue: 60 });
    if ((yearStr === undefined) !== (monthStr === undefined)) {
      throw new RequestValidationError("Invalid timeline date");
    }
    if (yearStr !== undefined && monthStr !== undefined) {
      year = parseBoundedInteger(yearStr, { name: "year", min: 1, max: 9999 });
      month = parseBoundedInteger(monthStr, { name: "month", min: 1, max: 12 });
    }
  } catch (error) {
    if (error instanceof RequestValidationError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    throw error;
  }

  const nasPath = await getNasPath();
  if (!nasPath) {
    res.json({ files: [], total: 0 });
    return;
  }

  const offset = (page - 1) * limit;

  const bestDate = sql`COALESCE(${mediaFilesTable.dateTaken}, ${mediaFilesTable.dateCreated})`;
  const conditions = [
    eq(mediaFilesTable.nasPath, nasPath),
    sql`${mediaFilesTable.mediaType} IN ('photo', 'video')`,
    activeMediaCondition,
  ];

  if (year !== undefined && month !== undefined) {
    const ym = `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}`;
    conditions.push(sql`to_char(${bestDate}, 'YYYY-MM') = ${ym}`);
  } else {
    conditions.push(sql`${bestDate} IS NULL`);
  }

  const where = and(...conditions);
  const [totalRow] = await db.select({ total: count() }).from(mediaFilesTable).where(where);
  const files = await db
    .select()
    .from(mediaFilesTable)
    .where(where)
    .orderBy(sql`COALESCE(${mediaFilesTable.dateTaken}, ${mediaFilesTable.dateCreated}) DESC NULLS LAST`)
    .limit(limit)
    .offset(offset);

  res.json({ files, total: Number(totalRow?.total ?? 0), page, limit });
});

// ── GET /api/media/thumbnail/:id — serve or generate thumbnail ───────────────

function serveCachedThumb(res: Response, thumbPath: string, id: number): void {
  res.setHeader("Content-Type", "image/webp");
  res.setHeader("Cache-Control", "public, max-age=86400");
  const stream = fs.createReadStream(thumbPath);
  stream.on("error", () => {
    _thumbCache.delete(id);
    if (!res.headersSent) res.status(404).json({ error: "Thumbnail not found" });
    else res.end();
  });
  stream.pipe(res);
}

router.get("/media/thumbnail/:id", async (req: Request, res: Response) => {
  const id = parseInt(req.params["id"] as string);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  // Confirm the file is still discoverable before using the thumbnail cache.
  // Recycled files must not remain reachable through an old thumbnail URL.
  const nasPath = await getNasPath();
  if (!nasPath) {
    res.status(404).json({ error: "NAS not configured" });
    return;
  }
  const [activeFile] = await db
    .select({ id: mediaFilesTable.id })
    .from(mediaFilesTable)
    .where(and(eq(mediaFilesTable.id, id), eq(mediaFilesTable.nasPath, nasPath), ACTIVE_MEDIA))
    .limit(1);
  if (!activeFile) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  const cached = _thumbCache.get(id);
  if (cached?.nasPath === nasPath) {
    if (isThumbnailFileValid(cached.path)) {
      serveCachedThumb(res, cached.path, id);
      return;
    }
    _thumbCache.delete(id);
  }

  const [file] = await db
    .select({
      id:            mediaFilesTable.id,
      thumbnailPath: mediaFilesTable.thumbnailPath,
      relativePath:  mediaFilesTable.relativePath,
      extension:     mediaFilesTable.extension,
    })
    .from(mediaFilesTable)
   .where(and(eq(mediaFilesTable.id, id), eq(mediaFilesTable.nasPath, nasPath), ACTIVE_MEDIA))
    .limit(1);

  if (!file) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  // Check DB-stored path
  if (file.thumbnailPath) {
    try {
      const thumbPath = resolveWithinRoot(file.thumbnailPath, getWillardAIDir(nasPath));
       if (isThumbnailFileValid(thumbPath)) {
        _thumbCache.set(id, { nasPath, path: thumbPath });
        serveCachedThumb(res, thumbPath, id);
        return;
      }
    } catch {
      // Ignore stale or out-of-library DB paths and continue to the safe fallback.
    }
  }

  // Fallback: check by id-based filename in thumbdir (heals stale DB paths)
  const thumbDir = getThumbnailDir(nasPath);
  const thumbFile = path.join(thumbDir, thumbnailFilename(id));
  const safeThumbFile = resolveWithinRoot(thumbFile, getWillardAIDir(nasPath));
  if (isThumbnailFileValid(safeThumbFile)) {
    _thumbCache.set(id, { nasPath, path: safeThumbFile });
    db.update(mediaFilesTable)
      .set({ thumbnailPath: safeThumbFile, thumbnailGeneratedAt: new Date() })
      .where(and(eq(mediaFilesTable.id, id), eq(mediaFilesTable.nasPath, nasPath), ACTIVE_MEDIA))
      .catch(() => {});
    serveCachedThumb(res, safeThumbFile, id);
    return;
  }

  // Generate on-demand
  let sourcePath: string;
  try {
    sourcePath = resolveLibraryPath(nasPath, file.relativePath);
  } catch {
    res.status(400).json({ error: "Stored media path is outside the configured library" });
    return;
  }
  if (!fs.existsSync(sourcePath)) {
    res.status(404).json({ error: "Source file not found on NAS" });
    return;
  }

  const result = await generateThumbnail(id, sourcePath, file.extension, nasPath);
  if (result.error || !result.destPath || !fs.existsSync(result.destPath)) {
    res.status(500).json({ error: result.error ?? "Thumbnail generation failed" });
    return;
  }

  const safeResultPath = resolveWithinRoot(result.destPath, getWillardAIDir(nasPath));
  _thumbCache.set(id, { nasPath, path: safeResultPath });
  db.update(mediaFilesTable)
    .set({ thumbnailPath: safeResultPath, thumbnailGeneratedAt: new Date() })
    .where(and(eq(mediaFilesTable.id, id), eq(mediaFilesTable.nasPath, nasPath), ACTIVE_MEDIA))
    .catch(() => {});

  serveCachedThumb(res, safeResultPath, id);
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
     .where(and(eq(mediaFilesTable.id, id), eq(mediaFilesTable.nasPath, nasPath), ACTIVE_MEDIA))
    .limit(1);

  if (!file) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  let sourcePath: string;
  try {
    sourcePath = resolveLibraryPath(nasPath, file.relativePath);
  } catch {
    res.status(400).json({ error: "Stored media path is outside the configured library" });
    return;
  }
  if (!fs.existsSync(sourcePath)) {
    res.status(404).json({ error: "Source file not found on NAS" });
    return;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(sourcePath);
  } catch {
    res.status(404).json({ error: "Source file not found on NAS" });
    return;
  }

  const requestedRange = req.headers.range;
  const range = requestedRange === undefined
    ? null
    : parseSingleByteRange(requestedRange, stat.size);
  if (requestedRange !== undefined && range === null) {
    sendRangeNotSatisfiable(res, stat.size);
    return;
  }

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
  if (range) {
    const chunkSize = range.end - range.start + 1;
    res.status(206);
    res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
    res.setHeader("Content-Length", chunkSize);
    streamFileWithErrorHandling(res, sourcePath, range);
  } else {
    res.setHeader("Content-Length", stat.size);
    streamFileWithErrorHandling(res, sourcePath);
  }
});

export default router;
