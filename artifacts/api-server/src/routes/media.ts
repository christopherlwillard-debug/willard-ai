import { Router, type Request, type Response } from "express";
import * as fs from "fs";
import * as path from "path";
import { db } from "@workspace/db";
import { mediaFilesTable, appSettingsTable } from "@workspace/db";
import { eq, and, like, desc, asc, sql, count } from "drizzle-orm";
import { generateThumbnail, getThumbnailDir, thumbnailFilename } from "../lib/thumbnail-engine";

const router = Router();

// ── Helper: get NAS path ──────────────────────────────────────────────────────

async function getNasPath(): Promise<string | null> {
  const [row] = await db.select({ nasPath: appSettingsTable.nasPath }).from(appSettingsTable).limit(1);
  return row?.nasPath ?? null;
}

// ── GET /api/media/files — paginated, filtered file listing ──────────────────

router.get("/media/files", async (req: Request, res: Response) => {
  const nasPath = await getNasPath();
  if (!nasPath) {
    res.json({ files: [], total: 0 });
    return;
  }

  const mediaType = req.query["mediaType"] as string | undefined;
  const favorites = req.query["favorites"] as string | undefined;
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
  if (favorites === "true") {
    conditions.push(eq(mediaFilesTable.favorite, true));
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
    .where(eq(mediaFilesTable.nasPath, nasPath));

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
    .where(eq(mediaFilesTable.id, id))
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

  const [updated] = await db
    .update(mediaFilesTable)
    .set({ lastScanAction: "DELETED" } as any)
    .where(eq(mediaFilesTable.id, id))
    .returning({ id: mediaFilesTable.id });

  if (!updated) { res.status(404).json({ error: "File not found" }); return; }
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

  const [file] = await db.select().from(mediaFilesTable).where(eq(mediaFilesTable.id, id)).limit(1);
  if (!file) { res.status(404).json({ error: "File not found" }); return; }

  const fs = await import("fs");
  const path = await import("path");
  const oldAbs = path.join(nasPath, file.relativePath);
  const dir = path.dirname(file.relativePath);
  const newRelPath = dir === "." ? newName : `${dir}/${newName}`;
  const newAbs = path.join(nasPath, newRelPath);

  if (!fs.existsSync(oldAbs)) { res.status(409).json({ error: "Source file not found on disk" }); return; }
  if (fs.existsSync(newAbs))  { res.status(409).json({ error: "A file with that name already exists" }); return; }

  fs.renameSync(oldAbs, newAbs);
  const [updated] = await db
    .update(mediaFilesTable)
    .set({ name: newName, relativePath: newRelPath })
    .where(eq(mediaFilesTable.id, id))
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
  const nasPath = await getNasPath();
  if (!nasPath) {
    res.json({ files: [], total: 0 });
    return;
  }

  const yearStr = req.query["year"] as string | undefined;
  const monthStr = req.query["month"] as string | undefined;
  const page = Math.max(1, parseInt(req.query["page"] as string) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query["limit"] as string) || 60));
  const offset = (page - 1) * limit;

  const bestDate = sql`COALESCE(${mediaFilesTable.dateTaken}, ${mediaFilesTable.dateCreated})`;
  const conditions = [
    eq(mediaFilesTable.nasPath, nasPath),
    sql`${mediaFilesTable.mediaType} IN ('photo', 'video')`,
  ];

  if (yearStr && monthStr) {
    const ym = `${yearStr.padStart(4, "0")}-${monthStr.padStart(2, "0")}`;
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
