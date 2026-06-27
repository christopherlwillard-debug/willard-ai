import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { scanJobsTable, indexedFilesTable, archivesTable, appSettingsTable } from "@workspace/db";
import { desc, eq, sql, and } from "drizzle-orm";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import AdmZip from "adm-zip";
import * as tar from "tar";
import Seven from "node-7z";
import { path7za } from "7zip-bin";

const router: IRouter = Router();

let currentScanJobId: number | null = null;

const HASH_SIZE_LIMIT = 500 * 1024 * 1024;

// File types managed by Immich — excluded from local indexing to avoid duplication
const IMMICH_TYPES = new Set(["image", "video"]);

const ARCHIVE_EXTS = new Set(["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz", "tbz2", "txz", "cab", "iso"]);
const ZIP_EXTS = new Set(["zip"]);
const TAR_EXTS = new Set(["tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz", "tar.gz", "tar.bz2", "tar.xz"]);
const SEVENZIP_EXTS = new Set(["rar", "7z", "cab", "iso"]);

function getFileType(ext: string): string {
  const img = ["jpg", "jpeg", "png", "gif", "bmp", "webp", "heic", "heif", "tiff", "raw", "cr2", "nef", "arw"];
  const vid = ["mp4", "mkv", "avi", "mov", "wmv", "flv", "m4v", "webm", "mpeg", "mpg", "3gp"];
  const doc = ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "txt", "rtf", "pages", "numbers", "key"];
  const arch = ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "cab", "iso"];
  const audio = ["mp3", "flac", "wav", "aac", "ogg", "wma", "m4a", "aiff"];
  const code = ["js", "ts", "py", "java", "cpp", "c", "h", "cs", "rb", "go", "rs", "php", "html", "css", "json", "xml", "yaml", "yml", "sh", "bat"];

  const e = ext.toLowerCase();
  if (img.includes(e)) return "image";
  if (vid.includes(e)) return "video";
  if (doc.includes(e)) return "document";
  if (arch.includes(e)) return "archive";
  if (audio.includes(e)) return "audio";
  if (code.includes(e)) return "code";
  return "other";
}

function getFileTypeFromName(filename: string): string {
  const ext = path.extname(filename).replace(".", "").toLowerCase();
  return getFileType(ext);
}

function getArchiveCategory(filename: string): string {
  const f = filename.toLowerCase();
  if (f.includes("photo") || f.includes("pic") || f.includes("image") || f.includes("img")) return "Photo Archive";
  if (f.includes("video") || f.includes("movie") || f.includes("film") || f.includes("media")) return "Video Archive";
  if (f.includes("backup") || f.includes("bak")) return "Document Backup";
  if (f.includes("doc") || f.includes("report") || f.includes("work")) return "Document Backup";
  if (f.includes("software") || f.includes("install") || f.includes("setup") || f.includes("app")) return "Software";
  return "General";
}

function computeCategoryFromContent(entries: any[], isPasswordProtected: boolean): string {
  if (isPasswordProtected) return "Password Protected";
  const files = entries.filter((e: any) => !e.isDirectory);
  if (files.length === 0) return "Unknown";

  const counts: Record<string, number> = { image: 0, video: 0, document: 0, archive: 0, software: 0, other: 0 };
  for (const e of files) {
    const t = e.fileType ?? "other";
    counts[t] = (counts[t] || 0) + 1;
  }
  const total = files.length;
  if (counts.archive / total > 0.25) return "Nested Archives";
  if (counts.image / total > 0.55) return "Photo Archive";
  if (counts.video / total > 0.45) return "Video Archive";
  if (counts.document / total > 0.45) return "Document Backup";
  if (counts.software / total > 0.35) return "Software";
  const topType = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  if (counts[topType] / total < 0.4) return "Mixed";
  return "General";
}

