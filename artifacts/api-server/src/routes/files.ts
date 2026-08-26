import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { appSettingsTable, mediaFilesTable } from "@workspace/db";
import { eq, ilike, gte, lte, and, sql, desc, count } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { activeMediaCondition } from "../lib/media-scope.ts";
import { reconcileLegacyCatalog } from "../lib/catalog-reconciliation";

const router: IRouter = Router();

router.post("/files/reconcile-legacy", async (_req, res) => {
  try {
    res.json(await reconcileLegacyCatalog());
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Legacy catalog reconciliation failed" });
  }
});

/**
 * Search the canonical media catalog. Returns a legacy-compatible result set.
 */
router.get("/files/search", async (req, res) => {
  try {
    const { q, fileType, minSize, maxSize, after, before, source, limit = "50", offset = "0" } = req.query as Record<string, string>;

    const lim = parseInt(limit);
    const off = parseInt(offset);

    const [settings] = await db.select({ nasPath: appSettingsTable.nasPath })
      .from(appSettingsTable).limit(1);
    const nasPath = settings?.nasPath?.trim();
    if (!nasPath) {
      res.json({ files: [], total: 0, offset: off, limit: lim, sources: { local: 0 } });
      return;
    }

    const conditions: SQL[] = [];
    conditions.push(eq(mediaFilesTable.nasPath, nasPath));
    conditions.push(activeMediaCondition);
    if (q) conditions.push(ilike(mediaFilesTable.name, `%${q}%`));
    if (fileType && fileType !== "all") {
      conditions.push(eq(mediaFilesTable.mediaType, fileType === "image" ? "photo" : fileType));
    }
    if (source && source !== "all" && source !== "local") {
      res.json({ files: [], total: 0, offset: off, limit: lim, sources: { local: 0 } });
      return;
    }
    if (minSize) conditions.push(gte(mediaFilesTable.sizeBytes, parseInt(minSize)));
    if (maxSize) conditions.push(lte(mediaFilesTable.sizeBytes, parseInt(maxSize)));
    if (after) conditions.push(gte(mediaFilesTable.modifiedAt, new Date(after)));
    if (before) conditions.push(lte(mediaFilesTable.modifiedAt, new Date(before)));

    const where = and(...conditions);

    const [{ total: localTotal }] = await db.select({ total: count() }).from(mediaFilesTable).where(where);
    const localFiles = await db.select({
      id: mediaFilesTable.id,
      path: sql<string>`${mediaFilesTable.nasPath} || '/' || ${mediaFilesTable.relativePath}`,
      filename: mediaFilesTable.name,
      extension: mediaFilesTable.extension,
      fileType: sql<string>`CASE WHEN ${mediaFilesTable.mediaType} = 'photo' THEN 'image' ELSE ${mediaFilesTable.mediaType} END`,
      sizeBytes: mediaFilesTable.sizeBytes,
      modifiedAt: mediaFilesTable.modifiedAt,
      folder: sql<string>`regexp_replace(${mediaFilesTable.relativePath}, '[^/]+$', '')`,
      source: sql<string>`'local'`,
      contentHash: mediaFilesTable.contentHash,
      indexedAt: mediaFilesTable.indexedAt,
    }).from(mediaFilesTable)
      .where(where)
      .orderBy(desc(mediaFilesTable.modifiedAt))
      .limit(lim)
      .offset(off);

    res.json({
      files: localFiles,
      total: localTotal,
      offset: off,
      limit: lim,
      sources: { local: localTotal },
    });
  } catch {
    res.status(500).json({ error: "Search failed" });
  }
});

export default router;
