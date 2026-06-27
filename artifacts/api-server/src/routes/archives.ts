import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { archivesTable } from "@workspace/db";
import { eq, gte, lte, and, desc, count } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import AdmZip from "adm-zip";
import * as tar from "tar";
import * as path from "path";
import * as fs from "fs";

const router: IRouter = Router();

const ZIP_EXTS = new Set(["zip"]);
const TAR_EXTS = new Set(["tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz", "tar.gz", "tar.bz2", "tar.xz"]);
const BINARY_ONLY_EXTS = new Set(["rar", "7z", "cab", "iso"]);

function getFileTypeFromName(filename: string): string {
  const ext = path.extname(filename).replace(".", "").toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "bmp", "webp", "heic", "heif", "tiff", "raw"].includes(ext)) return "image";
  if (["mp4", "mkv", "avi", "mov", "wmv", "flv", "m4v", "webm", "mpg"].includes(ext)) return "video";
  if (["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf", "odt"].includes(ext)) return "document";
  if (["zip", "rar", "7z", "tar", "gz", "bz2"].includes(ext)) return "archive";
  if (["exe", "msi", "dmg", "pkg", "deb", "rpm", "sh", "bat", "app"].includes(ext)) return "software";
  return "other";
}

function computeCategoryFromContent(entries: any[], isPasswordProtected: boolean): string {
  if (isPasswordProtected) return "Password Protected";
  const files = entries.filter(e => !e.isDirectory);
  if (files.length === 0) return "Unknown";

  const counts: Record<string, number> = { image: 0, video: 0, document: 0, archive: 0, software: 0, other: 0 };
  for (const e of files) {
    const t = e.fileType ?? "other";
    counts[t] = (counts[t] || 0) + 1;
  }

  const total = files.length;
  const hasNested = counts.archive > 0;

  if (hasNested && counts.archive / total > 0.25) return "Nested Archives";
  if (counts.image / total > 0.55) return "Photo Archive";
  if (counts.video / total > 0.45) return "Video Archive";
  if (counts.document / total > 0.45) return "Document Backup";
  if (counts.software / total > 0.35) return "Software";

  const topType = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  if (counts[topType] / total < 0.4) return "Mixed";
  return "General";
}

async function peekTar(filePath: string, ext: string): Promise<{ entries: any[]; error: string | null }> {
  const entries: any[] = [];
  const isGzipped = ["gz", "tgz", "bz2", "tbz2", "xz", "txz"].includes(ext);
  try {
    await tar.list({
      file: filePath,
      ...(isGzipped ? { gzip: ext === "gz" || ext === "tgz" } : {}),
      onentry: (entry: any) => {
        const fileType = getFileTypeFromName(entry.path);
        entries.push({
          name: path.basename(entry.path),
          path: entry.path,
          sizeBytes: typeof entry.size === "number" ? entry.size : 0,
          isDirectory: entry.type === "Directory",
          fileType,
        });
      }
    });
    return { entries, error: null };
  } catch (e: any) {
    // Plain .gz (not a tar wrapper) will fail here — that's expected
    return { entries, error: e?.message ?? "Could not parse as TAR archive" };
  }
}

function readArchiveHeader(filePath: string): { formatDetected: string; notes: string } {
  try {
    const buf = Buffer.alloc(8);
    const fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);

    const sig = buf.slice(0, 7).toString("hex");

    // RAR4: 52 61 72 21 1a 07 00, RAR5: 52 61 72 21 1a 07 01 00
    if (sig.startsWith("526172211a07")) return { formatDetected: "RAR", notes: buf[6] === 0x01 ? "RAR5 format" : "RAR4 format" };
    // 7Z: 37 7a bc af 27 1c
    if (sig.startsWith("377abcaf271c")) return { formatDetected: "7-Zip", notes: "7Z solid archive" };
    // ISO 9660: identifier at offset 32769 — skip for now, report as ISO
    return { formatDetected: "Unknown", notes: "No recognized binary signature" };
  } catch {
    return { formatDetected: "Unknown", notes: "Could not read file header" };
  }
}

