import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { appSettingsTable, mediaFilesTable } from "@workspace/db";
import { eq, ilike, gte, lte, and, sql, desc, count } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { activeMediaCondition } from "../lib/media-scope.ts";
import { reconcileLegacyCatalog } from "../lib/catalog-reconciliation";
import { parseBoundedInteger, parseOptionalDate, RequestValidationError } from "../lib/request-validation.ts";

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
    const { q, fileType, minSize, maxSize, after, before, source } = req.query as Record<string, string>;
    const lim = parseBoundedInteger(req.query["limit"], { name: "limit", min: 1, max: 200, defaultValue: 50 });
    const off = parseBoundedInteger(req.query["offset"], { name: "offset", min: 0, max: 10_000_000, defaultValue: 0 });
    const minSizeValue = parseBoundedInteger(req.query["minSize"], { name: "minSize", min: 0, max: Number.MAX_SAFE_INTEGER, defaultValue: 0 });
    const maxSizeValue = req.query["maxSize"] === undefined
      ? undefined
      : parseBoundedInteger(req.query["maxSize"], { name: "maxSize", min: 0, max: Number.MAX_SAFE_INTEGER });
    const afterDate = parseOptionalDate(after, "after");
    const beforeDate = parseOptionalDate(before, "before");
    if (maxSizeValue !== undefined && minSizeValue > maxSizeValue) {
      throw new RequestValidationError("Invalid size range");
    }
    if (afterDate && beforeDate && afterDate > beforeDate) {
      throw new RequestValidationError("Invalid date range");
    }

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
    if (minSize !== undefined) conditions.push(gte(mediaFilesTable.sizeBytes, minSizeValue));
    if (maxSizeValue !== undefined) conditions.push(lte(mediaFilesTable.sizeBytes, maxSizeValue));
    if (afterDate) conditions.push(gte(mediaFilesTable.modifiedAt, afterDate));
    if (beforeDate) conditions.push(lte(mediaFilesTable.modifiedAt, beforeDate));

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
  } catch (error) {
    if (error instanceof RequestValidationError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: "Search failed" });
  }
});

export default router;
