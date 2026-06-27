import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { organizationJobsTable, archivesTable, appSettingsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import AdmZip from "adm-zip";
import * as tar from "tar";
import Seven from "node-7z";
import { path7za } from "7zip-bin";
import { openai } from "@workspace/integrations-openai-ai-server";
import { getWillardAIDir, getTempDir, cleanTempDir } from "../lib/nas-storage";

const router: IRouter = Router();

const ZIP_EXTS = new Set(["zip"]);
const TAR_EXTS = new Set(["tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz", "tar.gz", "tar.bz2", "tar.xz"]);
const SEVENZIP_EXTS = new Set(["rar", "7z", "cab", "iso"]);

function getArchiveExt(filename: string): string {
  const rawExt = path.extname(filename).replace(".", "").toLowerCase();
  if (filename.toLowerCase().endsWith(".tar.gz")) return "tar.gz";
  if (filename.toLowerCase().endsWith(".tar.bz2")) return "tar.bz2";
  if (filename.toLowerCase().endsWith(".tar.xz")) return "tar.xz";
  return rawExt;
}

function getFileType(ext: string): string {
  const img = ["jpg","jpeg","png","gif","bmp","webp","heic","heif","tiff","raw","cr2","nef","arw"];
  const vid = ["mp4","mkv","avi","mov","wmv","flv","m4v","webm","mpeg","mpg","3gp"];
  const doc = ["pdf","doc","docx","xls","xlsx","ppt","pptx","odt","ods","odp","txt","rtf","pages","numbers","key"];
  const audio = ["mp3","flac","wav","aac","ogg","wma","m4a","aiff"];
  const code = ["js","ts","py","java","cpp","c","h","cs","rb","go","rs","php","html","css","json","xml","yaml","yml","sh","bat"];
  const e = ext.toLowerCase();
  if (img.includes(e)) return "image";
  if (vid.includes(e)) return "video";
  if (doc.includes(e)) return "document";
  if (audio.includes(e)) return "audio";
  if (code.includes(e)) return "code";
  return "other";
}

function getFileTypeFromName(filename: string): string {
  return getFileType(path.extname(filename).replace(".", "").toLowerCase());
}

function routeDestination(fileType: string, settings: any, nasPath: string): string {
  const base = (key: string, fallback: string) =>
    settings?.[key] && settings[key].trim() ? settings[key].trim() : path.join(nasPath, fallback);
  switch (fileType) {
    case "image":    return base("photosDestination", "Photos");
    case "video":    return base("videosDestination", "Videos");
    case "document": return base("documentsDestination", "Documents");
    default:         return base("otherFilesDestination", "Files");
  }
}

function getDiskFreeBytes(dirPath: string): number | null {
  try {
    const checkDir = fs.existsSync(dirPath) ? dirPath : path.dirname(dirPath);
    const out = execSync(`df -B1 "${checkDir}" 2>/dev/null | awk 'NR==2{print $4}'`).toString().trim();
    const n = parseInt(out);
    return isNaN(n) ? null : n;
  } catch { return null; }
}

function moveFile(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err: any) {
    if (err.code === "EXDEV") {
      fs.copyFileSync(from, to);
      fs.unlinkSync(from);
    } else { throw err; }
  }
}

async function peekArchiveEntries(archivePath: string, filename: string): Promise<Array<{path: string; sizeBytes: number; isDirectory: boolean; fileType: string}>> {
  const ext = getArchiveExt(filename);
  const rawExt = path.extname(filename).replace(".", "").toLowerCase();
  const entries: Array<{path: string; sizeBytes: number; isDirectory: boolean; fileType: string}> = [];

  if (ZIP_EXTS.has(ext)) {
    try {
      const zip = new AdmZip(archivePath);
      for (const e of zip.getEntries()) {
        entries.push({
          path: e.entryName,
          sizeBytes: (e.header as any)?.size ?? 0,
          isDirectory: e.isDirectory,
          fileType: getFileTypeFromName(e.entryName),
        });
      }
    } catch { /* password protected or corrupt */ }
  } else if (TAR_EXTS.has(ext)) {
    try {
      await tar.list({
        file: archivePath,
        ...(["gz","tgz","bz2","tbz2","xz","txz"].includes(rawExt) ? { gzip: rawExt === "gz" || rawExt === "tgz" } : {}),
        onentry: (entry: any) => {
          entries.push({
            path: entry.path,
            sizeBytes: typeof entry.size === "number" ? entry.size : 0,
            isDirectory: entry.type === "Directory",
            fileType: getFileTypeFromName(entry.path),
          });
        },
      });
    } catch { /* plain gz or corrupt */ }
  } else if (SEVENZIP_EXTS.has(ext)) {
    await new Promise<void>((resolve) => {
      const s = Seven.list(archivePath, { $bin: path7za, $progress: false } as any);
      s.on("data", (d: any) => {
        if (d.file !== undefined) {
          const isDir = typeof d.attributes === "string" && d.attributes[0] === "D";
          entries.push({
            path: d.file,
            sizeBytes: typeof d.size === "number" ? d.size : 0,
            isDirectory: isDir,
            fileType: isDir ? "directory" : getFileTypeFromName(d.file),
          });
        }
      });
      s.on("end", resolve);
      s.on("error", () => resolve());
    });
  }
  return entries;
}

