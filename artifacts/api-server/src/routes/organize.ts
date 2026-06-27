import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { organizationJobsTable, archivesTable, appSettingsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { spawnSync } from "child_process";
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

// ── Helpers ────────────────────────────────────────────────────────────────

function getArchiveExt(filename: string): string {
  const fn = filename.toLowerCase();
  if (fn.endsWith(".tar.gz"))  return "tar.gz";
  if (fn.endsWith(".tar.bz2")) return "tar.bz2";
  if (fn.endsWith(".tar.xz"))  return "tar.xz";
  return path.extname(filename).replace(".", "").toLowerCase();
}

function getFileType(ext: string): string {
  const img   = ["jpg","jpeg","png","gif","bmp","webp","heic","heif","tiff","raw","cr2","nef","arw","dng"];
  const vid   = ["mp4","mkv","avi","mov","wmv","flv","m4v","webm","mpeg","mpg","3gp"];
  const doc   = ["pdf","doc","docx","xls","xlsx","ppt","pptx","odt","ods","odp","txt","rtf","pages","numbers","key","epub","md"];
  const audio = ["mp3","flac","wav","aac","ogg","wma","m4a","aiff"];
  const e = ext.toLowerCase();
  if (img.includes(e))   return "image";
  if (vid.includes(e))   return "video";
  if (doc.includes(e))   return "document";
  if (audio.includes(e)) return "audio";
  return "other";
}

function getFileTypeFromName(filename: string): string {
  return getFileType(path.extname(filename).replace(".", "").toLowerCase());
}

function routeDestination(fileType: string, settings: any, nasPath: string): string {
  const base = (key: string, fallback: string) =>
    settings?.[key] && String(settings[key]).trim()
      ? String(settings[key]).trim()
      : path.join(nasPath, fallback);
  switch (fileType) {
    case "image":    return base("photosDestination",    "Photos");
    case "video":    return base("videosDestination",    "Videos");
    case "document": return base("documentsDestination", "Documents");
    default:         return base("otherFilesDestination", "Files");
  }
}

/** Safe disk-free check — uses spawnSync with argument array (no shell interpolation). */
function getDiskFreeBytes(dirPath: string): number | null {
  try {
    const checkDir = fs.existsSync(dirPath) ? dirPath : path.dirname(dirPath);
    const result = spawnSync("df", ["-B1", checkDir], { encoding: "utf8", stdio: "pipe" });
    if (result.status !== 0 || !result.stdout) return null;
    const lines = result.stdout.trim().split("\n");
    if (lines.length < 2) return null;
    const fields = lines[1].trim().split(/\s+/);
    const n = parseInt(fields[3] ?? "");
    return isNaN(n) ? null : n;
  } catch { return null; }
}

/** SHA-256 hash of a file using a streaming read (memory-safe for large files). */
async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("end",  () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/** Hash a file if it is ≤ HASH_LIMIT_BYTES; otherwise return a size-based sentinel. */
const HASH_LIMIT_BYTES = 100 * 1024 * 1024; // 100 MB
async function fileIntegrityToken(filePath: string): Promise<string> {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= HASH_LIMIT_BYTES) return await sha256File(filePath);
    return `size:${stat.size}`;
  } catch { return ""; }
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
        entries.push({ path: e.entryName, sizeBytes: (e.header as any)?.size ?? 0, isDirectory: e.isDirectory, fileType: getFileTypeFromName(e.entryName) });
      }
    } catch { /* password protected or corrupt */ }
  } else if (TAR_EXTS.has(ext)) {
    try {
      await tar.list({
        file: archivePath,
        ...(["gz","tgz","bz2","tbz2","xz","txz"].includes(rawExt) ? { gzip: rawExt === "gz" || rawExt === "tgz" } : {}),
        onentry: (entry: any) => {
          entries.push({ path: entry.path, sizeBytes: typeof entry.size === "number" ? entry.size : 0, isDirectory: entry.type === "Directory", fileType: getFileTypeFromName(entry.path) });
        },
      });
    } catch { /* plain gz or corrupt */ }
  } else if (SEVENZIP_EXTS.has(ext)) {
    await new Promise<void>((resolve) => {
      const s = Seven.list(archivePath, { $bin: path7za, $progress: false } as any);
      s.on("data", (d: any) => {
        if (d.file !== undefined) {
          const isDir = typeof d.attributes === "string" && d.attributes[0] === "D";
          entries.push({ path: d.file, sizeBytes: typeof d.size === "number" ? d.size : 0, isDirectory: isDir, fileType: isDir ? "directory" : getFileTypeFromName(d.file) });
        }
      });
      s.on("end",   resolve);
      s.on("error", () => resolve());
    });
  }
  return entries;
}