function computeFileHash(filePath: string, fileSize: number): Promise<string | null> {
  if (fileSize > HASH_SIZE_LIMIT) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const hash = createHash("sha256");
      const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
      stream.on("data", (chunk: Buffer) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

async function peekZip(filePath: string): Promise<{ entries: any[]; isPasswordProtected: boolean }> {
  const entries: any[] = [];
  let isPasswordProtected = false;
  try {
    const zip = new AdmZip(filePath);
    for (const entry of zip.getEntries()) {
      const fileType = getFileTypeFromName(entry.entryName);
      entries.push({
        name: path.basename(entry.entryName),
        path: entry.entryName,
        sizeBytes: (entry.header as any)?.size ?? 0,
        isDirectory: entry.isDirectory,
        fileType,
      });
    }
  } catch {
    isPasswordProtected = true;
  }
  return { entries, isPasswordProtected };
}

async function peekTar(filePath: string, rawExt: string): Promise<{ entries: any[] }> {
  const entries: any[] = [];
  try {
    await tar.list({
      file: filePath,
      ...(["gz", "tgz", "bz2", "tbz2", "xz", "txz"].includes(rawExt) ? { gzip: rawExt === "gz" || rawExt === "tgz" } : {}),
      onentry: (entry: any) => {
        entries.push({
          name: path.basename(entry.path),
          path: entry.path,
          sizeBytes: typeof entry.size === "number" ? entry.size : 0,
          isDirectory: entry.type === "Directory",
          fileType: getFileTypeFromName(entry.path),
        });
      },
    });
  } catch { /* plain .gz or corrupt */ }
  return { entries };
}

async function peek7z(filePath: string): Promise<{ entries: any[]; isPasswordProtected: boolean }> {
  const entries: any[] = [];
  let isPasswordProtected = false;
  return new Promise((resolve) => {
    const stream = Seven.list(filePath, { $bin: path7za, $progress: false } as any);
    stream.on("data", (data: any) => {
      if (data.file !== undefined) {
        const isDir = typeof data.attributes === "string" && data.attributes[0] === "D";
        entries.push({
          name: path.basename(data.file),
          path: data.file,
          sizeBytes: typeof data.size === "number" ? data.size : 0,
          isDirectory: isDir,
          fileType: isDir ? "directory" : getFileTypeFromName(data.file),
        });
      }
    });
    stream.on("end", () => resolve({ entries, isPasswordProtected }));
    stream.on("error", (err: Error) => {
      if (/password|wrong password|encrypted/i.test(err?.message ?? "")) isPasswordProtected = true;
      resolve({ entries, isPasswordProtected });
    });
  });
}

async function peekArchiveFile(archivePath: string, filename: string): Promise<{
  entries: any[];
  isPasswordProtected: boolean;
  hasNestedArchives: boolean;
  estimatedExtractionSize: number;
  category: string;
}> {
  const rawExt = path.extname(filename).replace(".", "").toLowerCase();
  const ext = filename.toLowerCase().endsWith(".tar.gz") ? "tar.gz"
    : filename.toLowerCase().endsWith(".tar.bz2") ? "tar.bz2"
    : filename.toLowerCase().endsWith(".tar.xz") ? "tar.xz"
    : rawExt;

  let entries: any[] = [];
  let isPasswordProtected = false;

  if (ZIP_EXTS.has(ext)) {
    const result = await peekZip(archivePath);
    entries = result.entries;
    isPasswordProtected = result.isPasswordProtected;
  } else if (TAR_EXTS.has(ext)) {
    const result = await peekTar(archivePath, rawExt);
    entries = result.entries;
  } else if (SEVENZIP_EXTS.has(ext)) {
    const result = await peek7z(archivePath);
    entries = result.entries;
    isPasswordProtected = result.isPasswordProtected;
  }

  const hasNestedArchives = entries.some((e: any) => {
    const ne = path.extname(e.path).replace(".", "").toLowerCase();
    return ARCHIVE_EXTS.has(ne);
  });
  const estimatedExtractionSize = entries.reduce((s: number, e: any) => s + (e.sizeBytes ?? 0), 0);
  const category = computeCategoryFromContent(entries, isPasswordProtected);

  return { entries, isPasswordProtected, hasNestedArchives, estimatedExtractionSize, category };
}

async function scanDirectory(dirPath: string, jobId: number) {
  const batchSize = 50;
  const fileBatch: any[] = [];
  const archiveBatch: any[] = [];
  let filesScanned = 0;

  async function flushFiles() {
    if (fileBatch.length === 0) return;
    await db.insert(indexedFilesTable).values([...fileBatch]).onConflictDoUpdate({
      target: indexedFilesTable.path,
      set: {
        sizeBytes: sql`excluded.size_bytes`,
        modifiedAt: sql`excluded.modified_at`,
        fileType: sql`excluded.file_type`,
        contentHash: sql`excluded.content_hash`,
        indexedAt: sql`NOW()`,
      },
    });
    fileBatch.length = 0;
  }

  async function flushArchives() {
    if (archiveBatch.length === 0) return;
    await db.insert(archivesTable).values([...archiveBatch]).onConflictDoUpdate({
      target: archivesTable.path,
      set: {
        sizeBytes: sql`excluded.size_bytes`,
        modifiedAt: sql`excluded.modified_at`,
        category: sql`excluded.category`,
        indexedAt: sql`NOW()`,
      },
    });
    archiveBatch.length = 0;
  }

  async function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          continue;
        }

        const ext = path.extname(entry.name).replace(".", "").toLowerCase();
        const fileType = getFileType(ext);
        const folder = path.dirname(fullPath);
        filesScanned++;

        // Images and videos are managed by Immich — skip local indexing to avoid duplication
        if (IMMICH_TYPES.has(fileType)) {
          if (fileType === "archive") {
            archiveBatch.push({
              path: fullPath,
              filename: entry.name,
              sizeBytes: stat.size,
              modifiedAt: stat.mtime,
              folder,
              category: getArchiveCategory(entry.name),
              peekStatus: "pending",
            });
          }
          continue;
        }

        // Hash only non-media files (docs, archives, audio, code, etc.)
        const contentHash = await computeFileHash(fullPath, stat.size);

        fileBatch.push({
          path: fullPath,
          filename: entry.name,
          extension: ext,
          fileType,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime,
          folder,
          source: "local",
          contentHash,
        });

        if (fileType === "archive") {
          archiveBatch.push({
            path: fullPath,
            filename: entry.name,
            sizeBytes: stat.size,
            modifiedAt: stat.mtime,
            folder,
            category: getArchiveCategory(entry.name),
            peekStatus: "pending",
          });
        }

        if (fileBatch.length >= batchSize) {
          await flushFiles();
          await db.update(scanJobsTable).set({ filesScanned, stage: `Scanning ${folder}` }).where(eq(scanJobsTable.id, jobId));
        }
        if (archiveBatch.length >= batchSize) {
          await flushArchives();
        }
      }
    }
  }

  await walk(dirPath);
  await flushFiles();
  await flushArchives();
  return filesScanned;
}

