import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { mediaFilesTable, appSettingsTable } from "@workspace/db";
import { eq, ilike, and, desc, count } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { activeMediaCondition } from "../lib/media-scope.ts";
import { parseBoundedInteger, RequestValidationError } from "../lib/request-validation.ts";

const router: IRouter = Router();

async function getNasPath(): Promise<string | null> {
  const [row] = await db.select({ nasPath: appSettingsTable.nasPath }).from(appSettingsTable).limit(1);
  const nasPath = row?.nasPath?.trim();
  return nasPath || null;
}

router.get("/documents", async (req, res) => {
  try {
    const nasPath = await getNasPath();
    if (!nasPath) return res.json({ documents: [], total: 0, offset: 0, limit: 0 });
    const { q, fileType: ft } = req.query as Record<string, string>;
    const limit = parseBoundedInteger(req.query.limit, { name: "limit", min: 1, max: 200, defaultValue: 50 });
    const offset = parseBoundedInteger(req.query.offset, { name: "offset", min: 0, max: 10_000_000, defaultValue: 0 });
    const conditions: SQL[] = [activeMediaCondition, eq(mediaFilesTable.nasPath, nasPath), eq(mediaFilesTable.mediaType, "document")];
    if (q) conditions.push(ilike(mediaFilesTable.name, `%${q}%`));
    if (ft) conditions.push(eq(mediaFilesTable.extension, ft));
    const where = and(...conditions);
    const [{ total }] = await db.select({ total: count() }).from(mediaFilesTable).where(where);
    const documents = await db.select({
      id:         mediaFilesTable.id,
      filename:   mediaFilesTable.name,
      extension:  mediaFilesTable.extension,
      fileType:   mediaFilesTable.mediaType,
      sizeBytes:  mediaFilesTable.sizeBytes,
      modifiedAt: mediaFilesTable.modifiedAt,
      folder:     mediaFilesTable.relativePath,
      path:       mediaFilesTable.relativePath,
      pageCount:  mediaFilesTable.pageCount,
      pdfAuthor:  mediaFilesTable.pdfAuthor,
      pdfTitle:   mediaFilesTable.pdfTitle,
    }).from(mediaFilesTable)
      .where(where)
      .orderBy(desc(mediaFilesTable.modifiedAt))
      .limit(limit)
      .offset(offset);
    return res.json({ documents, total, offset, limit });
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    return res.status(500).json({ error: "Failed to list documents" });
  }
});

export default router;