async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  const filename = path.basename(archivePath);
  const ext = getArchiveExt(filename);
  const rawExt = path.extname(filename).replace(".", "").toLowerCase();
  fs.mkdirSync(destDir, { recursive: true });

  if (ZIP_EXTS.has(ext)) {
    const zip = new AdmZip(archivePath);
    zip.extractAllTo(destDir, true);
  } else if (TAR_EXTS.has(ext)) {
    await tar.extract({ file: archivePath, cwd: destDir, keep: true } as any);
  } else if (SEVENZIP_EXTS.has(ext)) {
    await new Promise<void>((resolve, reject) => {
      const s = Seven.extractFull(archivePath, destDir, {
        $bin: path7za,
        overwrite: "qs",
        $progress: false,
      } as any);
      s.on("end", resolve);
      s.on("error", reject);
    });
  } else {
    throw new Error(`Unsupported archive format: .${ext}`);
  }
}

function walkDir(dirPath: string): Array<{fullPath: string; relativePath: string; sizeBytes: number; fileType: string}> {
  const results: Array<{fullPath: string; relativePath: string; sizeBytes: number; fileType: string}> = [];
  function walk(dir: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); }
      else if (e.isFile()) {
        let stat: fs.Stats;
        try { stat = fs.statSync(full); } catch { continue; }
        const rel = path.relative(dirPath, full);
        const ext = path.extname(e.name).replace(".", "").toLowerCase();
        results.push({ fullPath: full, relativePath: rel, sizeBytes: stat.size, fileType: getFileType(ext) });
      }
    }
  }
  walk(dirPath);
  return results;
}

async function callAiConfidence(planSummary: object): Promise<{ confidence: number; notes: string } | null> {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: 'You are a file organization assistant. Given a file organization plan summary, assess how well-matched the routing is for each file type. Return ONLY valid JSON: {"confidence": <number 0-1>, "notes": "<one sentence>"}.',
        },
        { role: "user", content: JSON.stringify(planSummary) },
      ],
      response_format: { type: "json_object" },
      max_tokens: 150,
    });
    const raw = JSON.parse(completion.choices[0]?.message?.content ?? "{}");
    return {
      confidence: typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0.5,
      notes: typeof raw.notes === "string" ? raw.notes : "Unable to assess",
    };
  } catch { return null; }
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.post("/organize/jobs", async (req, res) => {
  try {
    const { sourceType, sourcePath, archiveId, archiveDisposition = "keep" } = req.body as any;
    if (!sourceType || !["archive","folder"].includes(sourceType)) {
      res.status(400).json({ error: "sourceType must be 'archive' or 'folder'" });
      return;
    }
    if (!sourcePath || typeof sourcePath !== "string") {
      res.status(400).json({ error: "sourcePath is required" });
      return;
    }
    const [job] = await db.insert(organizationJobsTable).values({
      sourceType,
      sourcePath,
      archiveId: archiveId ?? null,
      archiveDisposition,
    }).returning();
    res.status(201).json(job);
  } catch {
    res.status(500).json({ error: "Failed to create organize job" });
  }
});

router.get("/organize/jobs", async (_req, res) => {
  try {
    const jobs = await db.select().from(organizationJobsTable).orderBy(desc(organizationJobsTable.createdAt)).limit(50);
    res.json(jobs);
  } catch {
    res.status(500).json({ error: "Failed to list organize jobs" });
  }
});

router.get("/organize/jobs/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [job] = await db.select().from(organizationJobsTable).where(eq(organizationJobsTable.id, id)).limit(1);
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    res.json(job);
  } catch {
    res.status(500).json({ error: "Failed to get organize job" });
  }
});

router.delete("/organize/jobs/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [job] = await db.select().from(organizationJobsTable).where(eq(organizationJobsTable.id, id)).limit(1);
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    if (job.status === "executing") {
      res.status(409).json({ error: "Cannot delete a job that is currently executing" });
      return;
    }
    await db.delete(organizationJobsTable).where(eq(organizationJobsTable.id, id));
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to delete organize job" });
  }
});