async function peekAllArchives(jobId: number) {
  // Peek all pending archives discovered during this scan, in batches
  const pending = await db.select({ id: archivesTable.id, path: archivesTable.path, filename: archivesTable.filename })
    .from(archivesTable)
    .where(eq(archivesTable.peekStatus, "pending"));

  let peeked = 0;
  for (const archive of pending) {
    if (!fs.existsSync(archive.path)) {
      await db.update(archivesTable).set({ peekStatus: "unsupported" }).where(eq(archivesTable.id, archive.id));
      peeked++;
      continue;
    }
    try {
      const { entries, isPasswordProtected, hasNestedArchives, estimatedExtractionSize, category } =
        await peekArchiveFile(archive.path, archive.filename);
      await db.update(archivesTable).set({
        peekStatus: "peeked",
        containedFileCount: entries.length,
        isPasswordProtected,
        hasNestedArchives,
        estimatedExtractionSize,
        peekEntries: entries,
        category,
      }).where(eq(archivesTable.id, archive.id));
    } catch {
      // Non-fatal: leave as pending so user can retry manually
    }
    peeked++;
    if (peeked % 5 === 0) {
      await db.update(scanJobsTable).set({ stage: `Peeking archives (${peeked}/${pending.length})` }).where(eq(scanJobsTable.id, jobId));
    }
  }
}

async function runScan(jobId: number, nasPath: string) {
  try {
    await db.update(scanJobsTable).set({ status: "running", stage: "Initializing", startedAt: new Date() }).where(eq(scanJobsTable.id, jobId));

    if (!nasPath || !fs.existsSync(nasPath)) {
      await db.update(scanJobsTable).set({ status: "failed", error: `NAS path not accessible: ${nasPath}`, finishedAt: new Date() }).where(eq(scanJobsTable.id, jobId));
      return;
    }

    const filesScanned = await scanDirectory(nasPath, jobId);

    await db.update(scanJobsTable).set({ stage: "Peeking archives…", filesScanned }).where(eq(scanJobsTable.id, jobId));
    await peekAllArchives(jobId);

    await db.update(appSettingsTable).set({ lastScanAt: new Date(), totalFilesIndexed: filesScanned });
    await db.update(scanJobsTable).set({ status: "completed", filesScanned, stage: "Complete", finishedAt: new Date() }).where(eq(scanJobsTable.id, jobId));
  } catch (err) {
    await db.update(scanJobsTable).set({
      status: "failed",
      error: err instanceof Error ? err.message : "Unknown error",
      finishedAt: new Date(),
    }).where(eq(scanJobsTable.id, jobId));
  } finally {
    currentScanJobId = null;
  }
}

router.post("/scan", async (_req, res) => {
  try {
    if (currentScanJobId !== null) {
      const existing = await db.select().from(scanJobsTable).where(eq(scanJobsTable.id, currentScanJobId)).limit(1);
      if (existing.length > 0 && existing[0].status === "running") {
        res.status(202).json(existing[0]);
        return;
      }
    }

    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const nasPath = settingsRows.length > 0 ? settingsRows[0].nasPath : "";

    const [job] = await db.insert(scanJobsTable).values({
      status: "running",
      filesScanned: 0,
      stage: "Starting",
      startedAt: new Date(),
    }).returning();

    currentScanJobId = job.id;

    runScan(job.id, nasPath).catch(() => { currentScanJobId = null; });

    res.status(202).json(job);
  } catch {
    res.status(500).json({ error: "Failed to start scan" });
  }
});

router.get("/scan/status", async (_req, res) => {
  try {
    const running = currentScanJobId
      ? await db.select().from(scanJobsTable).where(eq(scanJobsTable.id, currentScanJobId)).limit(1)
      : [];

    const completed = await db.select().from(scanJobsTable)
      .where(eq(scanJobsTable.status, "completed"))
      .orderBy(desc(scanJobsTable.finishedAt))
      .limit(1);

    res.json({
      isRunning: running.length > 0 && running[0].status === "running",
      current: running.length > 0 ? running[0] : null,
      lastCompleted: completed.length > 0 ? completed[0] : null,
    });
  } catch {
    res.status(500).json({ error: "Failed to get scan status" });
  }
});

router.get("/scan/history", async (_req, res) => {
  try {
    const jobs = await db.select().from(scanJobsTable).orderBy(desc(scanJobsTable.startedAt)).limit(20);
    res.json(jobs);
  } catch {
    res.status(500).json({ error: "Failed to get scan history" });
  }
});

export default router;