/** Try to read the archive's table of contents. Returns ok + entry count on success. */
async function validateArchive(archivePath: string): Promise<{ ok: boolean; detail: string; entryCount?: number }> {
  try {
    const ext = getArchiveExt(path.basename(archivePath));
    const rawExt = path.extname(archivePath).replace(".", "").toLowerCase();
    let entryCount = 0;

    if (ZIP_EXTS.has(ext)) {
      const zip = new AdmZip(archivePath);
      entryCount = zip.getEntries().length;
    } else if (TAR_EXTS.has(ext)) {
      await tar.list({
        file: archivePath,
        ...(["gz","tgz","bz2","tbz2","xz","txz"].includes(rawExt) ? { gzip: rawExt === "gz" || rawExt === "tgz" } : {}),
        onentry: () => { entryCount++; },
      });
    } else if (SEVENZIP_EXTS.has(ext)) {
      await new Promise<void>((resolve) => {
        const s = Seven.list(archivePath, { $bin: path7za, $progress: false } as any);
        s.on("data", () => entryCount++);
        s.on("end",   resolve);
        s.on("error", () => resolve());
      });
    } else {
      return { ok: false, detail: `Unsupported archive format: .${ext}` };
    }

    if (entryCount === 0) return { ok: false, detail: "Archive appears empty or unreadable (0 entries)" };
    return { ok: true, detail: `${entryCount} entries readable`, entryCount };
  } catch (e: any) {
    return { ok: false, detail: `Archive may be corrupt: ${e.message}` };
  }
}