router.post("/organize/jobs/:id/analyze", async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const [job] = await db.select().from(organizationJobsTable).where(eq(organizationJobsTable.id, id)).limit(1);
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    if (job.status === "executing") { res.status(409).json({ error: "Job is currently executing" }); return; }

    await db.update(organizationJobsTable).set({ status: "analyzing" }).where(eq(organizationJobsTable.id, id));

    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const settings = settingsRows[0] ?? {};
    const nasPath = (settings as any).nasPath ?? "";

    let entries: Array<{path: string; sizeBytes: number; isDirectory: boolean; fileType: string}> = [];

    if (job.sourceType === "archive") {
      if (!fs.existsSync(job.sourcePath)) {
        await db.update(organizationJobsTable).set({ status: "failed", error: "Archive file not found" }).where(eq(organizationJobsTable.id, id));
        res.status(422).json({ error: "Archive file not found on disk" });
        return;
      }
      if (job.archiveId) {
        const [arc] = await db.select().from(archivesTable).where(eq(archivesTable.id, job.archiveId)).limit(1);
        if (arc?.peekStatus === "peeked" && Array.isArray(arc.peekEntries) && (arc.peekEntries as any[]).length > 0) {
          entries = (arc.peekEntries as any[]).map((e: any) => ({
            path: e.path ?? e.name ?? "",
            sizeBytes: e.sizeBytes ?? 0,
            isDirectory: e.isDirectory ?? false,
            fileType: e.fileType ?? "other",
          }));
        }
      }
      if (entries.length === 0) {
        entries = await peekArchiveEntries(job.sourcePath, path.basename(job.sourcePath));
      }
    } else {
      if (!fs.existsSync(job.sourcePath)) {
        await db.update(organizationJobsTable).set({ status: "failed", error: "Source folder not found" }).where(eq(organizationJobsTable.id, id));
        res.status(422).json({ error: "Source folder not found on disk" });
        return;
      }
      const walked = walkDir(job.sourcePath);
      entries = walked.map(w => ({ path: w.relativePath, sizeBytes: w.sizeBytes, isDirectory: false, fileType: w.fileType }));
    }

    const fileEntries = entries.filter(e => !e.isDirectory);
    const summary = { images: 0, videos: 0, documents: 0, other: 0 };
    const routes: any[] = [];

    for (const e of fileEntries) {
      const ft = e.fileType === "image" ? "image" : e.fileType === "video" ? "video" : e.fileType === "document" ? "document" : "other";
      summary[ft === "image" ? "images" : ft === "video" ? "videos" : ft === "document" ? "documents" : "other"]++;
      const dest = routeDestination(ft, settings, nasPath);
      routes.push({
        relativePath: e.path,
        filename: path.basename(e.path),
        fileType: ft,
        sizeBytes: e.sizeBytes,
        destination: dest,
      });
    }

    const totalSizeBytes = fileEntries.reduce((s, e) => s + (e.sizeBytes ?? 0), 0);
    const destinations = {
      images: routeDestination("image", settings, nasPath),
      videos: routeDestination("video", settings, nasPath),
      documents: routeDestination("document", settings, nasPath),
      other: routeDestination("other", settings, nasPath),
    };

    const aiResult = await callAiConfidence({ totalFiles: fileEntries.length, summary, destinations });

    const planJson: any = {
      sourceType: job.sourceType,
      sourcePath: job.sourcePath,
      totalFiles: fileEntries.length,
      totalSizeBytes,
      routes,
      summary,
      destinations,
      archiveDisposition: job.archiveDisposition,
      aiConfidence: aiResult?.confidence ?? null,
      aiNotes: aiResult?.notes ?? null,
    };

    const [updated] = await db.update(organizationJobsTable)
      .set({ status: "planned", planJson })
      .where(eq(organizationJobsTable.id, id))
      .returning();
    res.json(updated);
  } catch (err) {
    await db.update(organizationJobsTable)
      .set({ status: "failed", error: err instanceof Error ? err.message : "Unknown error" })
      .where(eq(organizationJobsTable.id, id))
      .catch(() => {});
    res.status(500).json({ error: "Analysis failed" });
  }
});

