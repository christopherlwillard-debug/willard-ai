import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { indexedFilesTable } from "@workspace/db";
import { eq, ilike, gte, lte, and, sql, desc, count } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

const router: IRouter = Router();

/**
 * Search local indexed files. Returns a unified result set.
 */
router.get("/files/search", async (req, res) => {
  try {
    const { q, fileType, minSize, maxSize, after, before, source, limit = "50", offset = "0" } = req.query as Record<string, string>;

    const lim = parseInt(limit);
    const off = parseInt(offset);

    // --- Local DB search ---
    const conditions: SQL[] = [];
    if (q) conditions.push(ilike(indexedFilesTable.filename, `%${q}%`));
    if (fileType && fileType !== "all") conditions.push(eq(indexedFilesTable.fileType, fileType));
    if (source && source !== "all") conditions.push(eq(indexedFilesTable.source, source));
    if (minSize) conditions.push(gte(indexedFilesTable.sizeBytes, parseInt(minSize)));
    if (maxSize) conditions.push(lte(indexedFilesTable.sizeBytes, parseInt(maxSize)));
    if (after) conditions.push(gte(indexedFilesTable.modifiedAt, new Date(after)));
    if (before) conditions.push(lte(indexedFilesTable.modifiedAt, new Date(before)));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [{ total: localTotal }] = await db.select({ total: count() }).from(indexedFilesTable).where(where);
    const localFiles = await db.select().from(indexedFilesTable)
      .where(where)
      .orderBy(desc(indexedFilesTable.modifiedAt))
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
