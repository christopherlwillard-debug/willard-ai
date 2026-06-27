import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { indexedFilesTable } from "@workspace/db";
import { eq, ilike, and, desc, count } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

const router: IRouter = Router();

router.get("/documents", async (req, res) => {
  try {
    const { q, fileType: ft, limit = "50", offset = "0" } = req.query as Record<string, string>;
    const conditions: SQL[] = [eq(indexedFilesTable.fileType, "document")];
    if (q) conditions.push(ilike(indexedFilesTable.filename, `%${q}%`));
    if (ft) conditions.push(eq(indexedFilesTable.extension, ft));
    const where = and(...conditions);
    const [{ total }] = await db.select({ total: count() }).from(indexedFilesTable).where(where);
    const documents = await db.select().from(indexedFilesTable)
      .where(where)
      .orderBy(desc(indexedFilesTable.modifiedAt))
      .limit(parseInt(limit))
      .offset(parseInt(offset));
    res.json({ documents, total, offset: parseInt(offset), limit: parseInt(limit) });
  } catch {
    res.status(500).json({ error: "Failed to list documents" });
  }
});

export default router;