router.post("/organize/jobs/:id/preflight", async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const [job] = await db.select().from(organizationJobsTable).where(eq(organizationJobsTable.id, id)).limit(1);
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    if (!job.planJson) { res.status(422).json({ error: "Run analyze first" }); return; }
    if (job.status === "executing") { res.status(409).json({ error: "Job is currently executing" }); return; }

    const plan = job.planJson as any;
    const checks: any[] = [];

    // 1. Source accessible
    const sourceOk = fs.existsSync(job.sourcePath);
    checks.push({ name: "Source accessible", ok: sourceOk, detail: sourceOk ? `Found at ${job.sourcePath}` : `Not found: ${job.sourcePath}` });

    // 2. Destinations writable
    const uniqueDests = [...new Set<string>(plan.routes?.map((r: any) => r.destination) ?? [])];
    let destOk = true;
    let destDetail = "All destinations writable";
    const destIssues: string[] = [];
    for (const dest of uniqueDests) {
      try {
        fs.mkdirSync(dest, { recursive: true });
        const testFile = path.join(dest, `.willard_write_test_${Date.now()}`);
        fs.writeFileSync(testFile, "");
        fs.unlinkSync(testFile);
      } catch (e: any) {
        destOk = false;
        destIssues.push(`${dest}: ${e.message}`);
      }
    }
    if (!destOk) destDetail = `Unwritable: ${destIssues.join("; ")}`;
    checks.push({ name: "Destinations writable", ok: destOk, detail: destDetail });

    // 3. Disk space
    const totalBytes = plan.totalSizeBytes ?? 0;
    let diskOk = true;
    let diskDetail = "Disk space check unavailable";
    if (uniqueDests.length > 0) {
      const free = getDiskFreeBytes(uniqueDests[0]);
      if (free !== null) {
        diskOk = free >= totalBytes;
        diskDetail = diskOk
          ? `Need ${(totalBytes / 1e9).toFixed(2)} GB, ${(free / 1e9).toFixed(2)} GB free`
          : `Need ${(totalBytes / 1e9).toFixed(2)} GB but only ${(free / 1e9).toFixed(2)} GB free`;
      }
    }
    checks.push({ name: "Disk space", ok: diskOk, detail: diskDetail });

    // 4. Collision detection
    let collisionCount = 0;
    for (const route of (plan.routes ?? []) as any[]) {
      const destFile = path.join(route.destination, route.filename);
      if (fs.existsSync(destFile)) collisionCount++;
    }
    const collisionOk = collisionCount === 0;
    checks.push({
      name: "File collisions",
      ok: collisionOk,
      warning: !collisionOk,
      detail: collisionOk ? "No filename conflicts" : `${collisionCount} file${collisionCount !== 1 ? "s" : ""} already exist — will be skipped`,
    });

    const allOk = checks.every(c => c.ok || c.warning);
    const preflightJson = { ok: allOk, checks, diskSpaceRequiredBytes: totalBytes, collisionCount };
    const [updated] = await db.update(organizationJobsTable)
      .set({ status: allOk ? "verified" : "planned", preflightJson })
      .where(eq(organizationJobsTable.id, id))
      .returning();
    res.json(updated);
  } catch {
    res.status(500).json({ error: "Preflight check failed" });
  }
});

