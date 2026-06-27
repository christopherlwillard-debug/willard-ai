import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { archivesTable } from "@workspace/db";
import { eq, gte, lte, and, desc, count, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import AdmZip from "adm-zip";
import * as path from "path";

const router: IRouter = Router();

function getFileTypeFromName(filename: string): string {
  const ext = path.extname(filename).replace(".", "").toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "bmp", "webp", "heic"].includes(ext)) return "image";
  if (["mp4", "mkv", "avi", "mov", "wmv"].includes(ext)) return "video";
  if (["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt"].includes(ext)) return "document";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "archive";
  return "other";
}

router.get("/archives", async (req, res) => {
  try {
    const { category, minSize, maxSize, limit = "50", offset = "0" } = req.query as Record<string, string>;
    const conditions: SQL[] = [];
    if (category) conditions.push(eq(archivesTable.category, category));
    if (minSize) conditions.push(gte(archivesTable.sizeBytes, parseInt(minSize)));
    if (maxSize) conditions.push(lte(archivesTable.sizeBytes, parseInt(maxSize)));
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const [{ total }] = await db.select({ total: count() }).from(archivesTable).where(where);
    const archives = await db.select().from(archivesTable)
      .where(where)
      .orderBy(desc(archivesTable.sizeBytes))
      .limit(parseInt(limit))
      .offset(parseInt(offset));
    res.json({ archives, total, offset: parseInt(offset), limit: parseInt(limit) });
  } catch {
    res.status(500).json({ error: "Failed to list archives" });
  }
});

router.get("/archives/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [archive] = await db.select().from(archivesTable).where(eq(archivesTable.id, id)).limit(1);
    if (!archive) { res.status(404).json({ error: "Archive not found" }); return; }
    const entries = (archive.peekEntries as any[]) ?? [];
    res.json({ ...archive, peekEntries: entries });
  } catch {
    res.status(500).json({ error: "Failed to get archive" });
  }
});

router.post("/archives/:id/peek", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [archive] = await db.select().from(archivesTable).where(eq(archivesTable.id, id)).limit(1);
    if (!archive) { res.status(404).json({ error: "Archive not found" }); return; }

    let entries: any[] = [];
    let isPasswordProtected = false;
    let hasNestedArchives = false;
    let estimatedExtractionSize = 0;
    let photoCount = 0;
    let videoCount = 0;
    let documentCount = 0;

    const ext = path.extname(archive.filename).replace(".", "").toLowerCase();
    if (ext === "zip") {
      try {
        const zip = new (AdmZip as any)(archive.path);
        const zipEntries = zip.getEntries();
        for (const entry of zipEntries) {
          const fileType = getFileTypeFromName(entry.entryName);
          estimatedExtractionSize += entry.header?.size ?? 0;
          if (["zip", "rar", "7z"].includes(path.extname(entry.entryName).replace(".", "").toLowerCase())) hasNestedArchives = true;
          if (fileType === "image") photoCount++;
          if (fileType === "video") videoCount++;
          if (fileType === "document") documentCount++;
          entries.push({
            name: path.basename(entry.entryName),
            path: entry.entryName,
            sizeBytes: entry.header?.size ?? 0,
            isDirectory: entry.isDirectory,
            fileType,
          });
        }
      } catch {
        isPasswordProtected = true;
      }
    } else {
      entries = [{
        name: archive.filename,
        path: archive.path,
        sizeBytes: archive.sizeBytes,
        isDirectory: false,
        fileType: "archive",
      }];
    }

    await db.update(archivesTable).set({
      peekStatus: "peeked",
      containedFileCount: entries.length,
      isPasswordProtected,
      hasNestedArchives,
      estimatedExtractionSize,
      peekEntries: entries,
    }).where(eq(archivesTable.id, id));

    res.json({
      archiveId: id,
      filename: archive.filename,
      entries,
      totalEntries: entries.length,
      isPasswordProtected,
      hasNestedArchives,
      estimatedExtractionSizeBytes: estimatedExtractionSize,
      category: archive.category,
      photoCount,
      videoCount,
      documentCount,
    });
  } catch {
    res.status(500).json({ error: "Failed to peek archive" });
  }
});

export default router;
