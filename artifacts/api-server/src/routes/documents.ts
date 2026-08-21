import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { mediaFilesTable, appSettingsTable } from "@workspace/db";
import { eq, ilike, and, desc, count, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

const router: IRouter = Router();

const NOT_DELETED = sql`${mediaFilesTable.lastScanAction} IS DISTINCT FROM 'DELETED'`;

async function getNasPath(): Promise<string | null> {
  const [row] = await db.select({ nasPath: appSettingsTable.nasPath }).from(appSettingsTable).limit(1);
  const nasPath = row?.nasPath?.trim();
  return nasPath || null;
}

router.get("/documents", async (req, res) => {
  try {
    const nasPath = await getNasPath();
    if (!nasPath) return res.json({ documents: [], total: 0, offset: 0, limit: 0 });
    const { q, fileType: ft, limit = "50", offset = "0" } = req.query as Record<string, string>;
    const conditions: SQL[] = [NOT_DELETED, eq(mediaFilesTable.nasPath, nasPath), eq(mediaFilesTable.mediaType, "document")];
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
      .limit(parseInt(limit))
      .offset(parseInt(offset));
    return res.json({ documents, total, offset: parseInt(offset), limit: parseInt(limit) });
  } catch {
    return res.status(500).json({ error: "Failed to list documents" });
  }
});

export default router;