router.get("/organize/jobs/:id/execute", async (req, res) => {
  const id = parseInt(req.params.id);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (event: string, data: object) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const tempDirs: string[] = [];
  const fileMoves: Array<{from: string; to: string}> = [];

  try {
    const [job] = await db.select().from(organizationJobsTable).where(eq(organizationJobsTable.id, id)).limit(1);
    if (!job) { send("error", { message: "Job not found" }); res.end(); return; }
    if (job.status === "executing") { send("error", { message: "Job is already executing" }); res.end(); return; }
    if (!job.planJson) { send("error", { message: "Run analyze first" }); res.end(); return; }

    const plan = job.planJson as any;
    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const nasPath = (settingsRows[0] as any)?.nasPath ?? "";

    await db.update(organizationJobsTable).set({ status: "executing" }).where(eq(organizationJobsTable.id, id));
    send("status", { stage: "staging", message: "Creating staging directory…", progress: 0 });

    const tempDir = getTempDir(nasPath, `org-${id}`);
    tempDirs.push(tempDir);
    fs.mkdirSync(tempDir, { recursive: true });

    let sourceFiles: Array<{fullPath: string; relativePath: string; fileType: string; sizeBytes: number}> = [];

    if (job.sourceType === "archive") {
      send("status", { stage: "extracting", message: "Extracting archive…", progress: 5 });
      if (!fs.existsSync(job.sourcePath)) throw new Error(`Archive not found: ${job.sourcePath}`);
      await extractArchive(job.sourcePath, tempDir);
      send("status", { stage: "extracting", message: "Extraction complete, scanning files…", progress: 30 });
      const walked = walkDir(tempDir);
      sourceFiles = walked.map(w => ({ fullPath: w.fullPath, relativePath: w.relativePath, fileType: w.fileType, sizeBytes: w.sizeBytes }));
    } else {
      if (!fs.existsSync(job.sourcePath)) throw new Error(`Source folder not found: ${job.sourcePath}`);
      const walked = walkDir(job.sourcePath);
      sourceFiles = walked.map(w => ({ fullPath: w.fullPath, relativePath: w.relativePath, fileType: w.fileType, sizeBytes: w.sizeBytes }));
      send("status", { stage: "staging", message: `Found ${sourceFiles.length} files`, progress: 15 });
    }

    const total = sourceFiles.length;
    let moved = 0;
    let skipped = 0;

    send("status", { stage: "moving", message: `Moving ${total} files to destinations…`, progress: 35, total });

    for (let i = 0; i < sourceFiles.length; i++) {
      const sf = sourceFiles[i];
      const ft = sf.fileType === "image" ? "image" : sf.fileType === "video" ? "video" : sf.fileType === "document" ? "document" : "other";
      const destDir = routeDestination(ft, settingsRows[0], nasPath);
      const destFile = path.join(destDir, path.basename(sf.relativePath));

      if (fs.existsSync(destFile)) {
        skipped++;
        send("progress", { index: i + 1, total, filename: path.basename(sf.relativePath), action: "skipped" });
        continue;
      }

      moveFile(sf.fullPath, destFile);
      fileMoves.push({ from: sf.fullPath, to: destFile });
      moved++;

      if ((i + 1) % 5 === 0 || i === sourceFiles.length - 1) {
        const pct = 35 + Math.round(((i + 1) / total) * 55);
        send("progress", { index: i + 1, total, filename: path.basename(sf.relativePath), moved, skipped, progress: pct });
      }
    }

    send("status", { stage: "verifying", message: "Verifying moved files…", progress: 91 });

    let verified = 0;
    for (const mv of fileMoves) {
      if (fs.existsSync(mv.to)) verified++;
    }

    send("status", { stage: "archive_disposition", message: `Handling archive (${job.archiveDisposition})…`, progress: 94 });

    if (job.sourceType === "archive" && job.archiveDisposition !== "keep") {
      if (job.archiveDisposition === "delete") {
        try { fs.unlinkSync(job.sourcePath); } catch { /* non-fatal */ }
      } else if (job.archiveDisposition === "move_to_processed") {
        const processedDir = path.join(getWillardAIDir(nasPath), "archive-index", "processed");
        fs.mkdirSync(processedDir, { recursive: true });
        const dest = path.join(processedDir, path.basename(job.sourcePath));
        try { moveFile(job.sourcePath, dest); } catch { /* non-fatal */ }
      }
    }

    send("status", { stage: "report", message: "Writing report…", progress: 97 });

    const completedAt = new Date();
    const report = {
      jobId: id,
      completedAt: completedAt.toISOString(),
      sourceType: job.sourceType,
      sourcePath: job.sourcePath,
      archiveDisposition: job.archiveDisposition,
      filesFound: total,
      filesMoved: moved,
      filesSkipped: skipped,
      filesVerified: verified,
      destinations: plan.destinations,
      aiConfidence: plan.aiConfidence,
      aiNotes: plan.aiNotes,
    };

    let reportPath = "";
    try {
      const reportsDir = path.join(getWillardAIDir(nasPath), "reports");
      fs.mkdirSync(reportsDir, { recursive: true });
      reportPath = path.join(reportsDir, `org-job-${id}.json`);
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    } catch { /* non-fatal */ }

    await db.update(organizationJobsTable).set({
      status: "completed",
      fileMoves: fileMoves as any,
      reportPath: reportPath || null,
      completedAt,
    }).where(eq(organizationJobsTable.id, id));

    send("complete", { ...report, progress: 100 });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    send("status", { stage: "rolling_back", message: "Error — rolling back moves…", progress: -1 });

    let rolledBack = 0;
    for (const mv of [...fileMoves].reverse()) {
      try {
        if (fs.existsSync(mv.to)) {
          moveFile(mv.to, mv.from);
          rolledBack++;
        }
      } catch { /* best-effort */ }
    }

    await db.update(organizationJobsTable).set({
      status: "rolled_back",
      error: errMsg,
      fileMoves: fileMoves as any,
      completedAt: new Date(),
    }).where(eq(organizationJobsTable.id, id)).catch(() => {});

    send("error", { message: errMsg, rolledBack });
  } finally {
    for (const td of tempDirs) {
      cleanTempDir(td);
    }
    res.end();
  }
});

export default router;