async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  const filename = path.basename(archivePath);
  const ext = getArchiveExt(filename);
  fs.mkdirSync(destDir, { recursive: true });

  if (ZIP_EXTS.has(ext)) {
    const zip = new AdmZip(archivePath);
    zip.extractAllTo(destDir, true);
  } else if (TAR_EXTS.has(ext)) {
    await tar.extract({ file: archivePath, cwd: destDir, keep: true } as any);
  } else if (SEVENZIP_EXTS.has(ext)) {
    await new Promise<void>((resolve, reject) => {
      const s = Seven.extractFull(archivePath, destDir, { $bin: path7za, overwrite: "qs", $progress: false } as any);
      s.on("end",   resolve);
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
        { role: "system", content: 'You are a file organization assistant. Given a file plan summary, assess how well-matched the routing is. Return ONLY valid JSON: {"confidence": <number 0-1>, "notes": "<one sentence>"}.' },
        { role: "user",   content: JSON.stringify(planSummary) },
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

function isoTimestamp(): string {
  return new Date().toISOString().replace(/:/g, "-").replace(/\./g, "-").slice(0, 19);
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.post("/organize/jobs", async (req, res) => {
  try {
    const { sourceType, sourcePath, archiveId, archiveDisposition = "keep" } = req.body as any;
    if (!sourceType || !["archive","folder"].includes(sourceType)) {
      res.status(400).json({ error: "sourceType must be 'archive' or 'folder'" }); return;
    }
    if (!sourcePath || typeof sourcePath !== "string") {
      res.status(400).json({ error: "sourcePath is required" }); return;
    }
    const [job] = await db.insert(organizationJobsTable).values({
      sourceType, sourcePath, archiveId: archiveId ?? null, archiveDisposition,
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
      res.status(409).json({ error: "Cannot delete a job that is currently executing" }); return;
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
        res.status(422).json({ error: "Archive file not found on disk" }); return;
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
        res.status(422).json({ error: "Source folder not found on disk" }); return;
      }
      const walked = walkDir(job.sourcePath);
      entries = walked.map(w => ({ path: w.relativePath, sizeBytes: w.sizeBytes, isDirectory: false, fileType: w.fileType }));
    }

    const fileEntries = entries.filter(e => !e.isDirectory);
    const summary = { images: 0, videos: 0, documents: 0, other: 0 };
    const routes: any[] = [];

    for (const e of fileEntries) {
      const ft = e.fileType === "image" ? "image" : e.fileType === "video" ? "video" : e.fileType === "document" ? "document" : "other";
      (summary as any)[ft === "image" ? "images" : ft === "video" ? "videos" : ft === "document" ? "documents" : "other"]++;
      routes.push({
        relativePath: e.path,
        filename: path.basename(e.path),
        fileType: ft,
        sizeBytes: e.sizeBytes,
        destination: routeDestination(ft, settings, nasPath),
      });
    }

    const totalSizeBytes = fileEntries.reduce((s, e) => s + (e.sizeBytes ?? 0), 0);
    const destinations = {
      images:    routeDestination("image",    settings, nasPath),
      videos:    routeDestination("video",    settings, nasPath),
      documents: routeDestination("document", settings, nasPath),
      other:     routeDestination("other",    settings, nasPath),
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
    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const settings = settingsRows[0] as any ?? {};
    const checks: any[] = [];

    // 1. Source exists and is readable
    let sourceOk = false;
    let sourceDetail = `Not found: ${job.sourcePath}`;
    if (fs.existsSync(job.sourcePath)) {
      try {
        fs.accessSync(job.sourcePath, fs.constants.R_OK);
        const stat = fs.statSync(job.sourcePath);
        sourceOk = true;
        sourceDetail = job.sourceType === "archive"
          ? `Found (${(stat.size / 1e6).toFixed(1)} MB)`
          : `Found (${stat.isDirectory() ? "directory" : "file"})`;
      } catch {
        sourceDetail = `Exists but not readable: ${job.sourcePath}`;
      }
    }
    checks.push({ name: "Source accessible", ok: sourceOk, detail: sourceDetail });

    // 2. Archive integrity validation
    if (job.sourceType === "archive" && sourceOk) {
      const validation = await validateArchive(job.sourcePath);
      checks.push({ name: "Archive integrity", ok: validation.ok, detail: validation.detail });
    }

    // 3. Destinations writable — checked individually
    const uniqueDests = [...new Set<string>(
      (plan.routes ?? []).map((r: any) => r.destination).filter(Boolean)
    )];
    for (const dest of uniqueDests) {
      let destOk = false;
      let destDetail = "";
      try {
        fs.mkdirSync(dest, { recursive: true });
        const testFile = path.join(dest, `.willard_write_test_${Date.now()}`);
        fs.writeFileSync(testFile, "");
        fs.unlinkSync(testFile);
        destOk = true;
        destDetail = "Writable";
      } catch (e: any) {
        destDetail = e.message;
      }
      checks.push({ name: `Writable: ${path.basename(dest)}`, ok: destOk, detail: destDetail || dest });
    }

    // 4. Disk space — checked per unique filesystem (by destination path)
    const totalBytes = plan.totalSizeBytes ?? 0;
    const seenFilesystems = new Set<string>();
    for (const dest of uniqueDests) {
      const checkDir = fs.existsSync(dest) ? dest : path.dirname(dest);
      // Use real path to detect same filesystem
      let fsKey = checkDir;
      try { fsKey = fs.realpathSync(checkDir); } catch { /* best effort */ }
      if (seenFilesystems.has(fsKey)) continue;
      seenFilesystems.add(fsKey);

      const free = getDiskFreeBytes(checkDir);
      let diskOk = true;
      let diskDetail = "Disk space check unavailable on this system";
      if (free !== null) {
        diskOk = free >= totalBytes;
        const needGb = (totalBytes / 1e9).toFixed(2);
        const freeGb = (free / 1e9).toFixed(2);
        diskDetail = diskOk
          ? `Need ${needGb} GB, ${freeGb} GB free on ${path.basename(dest)}`
          : `Need ${needGb} GB but only ${freeGb} GB free on ${path.basename(dest)}`;
      }
      checks.push({ name: `Disk space: ${path.basename(dest)}`, ok: diskOk, detail: diskDetail });
    }

    // 5. File collision detection — BLOCKING (collisions must be resolved before execute)
    let collisionCount = 0;
    const collisions: string[] = [];
    for (const route of (plan.routes ?? []) as any[]) {
      const destFile = path.join(route.destination, route.filename);
      if (fs.existsSync(destFile)) {
        collisionCount++;
        if (collisions.length < 5) collisions.push(route.filename);
      }
    }
    checks.push({
      name: "File collisions",
      ok: collisionCount === 0,
      detail: collisionCount === 0
        ? "No filename conflicts"
        : `${collisionCount} file${collisionCount !== 1 ? "s" : ""} already exist at destination — resolve or rename before executing (e.g. ${collisions.join(", ")}${collisionCount > 5 ? "…" : ""})`,
    });

    // 6. Immich reachability (if configured — non-blocking warning only)
    const immichUrl = settings.immichBaseUrl?.trim();
    if (immichUrl) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch(`${immichUrl}/api/server/ping`, { signal: controller.signal });
        clearTimeout(timer);
        checks.push({
          name: "Immich reachable",
          ok: resp.ok,
          warning: !resp.ok,
          detail: resp.ok ? "Immich API responding" : `Immich returned HTTP ${resp.status} — photos may not auto-import`,
        });
      } catch (e: any) {
        checks.push({
          name: "Immich reachable",
          ok: false,
          warning: true,
          detail: `Cannot reach Immich: ${e.message} — photos will not auto-import`,
        });
      }
    }

    // All critical checks must pass; warnings (Immich) are non-blocking
    const allOk = checks.every(c => c.ok || c.warning === true);
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
  let logPath = "";
  let logStream: fs.WriteStream | null = null;
  const opLog = (line: string) => {
    try { logStream?.write(line + "\n"); } catch { /* best effort */ }
  };

  try {
    const [job] = await db.select().from(organizationJobsTable).where(eq(organizationJobsTable.id, id)).limit(1);
    if (!job)                { send("error", { message: "Job not found" });        res.end(); return; }
    if (job.status === "executing") { send("error", { message: "Job is already executing" }); res.end(); return; }
    if (!job.planJson)       { send("error", { message: "Run analyze first" });    res.end(); return; }
    if (job.status !== "verified") {
      send("error", { message: "Pre-flight check must pass before executing" });
      res.end(); return;
    }

    const plan = job.planJson as any;
    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const settings = settingsRows[0] as any ?? {};
    const nasPath = settings.nasPath ?? "";

    // Open per-file operation log
    const ts = isoTimestamp();
    try {
      const logsDir = path.join(getWillardAIDir(nasPath), "logs");
      fs.mkdirSync(logsDir, { recursive: true });
      logPath = path.join(logsDir, `org-${ts}-${id}.log`);
      logStream = fs.createWriteStream(logPath, { flags: "a" });
      opLog(`=== Organization Job #${id} started at ${new Date().toISOString()} ===`);
      opLog(`Source: ${job.sourcePath} (${job.sourceType})`);
      opLog(`Archive disposition: ${job.archiveDisposition}`);
    } catch { /* log is best-effort */ }

    await db.update(organizationJobsTable).set({ status: "executing" }).where(eq(organizationJobsTable.id, id));
    send("status", { stage: "staging", message: "Creating staging directory…", progress: 2 });

    const tempDir = getTempDir(nasPath, `org-${id}`);
    tempDirs.push(tempDir);
    fs.mkdirSync(tempDir, { recursive: true });

    let sourceFiles: Array<{fullPath: string; relativePath: string; fileType: string; sizeBytes: number}> = [];

    if (job.sourceType === "archive") {
      // ── Archive: extract to temp (non-destructive; archive always intact) ──
      send("status", { stage: "extracting", message: "Extracting archive to staging area…", progress: 5 });
      if (!fs.existsSync(job.sourcePath)) throw new Error(`Archive not found: ${job.sourcePath}`);
      opLog(`EXTRACT: ${job.sourcePath} → ${tempDir}`);
      await extractArchive(job.sourcePath, tempDir);
      send("status", { stage: "scanning", message: "Scanning extracted files…", progress: 25 });
      const walked = walkDir(tempDir);
      sourceFiles = walked.map(w => ({ fullPath: w.fullPath, relativePath: w.relativePath, fileType: w.fileType, sizeBytes: w.sizeBytes }));
    } else {
      // ── Folder: COPY to staging first so source is always untouched ──
      if (!fs.existsSync(job.sourcePath)) throw new Error(`Source folder not found: ${job.sourcePath}`);
      send("status", { stage: "staging", message: "Copying files to staging area (source stays intact)…", progress: 5 });
      const walked = walkDir(job.sourcePath);
      let staged = 0;
      for (const w of walked) {
        const stageDest = path.join(tempDir, "staged", w.relativePath);
        fs.mkdirSync(path.dirname(stageDest), { recursive: true });
        fs.copyFileSync(w.fullPath, stageDest);
        staged++;
        if (staged % 10 === 0) {
          const pct = 5 + Math.round((staged / walked.length) * 15);
          send("status", { stage: "staging", message: `Staged ${staged}/${walked.length} files…`, progress: pct });
        }
      }
      opLog(`STAGE: Copied ${staged} files from ${job.sourcePath} → ${path.join(tempDir, "staged")}`);
      send("status", { stage: "scanning", message: `Staging complete — ${staged} files ready`, progress: 22 });
      const walkedStaged = walkDir(path.join(tempDir, "staged"));
      sourceFiles = walkedStaged.map(w => ({ fullPath: w.fullPath, relativePath: w.relativePath, fileType: w.fileType, sizeBytes: w.sizeBytes }));
    }

    const total = sourceFiles.length;
    let moved = 0;
    let skipped = 0;
    let hashMismatches = 0;

    // Verify extracted/staged file count vs plan
    const expectedTotal = plan.totalFiles ?? 0;
    if (expectedTotal > 0 && Math.abs(total - expectedTotal) > Math.max(5, expectedTotal * 0.05)) {
      opLog(`WARN: File count mismatch — planned ${expectedTotal}, found ${total}`);
      send("status", { stage: "scanning", message: `Warning: expected ${expectedTotal} files, found ${total}`, progress: 23 });
    }

    send("status", { stage: "moving", message: `Moving ${total} files to destinations…`, progress: 25, total });
    opLog(`MOVE_START: ${total} files to route`);

    for (let i = 0; i < sourceFiles.length; i++) {
      const sf = sourceFiles[i];
      const ft = sf.fileType === "image" ? "image" : sf.fileType === "video" ? "video" : sf.fileType === "document" ? "document" : "other";
      const destDir  = routeDestination(ft, settings, nasPath);
      const destFile = path.join(destDir, path.basename(sf.relativePath));

      if (fs.existsSync(destFile)) {
        skipped++;
        opLog(`SKIP (exists): ${sf.fullPath} → ${destFile}`);
        send("progress", { index: i + 1, total, filename: path.basename(sf.relativePath), action: "skipped" });
        continue;
      }

      // Record integrity token BEFORE move (from staging/temp location)
      const preHash = await fileIntegrityToken(sf.fullPath);

      moveFile(sf.fullPath, destFile);
      fileMoves.push({ from: sf.fullPath, to: destFile });
      moved++;
      opLog(`MOVE: ${sf.fullPath} → ${destFile}`);

      // Verify integrity AFTER move
      const postHash = await fileIntegrityToken(destFile);
      if (preHash && postHash && preHash !== postHash) {
        hashMismatches++;
        opLog(`HASH_MISMATCH: ${destFile} (pre: ${preHash.slice(0,8)} post: ${postHash.slice(0,8)})`);
      }

      if ((i + 1) % 5 === 0 || i === sourceFiles.length - 1) {
        const pct = 25 + Math.round(((i + 1) / total) * 60);
        send("progress", { index: i + 1, total, filename: path.basename(sf.relativePath), moved, skipped, progress: pct });
      }
    }

    if (hashMismatches > 0) {
      throw new Error(`Integrity check failed: ${hashMismatches} file${hashMismatches !== 1 ? "s" : ""} had hash mismatches after move. All moves reversed.`);
    }

    // ── Stage 6: Verify — 100% count check ──────────────────────────────────
    send("status", { stage: "verifying", message: "Verifying all moved files exist at destination…", progress: 87 });

    let verified = 0;
    const unverified: string[] = [];
    for (const mv of fileMoves) {
      if (fs.existsSync(mv.to)) {
        verified++;
      } else {
        unverified.push(mv.to);
        opLog(`VERIFY_FAIL: ${mv.to} not found after move`);
      }
    }

    if (unverified.length > 0) {
      throw new Error(`Verification failed: ${unverified.length} of ${fileMoves.length} moved files not found at destination.`);
    }

    opLog(`VERIFY: ${verified}/${fileMoves.length} files confirmed at destination`);

    // ── Stage 7: Archive disposition — only after 100% verification ─────────
    send("status", { stage: "disposition", message: `Handling archive (${job.archiveDisposition})…`, progress: 92 });

    if (job.sourceType === "archive" && job.archiveDisposition !== "keep") {
      // Safety gate: only allow destructive action after 100% verification
      if (verified < fileMoves.length) {
        opLog(`DISPOSITION_SKIPPED: Verification incomplete (${verified}/${fileMoves.length}), archive NOT touched`);
        send("status", { stage: "disposition", message: "Disposition skipped — verification incomplete", progress: 92 });
      } else if (job.archiveDisposition === "delete") {
        try {
          fs.unlinkSync(job.sourcePath);
          opLog(`DISPOSE_DELETE: ${job.sourcePath}`);
        } catch (e: any) {
          opLog(`DISPOSE_DELETE_FAIL: ${e.message}`);
        }
      } else if (job.archiveDisposition === "move_to_processed") {
        const processedDir = path.join(getWillardAIDir(nasPath), "archive-index", "processed");
        fs.mkdirSync(processedDir, { recursive: true });
        const dest = path.join(processedDir, path.basename(job.sourcePath));
        try {
          moveFile(job.sourcePath, dest);
          opLog(`DISPOSE_MOVE: ${job.sourcePath} → ${dest}`);
        } catch (e: any) {
          opLog(`DISPOSE_MOVE_FAIL: ${e.message}`);
        }
      }
    }

    // ── Stage 7: Report ──────────────────────────────────────────────────────
    send("status", { stage: "report", message: "Writing report…", progress: 96 });

    const completedAt = new Date();
    const report = {
      jobId: id, completedAt: completedAt.toISOString(),
      sourceType: job.sourceType, sourcePath: job.sourcePath, archiveDisposition: job.archiveDisposition,
      filesFound: total, filesMoved: moved, filesSkipped: skipped, filesVerified: verified,
      hashMismatches: 0, destinations: plan.destinations,
      aiConfidence: plan.aiConfidence, aiNotes: plan.aiNotes,
      logPath,
    };

    let reportPath = "";
    try {
      const reportsDir = path.join(getWillardAIDir(nasPath), "reports");
      fs.mkdirSync(reportsDir, { recursive: true });
      reportPath = path.join(reportsDir, `org-${ts}-${id}.json`);
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      opLog(`REPORT: ${reportPath}`);
    } catch { /* non-fatal */ }

    opLog(`=== Job #${id} COMPLETED at ${completedAt.toISOString()} — moved: ${moved}, skipped: ${skipped}, verified: ${verified} ===`);
    logStream?.end();

    await db.update(organizationJobsTable).set({
      status: "completed",
      fileMoves: fileMoves as any,
      reportPath: reportPath || null,
      completedAt,
    }).where(eq(organizationJobsTable.id, id));

    send("complete", { ...report, progress: 100 });

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    opLog(`ERROR: ${errMsg}`);
    send("status", { stage: "rolling_back", message: "Error — rolling back all moves…", progress: -1 });

    let rolledBack = 0;
    for (const mv of [...fileMoves].reverse()) {
      try {
        if (fs.existsSync(mv.to)) {
          moveFile(mv.to, mv.from);
          rolledBack++;
          opLog(`ROLLBACK: ${mv.to} → ${mv.from}`);
        }
      } catch (re: any) {
        opLog(`ROLLBACK_FAIL: ${mv.to} — ${re.message}`);
      }
    }

    opLog(`=== Job #${id} ROLLED_BACK — ${rolledBack}/${fileMoves.length} moves reversed ===`);
    logStream?.end();

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
