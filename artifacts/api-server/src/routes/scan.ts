import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { scanJobsTable, indexedFilesTable, archivesTable, appSettingsTable } from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

const router: IRouter = Router();

let currentScanJobId: number | null = null;

const HASH_SIZE_LIMIT = 500 * 1024 * 1024; // 500MB - skip hashing larger files

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

function getArchiveCategory(filename: string): string {
  const f = filename.toLowerCase();
  if (f.includes("photo") || f.includes("pic") || f.includes("image")) return "photos";
  if (f.includes("video") || f.includes("movie") || f.includes("film")) return "videos";
  if (f.includes("backup") || f.includes("bak")) return "backups";
  if (f.includes("doc") || f.includes("report") || f.includes("work")) return "documents";
  return "general";
}

function computeFileHash(filePath: string, fileSize: number): string | null {
  if (fileSize > HASH_SIZE_LIMIT) return null;
  try {
    const hash = createHash("sha256");
    const buf = fs.readFileSync(filePath);
    hash.update(buf);
    return hash.digest("hex");
  } catch {
    return null;
  }
}

async function scanDirectory(dirPath: string, jobId: number) {
  const batchSize = 50;
  const fileBatch: any[] = [];
  const archiveBatch: any[] = [];
  let filesScanned = 0;

  async function flushFiles() {
    if (fileBatch.length === 0) return;
    // Use sql`excluded.*` references for correct per-row updates
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
        const contentHash = computeFileHash(fullPath, stat.size);

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
        filesScanned++;

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

async function runScan(jobId: number, nasPath: string) {
  try {
    await db.update(scanJobsTable).set({ status: "running", stage: "Initializing", startedAt: new Date() }).where(eq(scanJobsTable.id, jobId));

    if (!nasPath || !fs.existsSync(nasPath)) {
      await db.update(scanJobsTable).set({ status: "failed", error: `NAS path not accessible: ${nasPath}`, finishedAt: new Date() }).where(eq(scanJobsTable.id, jobId));
      return;
    }

    const filesScanned = await scanDirectory(nasPath, jobId);

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