router.get("/archives", async (req, res) => {
  try {
    const { category, minSize, maxSize, status, dateFrom, dateTo, limit = "50", offset = "0" } = req.query as Record<string, string>;
    const conditions: SQL[] = [];
    if (category) conditions.push(eq(archivesTable.category, category));
    if (minSize) conditions.push(gte(archivesTable.sizeBytes, parseInt(minSize)));
    if (maxSize) conditions.push(lte(archivesTable.sizeBytes, parseInt(maxSize)));
    if (status) conditions.push(eq(archivesTable.peekStatus, status));
    if (dateFrom) conditions.push(gte(archivesTable.modifiedAt, new Date(dateFrom)));
    if (dateTo) conditions.push(lte(archivesTable.modifiedAt, new Date(dateTo)));
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

    if (!fs.existsSync(archive.path)) {
      res.status(422).json({ error: "Archive file not found on disk — re-run a scan" });
      return;
    }

    const rawExt = path.extname(archive.filename).replace(".", "").toLowerCase();
    // Handle double-extension like .tar.gz
    const ext = archive.filename.toLowerCase().endsWith(".tar.gz") ? "tar.gz"
      : archive.filename.toLowerCase().endsWith(".tar.bz2") ? "tar.bz2"
      : archive.filename.toLowerCase().endsWith(".tar.xz") ? "tar.xz"
      : rawExt;

    // ── ZIP ─────────────────────────────────────────────────────────────────
    if (ZIP_EXTS.has(ext)) {
      let entries: any[] = [];
      let isPasswordProtected = false;
      let hasNestedArchives = false;
      let estimatedExtractionSize = 0;
      let photoCount = 0; let videoCount = 0; let documentCount = 0;

      try {
        const zip = new AdmZip(archive.path);
        const zipEntries = zip.getEntries();
        for (const entry of zipEntries) {
          const fileType = getFileTypeFromName(entry.entryName);
          const uncompressedSize: number = (entry.header as any)?.size ?? 0;
          estimatedExtractionSize += uncompressedSize;
          const nestedExt = path.extname(entry.entryName).replace(".", "").toLowerCase();
          if (TAR_EXTS.has(nestedExt) || nestedExt === "zip" || BINARY_ONLY_EXTS.has(nestedExt)) hasNestedArchives = true;
          if (fileType === "image") photoCount++;
          if (fileType === "video") videoCount++;
          if (fileType === "document") documentCount++;
          entries.push({
            name: path.basename(entry.entryName),
            path: entry.entryName,
            sizeBytes: uncompressedSize,
            isDirectory: entry.isDirectory,
            fileType,
          });
        }
      } catch {
        isPasswordProtected = true;
      }

      const category = computeCategoryFromContent(entries, isPasswordProtected);
      await db.update(archivesTable).set({
        peekStatus: "peeked",
        containedFileCount: entries.length,
        isPasswordProtected,
        hasNestedArchives,
        estimatedExtractionSize,
        peekEntries: entries,
        category,
      }).where(eq(archivesTable.id, id));

      res.json({
        archiveId: id, filename: archive.filename, entries, totalEntries: entries.length,
        isPasswordProtected, hasNestedArchives, estimatedExtractionSizeBytes: estimatedExtractionSize,
        category, photoCount, videoCount, documentCount, format: "zip",
      });
      return;
    }

    // ── TAR / GZ / BZ2 / XZ ─────────────────────────────────────────────────
    if (TAR_EXTS.has(ext)) {
      const { entries, error } = await peekTar(archive.path, rawExt);

      if (error && entries.length === 0) {
        // Plain .gz (not a TAR) — provide basic metadata from file size
        await db.update(archivesTable).set({
          peekStatus: "peeked",
          containedFileCount: 0,
          isPasswordProtected: false,
          hasNestedArchives: false,
          estimatedExtractionSize: 0,
          peekEntries: [],
          category: archive.category ?? "General",
        }).where(eq(archivesTable.id, id));

        res.json({
          archiveId: id, filename: archive.filename, entries: [], totalEntries: 0,
          isPasswordProtected: false, hasNestedArchives: false, estimatedExtractionSizeBytes: 0,
          category: archive.category ?? "General", format: "gz",
          notes: "Plain compressed file (not a TAR) — contents not listable without extraction",
        });
        return;
      }

      const hasNestedArchives = entries.some(e =>
        TAR_EXTS.has(path.extname(e.path).replace(".", "").toLowerCase()) ||
        ZIP_EXTS.has(path.extname(e.path).replace(".", "").toLowerCase()) ||
        BINARY_ONLY_EXTS.has(path.extname(e.path).replace(".", "").toLowerCase())
      );
      const estimatedExtractionSize = entries.reduce((s, e) => s + (e.sizeBytes ?? 0), 0);
      const category = computeCategoryFromContent(entries, false);

      await db.update(archivesTable).set({
        peekStatus: "peeked",
        containedFileCount: entries.length,
        isPasswordProtected: false,
        hasNestedArchives,
        estimatedExtractionSize,
        peekEntries: entries,
        category,
      }).where(eq(archivesTable.id, id));

      res.json({
        archiveId: id, filename: archive.filename, entries, totalEntries: entries.length,
        isPasswordProtected: false, hasNestedArchives, estimatedExtractionSizeBytes: estimatedExtractionSize,
        category, format: `tar/${rawExt}`,
      });
      return;
    }

    // ── RAR / 7Z / ISO / CAB — read header metadata, cannot list without binary ──
    if (BINARY_ONLY_EXTS.has(ext)) {
      const { formatDetected, notes } = readArchiveHeader(archive.path);

      // Estimate from filename
      const filenameCategory = archive.category ?? "General";

      await db.update(archivesTable).set({
        peekStatus: "peeked",
        containedFileCount: null,
        isPasswordProtected: false,
        hasNestedArchives: false,
        estimatedExtractionSize: null,
        peekEntries: [],
        category: filenameCategory,
      }).where(eq(archivesTable.id, id));

      res.json({
        archiveId: id, filename: archive.filename, entries: [], totalEntries: null,
        isPasswordProtected: false, hasNestedArchives: false, estimatedExtractionSizeBytes: null,
        category: filenameCategory, format: formatDetected,
        notes: `${formatDetected} format detected (${notes}). Full file listing requires a 7z binary (not available in this environment). File size: ${archive.sizeBytes?.toLocaleString() ?? "unknown"} bytes on disk.`,
        limitedPeek: true,
      });
      return;
    }

    res.status(422).json({ error: `Unrecognized archive format: .${ext}` });
  } catch (err) {
    console.error("Peek error:", err);
    res.status(500).json({ error: "Failed to peek archive" });
  }
});

export default router;
