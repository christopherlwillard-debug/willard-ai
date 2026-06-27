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
import { getWillardAIDir, getTempDir, cleanTempDir, assertWithinRoot } from "../lib/nas-storage";

const router: IRouter = Router();

const ZIP_EXTS    = new Set(["zip"]);
const TAR_EXTS    = new Set(["tar","gz","tgz","bz2","tbz2","xz","txz","tar.gz","tar.bz2","tar.xz"]);
const SEVENZIP_EXTS = new Set(["rar","7z","cab","iso"]);

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

/**
 * Map file type to its canonical NAS destination directory.
 *
 * Canonical defaults (applied when no override is configured in app_settings):
 *   image    → <nasPath>/Media/Photos
 *   video    → <nasPath>/Media/Videos
 *   document → <nasPath>/Documents
 *   other    → <nasPath>/Archives/Extracted/<archiveName>  (archive source)
 *            → <nasPath>/Files                              (folder source)
 *
 * User-configured paths in app_settings always take precedence over canonical defaults.
 */
function routeDestination(
  fileType: string,
  settings: any,
  nasPath: string,
  opts: { archiveName?: string } = {}
): string {
  const override = (key: string): string | null =>
    settings?.[key] && String(settings[key]).trim() ? String(settings[key]).trim() : null;
  switch (fileType) {
    case "image":    return override("photosDestination")    ?? path.join(nasPath, "Media", "Photos");
    case "video":    return override("videosDestination")    ?? path.join(nasPath, "Media", "Videos");
    case "document": return override("documentsDestination") ?? path.join(nasPath, "Documents");
    default:
      return override("otherFilesDestination")
        ?? (opts.archiveName
          ? path.join(nasPath, "Archives", "Extracted", opts.archiveName)
          : path.join(nasPath, "Files"));
  }
}

/** CRC32 lookup table — computed once at module load. */
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

/** Compute CRC32 of a Buffer (same algorithm used by ZIP). */
function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ buf[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** Safe disk-free check — uses spawnSync with argument array; no shell interpolation. */
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

/** SHA-256 via streaming — memory-safe for large files. */
async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("end",  () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/** Returns SHA-256 for files ≤100 MB, size-sentinel for larger files. */
const HASH_LIMIT = 100 * 1024 * 1024;
async function integrityToken(filePath: string): Promise<string> {
  try {
    const s = fs.statSync(filePath);
    return s.size <= HASH_LIMIT ? await sha256File(filePath) : `size:${s.size}`;
  } catch { return ""; }
}

function moveFile(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.renameSync(from, to); }
  catch (err: any) {
    if (err.code === "EXDEV") { fs.copyFileSync(from, to); fs.unlinkSync(from); }
    else throw err;
  }
}

async function peekArchiveEntries(archivePath: string, filename: string): Promise<Array<{path: string; sizeBytes: number; isDirectory: boolean; fileType: string}>> {
  const ext    = getArchiveExt(filename);
  const rawExt = path.extname(filename).replace(".", "").toLowerCase();
  const entries: Array<{path: string; sizeBytes: number; isDirectory: boolean; fileType: string}> = [];

  if (ZIP_EXTS.has(ext)) {
    try {
      const zip = new AdmZip(archivePath);
      for (const e of zip.getEntries())
        entries.push({ path: e.entryName, sizeBytes: (e.header as any)?.size ?? 0, isDirectory: e.isDirectory, fileType: getFileTypeFromName(e.entryName) });
    } catch { /* corrupt or password-protected */ }
  } else if (TAR_EXTS.has(ext)) {
    try {
      await tar.list({
        file: archivePath,
        ...(["gz","tgz","bz2","tbz2","xz","txz"].includes(rawExt) ? { gzip: rawExt === "gz" || rawExt === "tgz" } : {}),
        onentry: (e: any) => entries.push({ path: e.path, sizeBytes: typeof e.size === "number" ? e.size : 0, isDirectory: e.type === "Directory", fileType: getFileTypeFromName(e.path) }),
      });
    } catch { /* corrupt */ }
  } else if (SEVENZIP_EXTS.has(ext)) {
    await new Promise<void>(resolve => {
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

/** Open archive TOC and count entries — detects corruption early. */
async function validateArchive(archivePath: string): Promise<{ ok: boolean; detail: string; entryCount: number }> {
  try {
    const ext    = getArchiveExt(path.basename(archivePath));
    const rawExt = path.extname(archivePath).replace(".", "").toLowerCase();
    let count = 0;

    if (ZIP_EXTS.has(ext)) {
      const zip = new AdmZip(archivePath);
      count = zip.getEntries().length;
    } else if (TAR_EXTS.has(ext)) {
      await tar.list({
        file: archivePath,
        ...(["gz","tgz","bz2","tbz2","xz","txz"].includes(rawExt) ? { gzip: rawExt === "gz" || rawExt === "tgz" } : {}),
        onentry: () => count++,
      });
    } else if (SEVENZIP_EXTS.has(ext)) {
      await new Promise<void>(resolve => {
        const s = Seven.list(archivePath, { $bin: path7za, $progress: false } as any);
        s.on("data", () => count++);
        s.on("end",   resolve);
        s.on("error", () => resolve());
      });
    } else {
      return { ok: false, detail: `Unsupported format: .${ext}`, entryCount: 0 };
    }
    if (count === 0) return { ok: false, detail: "Archive appears empty or unreadable", entryCount: 0 };
    return { ok: true, detail: `${count} entries readable`, entryCount: count };
  } catch (e: any) {
    return { ok: false, detail: `Archive may be corrupt: ${e.message}`, entryCount: 0 };
  }
}

/**
 * Safe archive extraction with path-traversal, absolute-path, and symlink rejection.
 *
 * Security policy — enforced in two passes:
 *   Pass 1 (enumerate): Read the archive TOC, reject any entry with an absolute path,
 *                       a ".." traversal component, a null byte, or a symlink/hardlink type.
 *                       Uses assertWithinRoot() to canonically verify each resolved path
 *                       stays inside stagingDir even after normalization.
 *   Pass 2 (extract):   Extract ONLY after pass 1 completes without error.
 *                       For ZIP, entries are written individually via getData() (no extractAllTo).
 *                       For TAR, a `filter` callback rejects symlinks at write time as a
 *                       second-layer defence. For 7z, extracted paths are re-verified via
 *                       assertWithinRoot() post-extraction.
 *
 * Integrity policy for moved files:
 *   Files ≤ 100 MB: full SHA-256 computed pre-move and verified post-move.
 *   Files > 100 MB: size-sentinel (byte count) verified post-move.
 *   This explicit fallback is intentional — hashing multi-GB files serially on every job
 *   would take prohibitive time on a NAS. The size-sentinel still catches truncation, partial
 *   writes, and cross-device copy errors that are the dominant failure modes in practice.
 */
async function safeExtractArchive(archivePath: string, stagingDir: string): Promise<{
  entriesExtracted: number;
  crcValidation: { format: string; checked: number; passed: number; skipped: number; note?: string };
}> {
  const ext    = getArchiveExt(path.basename(archivePath));
  const rawExt = path.extname(archivePath).replace(".", "").toLowerCase();
  fs.mkdirSync(stagingDir, { recursive: true });

  /** Validate a single entry path before writing any bytes to disk. */
  function assertSafeEntryPath(entryPath: string): void {
    if (!entryPath || entryPath.trim() === "") return; // empty = root dir entry, safe
    if (entryPath.includes("\0")) throw new Error(`Archive traversal rejected: null byte in entry "${entryPath}"`);
    const normalised = entryPath.replace(/\\/g, "/");
    if (path.isAbsolute(normalised) || path.isAbsolute(entryPath))
      throw new Error(`Archive traversal rejected: absolute path in entry "${entryPath}"`);
    if (normalised.split("/").some(part => part === ".."))
      throw new Error(`Archive traversal rejected: ".." traversal component in entry "${entryPath}"`);
    // Canonical check: resolved join must stay inside stagingDir
    assertWithinRoot(path.join(stagingDir, entryPath), stagingDir);
  }

  let entriesExtracted = 0;

  if (ZIP_EXTS.has(ext)) {
    const zip     = new AdmZip(archivePath);
    const entries = zip.getEntries();

    // Pass 1: validate all entries before writing anything
    for (const e of entries) {
      if (e.isDirectory) continue;
      if ((e as any).attr && ((e as any).attr >>> 16) === 0xA000) // Unix symlink mode
        throw new Error(`Archive traversal rejected: symlink entry "${e.entryName}" in ZIP`);
      assertSafeEntryPath(e.entryName);
    }

    // Pass 2: extract entry by entry with CRC32 validation
    // adm-zip internally checks CRC on getData(); we also verify explicitly for belt-and-suspenders.
    let crcChecked = 0; let crcPassed = 0; let crcSkipped = 0;
    for (const e of entries) {
      if (e.isDirectory) continue;
      const outPath = path.join(stagingDir, e.entryName);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const data = e.getData(); // throws internally on CRC mismatch
      const storedCrc = (e.header as any).crc as number | undefined;
      if (typeof storedCrc === "number" && storedCrc !== 0) {
        const computed = crc32(data);
        if (computed !== storedCrc)
          throw new Error(`CRC32 mismatch: entry "${e.entryName}" computed=0x${computed.toString(16)} stored=0x${storedCrc.toString(16)}`);
        crcChecked++; crcPassed++;
      } else {
        crcSkipped++;
      }
      fs.writeFileSync(outPath, data);
      entriesExtracted++;
    }
    return {
      entriesExtracted,
      crcValidation: { format: "zip-crc32", checked: crcChecked, passed: crcPassed, skipped: crcSkipped },
    };

  } else if (TAR_EXTS.has(ext)) {
    const gzipOpts = ["gz","tgz","bz2","tbz2","xz","txz"].includes(rawExt) ? { gzip: rawExt === "gz" || rawExt === "tgz" } : {};
    const filePaths: string[] = [];

    // Pass 1: enumerate and validate
    await tar.list({
      file: archivePath,
      ...gzipOpts,
      onentry: (e: any) => {
        const t = e.type as string;
        if (t === "SymbolicLink" || t === "Link" || t === "HardLink")
          throw new Error(`Archive traversal rejected: link entry "${e.path}" (type: ${t}) in TAR`);
        if (t !== "Directory") {
          assertSafeEntryPath(e.path);
          filePaths.push(e.path);
        }
      },
    });

    // Pass 2: extract with symlink filter as second defence layer
    await tar.extract({
      file: archivePath,
      cwd: stagingDir,
      ...gzipOpts,
      filter: (_p: string, entry: any) => {
        const t = entry?.type as string | undefined;
        return t !== "SymbolicLink" && t !== "Link" && t !== "HardLink";
      },
    } as any);

    entriesExtracted = filePaths.length;
    // TAR uses header checksums (not payload CRC) — payload CRC not available in standard format
    return {
      entriesExtracted,
      crcValidation: { format: "tar-no-payload-crc", checked: 0, passed: 0, skipped: entriesExtracted, note: "TAR header checksum only; no per-file payload CRC in standard format" },
    };

  } else if (SEVENZIP_EXTS.has(ext)) {
    const filePaths: string[] = [];
    let sevenZipCrcCount = 0;

    // Pass 1: enumerate, validate, and record CRC metadata from archive headers
    await new Promise<void>((resolve, reject) => {
      const s = Seven.list(archivePath, { $bin: path7za, $progress: false } as any);
      s.on("data", (d: any) => {
        if (d.file === undefined) return;
        const isDir  = typeof d.attributes === "string" && d.attributes[0] === "D";
        const isLink = typeof d.attributes === "string" && (d.attributes.includes("L") || d.attributes.includes("l"));
        if (isLink) { reject(new Error(`Archive traversal rejected: symlink entry "${d.file}" in 7z`)); return; }
        if (!isDir) {
          try { assertSafeEntryPath(d.file); } catch (e) { reject(e); return; }
          filePaths.push(d.file);
          if (typeof d.crc === "number" || typeof d.crc === "string") sevenZipCrcCount++;
        }
      });
      s.on("end",   resolve);
      s.on("error", (e: any) => reject(new Error(`7z list error: ${e?.message ?? e}`)));
    });

    // Pass 2: extract
    await new Promise<void>((resolve, reject) => {
      const s = Seven.extractFull(archivePath, stagingDir, { $bin: path7za, overwrite: "qs", $progress: false } as any);
      s.on("end",   resolve);
      s.on("error", (e: any) => reject(new Error(`7z extract error: ${e?.message ?? e}`)));
    });

    // Post-extraction canonical check for each listed path
    for (const fp of filePaths) {
      assertWithinRoot(path.join(stagingDir, fp), stagingDir);
    }
    entriesExtracted = filePaths.length;
    return {
      entriesExtracted,
      crcValidation: {
        format: "7z-crc-metadata",
        checked: 0, passed: 0, skipped: entriesExtracted,
        note: `${sevenZipCrcCount}/${filePaths.length} entries have archive CRC metadata; post-extraction CRC32 requires adm-7z extension not available in current deps`,
      },
    };

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
        results.push({ fullPath: full, relativePath: path.relative(dirPath, full), sizeBytes: stat.size, fileType: getFileType(path.extname(e.name).replace(".", "").toLowerCase()) });
      }
    }
  }
  walk(dirPath);
  return results;
}

async function callAiConfidence(planSummary: object): Promise<{ confidence: number; reason: string; recommendation: string } | null> {
  try {
    const c = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: 'You are a file organization assistant. Review the proposed routing plan and return ONLY valid JSON with exactly these fields: ' +
            '{"confidence": <number 0-1>, "reason": "<one sentence explaining the confidence score>", "recommendation": "<one actionable suggestion or \'Plan looks good\'>"}'
        },
        { role: "user", content: JSON.stringify(planSummary) },
      ],
      response_format: { type: "json_object" },
      max_tokens: 200,
    });
    const raw = JSON.parse(c.choices[0]?.message?.content ?? "{}");
    return {
      confidence:     typeof raw.confidence     === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0.5,
      reason:         typeof raw.reason         === "string" ? raw.reason         : "Unable to assess routing quality.",
      recommendation: typeof raw.recommendation === "string" ? raw.recommendation : "Review destination assignments manually.",
    };
  } catch { return null; }
}

/** Query Immich asset statistics — used for pre/post-move count comparison. */
async function getImmichAssetStats(immichUrl: string, apiKey: string): Promise<{ images: number; videos: number; total: number } | null> {
  try {
    const headers = { "x-api-key": apiKey, "Accept": "application/json" };
    const resp = await fetch(`${immichUrl}/api/assets/statistics`, { headers, signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    const images = data.images ?? 0;
    const videos = data.videos ?? 0;
    return { images, videos, total: images + videos };
  } catch { return null; }
}

/**
 * Poll Immich after rescan to verify the expected number of new assets were imported.
 * Compares total asset count against a pre-move baseline; polls every 3 s for up to 45 s.
 * Non-fatal: a "timeout" status means Immich is still processing, not that files were lost.
 */
async function verifyImmichImport(
  immichUrl: string,
  apiKey: string,
  baseline: { images: number; videos: number; total: number },
  expectedNew: number,
  progressCb: (msg: string) => void,
): Promise<{ expected: number; imported: number; status: "verified" | "timeout" | "error"; detail: string }> {
  const maxWaitMs = 45_000;
  const pollMs    = 3_000;
  const deadline  = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
    const stats = await getImmichAssetStats(immichUrl, apiKey);
    if (!stats) return { expected: expectedNew, imported: 0, status: "error", detail: "Cannot query Immich asset statistics" };
    const delta = stats.total - baseline.total;
    progressCb(`Immich: ${delta}/${expectedNew} new assets confirmed…`);
    if (delta >= expectedNew) {
      return { expected: expectedNew, imported: delta, status: "verified", detail: `Immich confirmed ${delta} new asset${delta !== 1 ? "s" : ""} (expected ${expectedNew})` };
    }
  }

  const finalStats = await getImmichAssetStats(immichUrl, apiKey);
  const delta = finalStats ? finalStats.total - baseline.total : 0;
  return {
    expected: expectedNew, imported: delta, status: "timeout",
    detail: `Immich import not confirmed within 45 s: ${delta}/${expectedNew} assets detected. Rescan may still be in progress — check Immich directly.`,
  };
}

/** Trigger Immich library rescan via the external API. Best-effort — always resolves. */
async function triggerImmichRescan(immichUrl: string, apiKey: string): Promise<{ triggered: boolean; libraries: number; detail: string }> {
  try {
    const headers = { "x-api-key": apiKey, "Content-Type": "application/json", "Accept": "application/json" };
    const libResp = await fetch(`${immichUrl}/api/libraries`, { headers, signal: AbortSignal.timeout(8000) });
    if (!libResp.ok) return { triggered: false, libraries: 0, detail: `Immich returned HTTP ${libResp.status}` };

    const libraries = (await libResp.json()) as any[];
    let triggered = 0;
    for (const lib of libraries) {
      try {
        const scanResp = await fetch(`${immichUrl}/api/libraries/${lib.id}/scan`, {
          method: "POST",
          headers,
          body: JSON.stringify({ refreshModifiedFiles: false, refreshAllFiles: false }),
          signal: AbortSignal.timeout(8000),
        });
        if (scanResp.ok || scanResp.status === 204) triggered++;
      } catch { /* per-library failure is non-fatal */ }
    }
    return { triggered: triggered > 0, libraries: triggered, detail: `Triggered scan on ${triggered}/${libraries.length} Immich libraries` };
  } catch (e: any) {
    return { triggered: false, libraries: 0, detail: `Immich rescan unavailable: ${e.message}` };
  }
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
    const [job] = await db.insert(organizationJobsTable)
      .values({ sourceType, sourcePath, archiveId: archiveId ?? null, archiveDisposition })
      .returning();
    res.status(201).json(job);
  } catch { res.status(500).json({ error: "Failed to create organize job" }); }
});

router.get("/organize/jobs", async (_req, res) => {
  try {
    const jobs = await db.select().from(organizationJobsTable).orderBy(desc(organizationJobsTable.createdAt)).limit(50);
    res.json(jobs);
  } catch { res.status(500).json({ error: "Failed to list organize jobs" }); }
});

router.get("/organize/jobs/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [job] = await db.select().from(organizationJobsTable).where(eq(organizationJobsTable.id, id)).limit(1);
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    res.json(job);
  } catch { res.status(500).json({ error: "Failed to get organize job" }); }
});

router.delete("/organize/jobs/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [job] = await db.select().from(organizationJobsTable).where(eq(organizationJobsTable.id, id)).limit(1);
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    if (job.status === "executing") { res.status(409).json({ error: "Cannot delete a running job" }); return; }
    await db.delete(organizationJobsTable).where(eq(organizationJobsTable.id, id));
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "Failed to delete organize job" }); }
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
            path: e.path ?? e.name ?? "", sizeBytes: e.sizeBytes ?? 0, isDirectory: e.isDirectory ?? false, fileType: e.fileType ?? "other",
          }));
        }
      }
      if (entries.length === 0) entries = await peekArchiveEntries(job.sourcePath, path.basename(job.sourcePath));
    } else {
      if (!fs.existsSync(job.sourcePath)) {
        await db.update(organizationJobsTable).set({ status: "failed", error: "Source folder not found" }).where(eq(organizationJobsTable.id, id));
        res.status(422).json({ error: "Source folder not found on disk" }); return;
      }
      entries = walkDir(job.sourcePath).map(w => ({ path: w.relativePath, sizeBytes: w.sizeBytes, isDirectory: false, fileType: w.fileType }));
    }

    const fileEntries = entries.filter(e => !e.isDirectory);
    const summary = { images: 0, videos: 0, documents: 0, other: 0 };
    const routes: any[] = [];

    // Archive stem for "other" destination scoping (e.g. "backup.tar.gz" → "backup")
    const archiveName = job.sourceType === "archive"
      ? path.parse(path.parse(job.sourcePath).name).name  // strips both .gz and .tar
      : undefined;

    for (const e of fileEntries) {
      const ft = e.fileType === "image" ? "image" : e.fileType === "video" ? "video" : e.fileType === "document" ? "document" : "other";
      (summary as any)[ft === "image" ? "images" : ft === "video" ? "videos" : ft === "document" ? "documents" : "other"]++;
      routes.push({ relativePath: e.path, filename: path.basename(e.path), fileType: ft, sizeBytes: e.sizeBytes, destination: routeDestination(ft, settings, nasPath, { archiveName }) });
    }

    const totalSizeBytes = fileEntries.reduce((s, e) => s + (e.sizeBytes ?? 0), 0);
    const destinations = {
      images:    routeDestination("image",    settings, nasPath),
      videos:    routeDestination("video",    settings, nasPath),
      documents: routeDestination("document", settings, nasPath),
      other:     routeDestination("other",    settings, nasPath, { archiveName }),
    };

    // Build intra-plan conflict list for AI review input
    const filenameGroups = new Map<string, string[]>();
    for (const r of routes) {
      const key = path.join(r.destination, r.filename);
      if (!filenameGroups.has(key)) filenameGroups.set(key, []);
      filenameGroups.get(key)!.push(r.relativePath);
    }
    const planConflicts = [...filenameGroups.values()].filter(g => g.length > 1).map(g => g[0]);

    const aiResult = await callAiConfidence({
      totalFiles: fileEntries.length,
      summary,
      destinations,
      conflictCount: planConflicts.length,
      conflictExamples: planConflicts.slice(0, 5),
    });
    const planJson: any = {
      sourceType: job.sourceType, sourcePath: job.sourcePath,
      totalFiles: fileEntries.length, totalSizeBytes, routes,
      excludeCategories: [], excludePaths: [],
      summary, destinations, archiveDisposition: job.archiveDisposition,
      aiConfidence:     aiResult?.confidence     ?? null,
      aiReason:         aiResult?.reason         ?? null,
      aiRecommendation: aiResult?.recommendation ?? null,
    };

    const [updated] = await db.update(organizationJobsTable)
      .set({ status: "planned", planJson })
      .where(eq(organizationJobsTable.id, id))
      .returning();
    res.json(updated);
  } catch (err) {
    await db.update(organizationJobsTable)
      .set({ status: "failed", error: err instanceof Error ? err.message : "Unknown error" })
      .where(eq(organizationJobsTable.id, id)).catch(() => {});
    res.status(500).json({ error: "Analysis failed" });
  }
});

/** Update plan exclusions. Resets pre-flight so the user re-validates the updated plan. */
router.patch("/organize/jobs/:id/plan", async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const [job] = await db.select().from(organizationJobsTable).where(eq(organizationJobsTable.id, id)).limit(1);
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    if (!job.planJson) { res.status(422).json({ error: "Run analyze first" }); return; }
    if (job.status === "executing") { res.status(409).json({ error: "Job is currently executing" }); return; }

    const plan = job.planJson as any;
    const { excludeCategories = [], excludePaths = [] } = req.body as any;
    const excludedPathSet = new Set(excludePaths as string[]);

    const activeRoutes = (plan.routes ?? []).filter((r: any) =>
      !excludeCategories.includes(r.fileType) && !excludedPathSet.has(r.relativePath)
    );

    const activeSummary = { images: 0, videos: 0, documents: 0, other: 0 };
    for (const r of activeRoutes) {
      (activeSummary as any)[r.fileType === "image" ? "images" : r.fileType === "video" ? "videos" : r.fileType === "document" ? "documents" : "other"]++;
    }

    const updatedPlan = {
      ...plan,
      excludeCategories,
      excludePaths,
      activeRoutes,
      activeSummary,
      totalFiles: activeRoutes.length,
      totalSizeBytes: activeRoutes.reduce((s: number, r: any) => s + (r.sizeBytes ?? 0), 0),
    };

    const [updated] = await db.update(organizationJobsTable)
      .set({ status: "planned", planJson: updatedPlan, preflightJson: null })
      .where(eq(organizationJobsTable.id, id))
      .returning();
    res.json(updated);
  } catch { res.status(500).json({ error: "Failed to update plan" }); }
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

    // Active routes = plan.activeRoutes (if exclusions applied) or plan.routes
    const activeRoutes: any[] = plan.activeRoutes ?? plan.routes ?? [];

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
          : `Found (directory)`;
      } catch { sourceDetail = `Exists but not readable`; }
    }
    checks.push({ name: "Source accessible", ok: sourceOk, detail: sourceDetail });

    // 2. Archive integrity — try to open and count entries
    if (job.sourceType === "archive" && sourceOk) {
      const v = await validateArchive(job.sourcePath);
      checks.push({ name: "Archive integrity", ok: v.ok, detail: v.detail });
    }

    // 3. Destination writability — checked per destination
    const uniqueDests = [...new Set<string>(activeRoutes.map((r: any) => r.destination).filter(Boolean))];
    for (const dest of uniqueDests) {
      let destOk = false;
      let destDetail = "";
      try {
        fs.mkdirSync(dest, { recursive: true });
        const tf = path.join(dest, `.willard_test_${Date.now()}`);
        fs.writeFileSync(tf, ""); fs.unlinkSync(tf);
        destOk = true; destDetail = "Writable";
      } catch (e: any) { destDetail = e.message; }
      checks.push({ name: `Writable: ${path.basename(dest)}`, ok: destOk, detail: destDetail || dest });
    }

    // 4. Disk space — checked per unique filesystem
    const totalBytes = plan.totalSizeBytes ?? 0;
    const seenFs = new Set<string>();
    for (const dest of uniqueDests) {
      const checkDir = fs.existsSync(dest) ? dest : path.dirname(dest);
      let fsKey = checkDir;
      try { fsKey = fs.realpathSync(checkDir); } catch { /* best effort */ }
      if (seenFs.has(fsKey)) continue;
      seenFs.add(fsKey);
      const free = getDiskFreeBytes(checkDir);
      let diskOk = true;
      let diskDetail = "Check unavailable on this system";
      if (free !== null) {
        diskOk = free >= totalBytes;
        diskDetail = diskOk
          ? `Need ${(totalBytes / 1e9).toFixed(2)} GB, ${(free / 1e9).toFixed(2)} GB free`
          : `Need ${(totalBytes / 1e9).toFixed(2)} GB but only ${(free / 1e9).toFixed(2)} GB free`;
      }
      checks.push({ name: `Disk space (${path.basename(dest)})`, ok: diskOk, detail: diskDetail });
    }

    // 5a. On-disk collision detection: files that already exist at the destination
    let diskCollisionCount = 0;
    const diskCollisionExamples: string[] = [];
    for (const route of activeRoutes) {
      if (fs.existsSync(path.join(route.destination, route.filename))) {
        diskCollisionCount++;
        if (diskCollisionExamples.length < 4) diskCollisionExamples.push(route.filename);
      }
    }

    // 5b. Intra-job collision detection: two or more source files that map to the same
    //     destination path (e.g. A/photo.jpg + B/photo.jpg both routed to Media/Photos).
    //     Pre-flight must catch these — execute treats unexpected collisions as fatal.
    const destPathSeen = new Map<string, string[]>();  // destPath → source relativePaths
    for (const route of activeRoutes) {
      const destPath = path.join(route.destination, route.filename);
      if (!destPathSeen.has(destPath)) destPathSeen.set(destPath, []);
      destPathSeen.get(destPath)!.push(route.relativePath ?? route.filename);
    }
    let intraJobCollisionCount = 0;
    const intraJobCollisionExamples: string[] = [];
    for (const [, sources] of destPathSeen) {
      if (sources.length > 1) {
        intraJobCollisionCount++;
        if (intraJobCollisionExamples.length < 4) intraJobCollisionExamples.push(path.basename(sources[0]));
      }
    }

    const collisionCount = diskCollisionCount + intraJobCollisionCount;
    const collisionDetails: string[] = [];
    if (diskCollisionCount > 0)
      collisionDetails.push(`${diskCollisionCount} already on disk (${diskCollisionExamples.join(", ")}${diskCollisionCount > 4 ? "…" : ""})`);
    if (intraJobCollisionCount > 0)
      collisionDetails.push(`${intraJobCollisionCount} intra-job conflict${intraJobCollisionCount !== 1 ? "s" : ""} — duplicate basenames routing to same folder (${intraJobCollisionExamples.join(", ")}${intraJobCollisionCount > 4 ? "…" : ""})`);

    checks.push({
      name: "File collisions",
      ok: collisionCount === 0,
      detail: collisionCount === 0
        ? "No filename conflicts"
        : `${collisionCount} conflict${collisionCount !== 1 ? "s" : ""} — exclude conflicting files before executing: ${collisionDetails.join("; ")}`,
    });

    // 6. Immich reachability — warning-level only (non-blocking)
    const immichUrl = settings.immichBaseUrl?.trim();
    if (immichUrl) {
      try {
        const resp = await fetch(`${immichUrl}/api/server/ping`, { signal: AbortSignal.timeout(5000) });
        checks.push({ name: "Immich reachable", ok: resp.ok, warning: !resp.ok, detail: resp.ok ? "Immich API responding" : `HTTP ${resp.status} — photos may not auto-import` });
      } catch (e: any) {
        checks.push({ name: "Immich reachable", ok: false, warning: true, detail: `Cannot reach Immich: ${e.message}` });
      }
    }

    // allOk: all critical checks pass; Immich (warning:true) is non-blocking
    const allOk = checks.every(c => c.ok || c.warning === true);
    const preflightJson = { ok: allOk, checks, diskSpaceRequiredBytes: totalBytes, collisionCount };
    const [updated] = await db.update(organizationJobsTable)
      .set({ status: allOk ? "verified" : "planned", preflightJson })
      .where(eq(organizationJobsTable.id, id))
      .returning();
    res.json(updated);
  } catch { res.status(500).json({ error: "Preflight check failed" }); }
});

/**
 * SSE execution stream.
 * - Folder jobs: COPY to staging first; source is never touched during execute.
 * - Any unexpected collision during execute is treated as a FATAL error (triggers rollback).
 * - Archive disposition `delete` is NOT applied here — it requires explicit second confirmation
 *   via POST /organize/jobs/:id/apply-disposition after reviewing the completion summary.
 * - Archive disposition `move_to_processed` is applied automatically after 100% verification.
 */
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
  let logStream: fs.WriteStream | null = null;
  let logPath = "";
  const opLog = (line: string) => { try { logStream?.write(line + "\n"); } catch { /* best-effort */ } };

  try {
    const [job] = await db.select().from(organizationJobsTable).where(eq(organizationJobsTable.id, id)).limit(1);
    if (!job)                   { send("error", { message: "Job not found" });                          res.end(); return; }
    if (job.status === "executing") { send("error", { message: "Job is already executing" });           res.end(); return; }
    if (!job.planJson)          { send("error", { message: "Run analyze first" });                      res.end(); return; }
    if (job.status !== "verified") { send("error", { message: "Pre-flight must pass before executing" }); res.end(); return; }

    const plan = job.planJson as any;
    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const settings = settingsRows[0] as any ?? {};
    const nasPath = settings.nasPath ?? "";

    // Active routes respect any category/path exclusions set via PATCH /plan
    const excludedCategories = new Set<string>(plan.excludeCategories ?? []);
    const excludedPaths      = new Set<string>(plan.excludePaths ?? []);
    const activeRoutes: any[] = (plan.routes ?? []).filter((r: any) =>
      !excludedCategories.has(r.fileType) && !excludedPaths.has(r.relativePath)
    );
    const expectedTotal = activeRoutes.length;

    // Archive name (stem without extensions) used for "other" destination scoping
    const archiveName = job.sourceType === "archive"
      ? path.parse(path.parse(job.sourcePath).name).name
      : undefined;

    // imagesMoved computed here (needed for Immich baseline before moves)
    const imagesMoved = activeRoutes.filter(r => r.fileType === "image" || r.fileType === "video").length;

    // Pre-move Immich asset baseline (for import count verification after rescan)
    let immichBaseline: { images: number; videos: number; total: number } | null = null;
    if (imagesMoved > 0 && settings.immichBaseUrl?.trim() && settings.immichApiKey?.trim()) {
      immichBaseline = await getImmichAssetStats(settings.immichBaseUrl.trim(), settings.immichApiKey.trim());
      if (immichBaseline) opLog(`IMMICH_BASELINE: images=${immichBaseline.images} videos=${immichBaseline.videos} total=${immichBaseline.total}`);
    }

    // Open per-file operation log
    const ts = isoTimestamp();
    try {
      const logsDir = path.join(getWillardAIDir(nasPath), "logs");
      fs.mkdirSync(logsDir, { recursive: true });
      logPath = path.join(logsDir, `org-${ts}-${id}.log`);
      logStream = fs.createWriteStream(logPath, { flags: "a" });
      opLog(`=== Organization Job #${id} started ${new Date().toISOString()} ===`);
      opLog(`Source: ${job.sourcePath} (${job.sourceType})`);
      opLog(`Active routes: ${expectedTotal} / ${plan.routes?.length ?? 0} total`);
    } catch { /* log is best-effort */ }

    await db.update(organizationJobsTable).set({ status: "executing" }).where(eq(organizationJobsTable.id, id));
    send("status", { stage: "staging", message: "Preparing staging area…", progress: 2 });

    const tempDir = getTempDir(nasPath, `org-${id}`);
    tempDirs.push(tempDir);
    fs.mkdirSync(tempDir, { recursive: true });

    let sourceFiles: Array<{fullPath: string; relativePath: string; fileType: string; sizeBytes: number}> = [];
    let crcValidation: { format: string; checked: number; passed: number; skipped: number; note?: string } | null = null;

    if (job.sourceType === "archive") {
      send("status", { stage: "extracting", message: "Extracting archive to staging area…", progress: 5 });
      if (!fs.existsSync(job.sourcePath)) throw new Error(`Archive not found: ${job.sourcePath}`);
      opLog(`EXTRACT: ${job.sourcePath} → ${tempDir}`);
      const extractResult = await safeExtractArchive(job.sourcePath, tempDir);
      crcValidation = extractResult.crcValidation;
      const { entriesExtracted } = extractResult;
      opLog(`EXTRACT_OK: ${entriesExtracted} entries — CRC ${crcValidation.format}: checked=${crcValidation.checked} passed=${crcValidation.passed} skipped=${crcValidation.skipped}${crcValidation.note ? ` (${crcValidation.note})` : ""}`);
      send("status", { stage: "scanning",   message: "Scanning extracted files…",          progress: 25 });
      sourceFiles = walkDir(tempDir).map(w => ({ fullPath: w.fullPath, relativePath: w.relativePath, fileType: w.fileType, sizeBytes: w.sizeBytes }));
    } else {
      // FOLDER: stage (copy) so source directory is never modified during execute
      if (!fs.existsSync(job.sourcePath)) throw new Error(`Source folder not found: ${job.sourcePath}`);
      const walked = walkDir(job.sourcePath);
      send("status", { stage: "staging", message: `Copying ${walked.length} files to staging area…`, progress: 5 });
      const stagingBase = path.join(tempDir, "staged");
      let staged = 0;
      for (const w of walked) {
        const dest = path.join(stagingBase, w.relativePath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(w.fullPath, dest);
        staged++;
        if (staged % 20 === 0) send("status", { stage: "staging", message: `Staged ${staged}/${walked.length}…`, progress: 5 + Math.round((staged / walked.length) * 17) });
      }
      opLog(`STAGE: Copied ${staged} files to ${stagingBase}`);
      sourceFiles = walkDir(stagingBase).map(w => ({ fullPath: w.fullPath, relativePath: w.relativePath, fileType: w.fileType, sizeBytes: w.sizeBytes }));
      send("status", { stage: "scanning", message: `Staged ${sourceFiles.length} files`, progress: 24 });
    }

    // FATAL if staged count does not exactly match plan (indicates extraction failure or plan drift)
    if (expectedTotal > 0) {
      const applicableStaged = sourceFiles.filter(sf => {
        const ft = sf.fileType === "image" ? "image" : sf.fileType === "video" ? "video" : sf.fileType === "document" ? "document" : "other";
        return !excludedCategories.has(ft) && !excludedPaths.has(sf.relativePath);
      });
      if (applicableStaged.length !== expectedTotal) {
        throw new Error(
          `Staged file count mismatch: plan expected ${expectedTotal} files but ${applicableStaged.length} ` +
          `were found after ${job.sourceType === "archive" ? "extraction" : "staging"}. ` +
          `Re-run Analyze to refresh the plan before executing.`
        );
      }
      opLog(`COUNT_OK: ${applicableStaged.length} staged files match plan exactly`);
    }

    const total = expectedTotal;
    let moved = 0;
    let excluded = 0;

    send("status", { stage: "moving", message: `Moving ${total} files…`, progress: 26, total });
    opLog(`MOVE_START: routing ${total} active files`);

    for (let i = 0; i < sourceFiles.length; i++) {
      const sf = sourceFiles[i];
      const ft = sf.fileType === "image" ? "image" : sf.fileType === "video" ? "video" : sf.fileType === "document" ? "document" : "other";

      // Respect plan exclusions
      if (excludedCategories.has(ft) || excludedPaths.has(sf.relativePath)) {
        excluded++;
        opLog(`EXCLUDE: ${sf.relativePath}`);
        continue;
      }

      const destDir  = routeDestination(ft, settings, nasPath, { archiveName });
      const destFile = path.join(destDir, path.basename(sf.relativePath));

      // FATAL on unexpected collision — pre-flight should have caught this
      if (fs.existsSync(destFile)) {
        throw new Error(
          `Unexpected collision during execute: ${path.basename(sf.relativePath)} already exists at ${destDir}. ` +
          `Re-run pre-flight to detect and resolve conflicts.`
        );
      }

      const preToken  = await integrityToken(sf.fullPath);
      moveFile(sf.fullPath, destFile);
      fileMoves.push({ from: sf.fullPath, to: destFile });
      moved++;

      // Verify integrity post-move
      const postToken = await integrityToken(destFile);
      if (preToken && postToken && preToken !== postToken) {
        throw new Error(`Integrity mismatch after moving ${path.basename(sf.relativePath)} — checksums differ. All moves reversed.`);
      }

      opLog(`MOVE: ${sf.fullPath} → ${destFile}`);

      if ((i + 1) % 5 === 0 || moved + excluded === total) {
        const pct = 26 + Math.round(((moved + excluded) / total) * 55);
        send("progress", { index: i + 1, total, filename: path.basename(sf.relativePath), moved, progress: pct });
      }
    }

    // ── Stage 6: Strict verification — 100% of moved files must exist + per-dest recount ──
    send("status", { stage: "verifying", message: "Verifying all moved files at destination…", progress: 83 });

    // Invariant: moved count must match expected active routes exactly
    if (moved !== total) {
      throw new Error(`Move count mismatch: moved ${moved} but plan expected ${total}. Investigation required.`);
    }

    // Per-file existence check
    const unverified: string[] = [];
    for (const mv of fileMoves) {
      if (!fs.existsSync(mv.to)) {
        unverified.push(mv.to);
        opLog(`VERIFY_FAIL: ${mv.to} missing`);
      }
    }
    if (unverified.length > 0) {
      throw new Error(`Verification failed: ${unverified.length}/${fileMoves.length} moved files not found at destination.`);
    }
    opLog(`VERIFY_FILES: ${fileMoves.length}/${fileMoves.length} files confirmed at destination`);

    // Per-destination directory recount — groups moved files by dest dir and recounts each
    const destCountMap = new Map<string, { expected: number; found: number }>();
    for (const mv of fileMoves) {
      const dir = path.dirname(mv.to);
      if (!destCountMap.has(dir)) destCountMap.set(dir, { expected: 0, found: 0 });
      destCountMap.get(dir)!.expected++;
      if (fs.existsSync(mv.to)) destCountMap.get(dir)!.found++;
    }
    const destVerification: Array<{ dir: string; expected: number; found: number; ok: boolean }> = [];
    for (const [dir, counts] of destCountMap) {
      const ok = counts.found === counts.expected;
      destVerification.push({ dir: path.basename(dir), expected: counts.expected, found: counts.found, ok });
      opLog(`VERIFY_DEST: ${path.basename(dir)} expected=${counts.expected} found=${counts.found} ok=${ok}`);
    }
    const destVerifyFailed = destVerification.filter(d => !d.ok);
    if (destVerifyFailed.length > 0) {
      throw new Error(
        `Destination recount failed: ${destVerifyFailed.map(d => `${d.dir}: expected ${d.expected}, found ${d.found}`).join("; ")}`
      );
    }
    opLog(`VERIFY_DEST_OK: ${destVerification.length} destination group(s) all match`);

    // ── Immich rescan + import count verification ────────────────────────────
    send("status", { stage: "immich", message: "Triggering Immich library rescan…", progress: 88 });
    let immichResult: any = null;
    let immichVerification: any = null;
    if (imagesMoved > 0 && settings.immichBaseUrl?.trim() && settings.immichApiKey?.trim()) {
      const rescanResult = await triggerImmichRescan(settings.immichBaseUrl.trim(), settings.immichApiKey.trim());
      immichResult = rescanResult;
      opLog(`IMMICH_RESCAN: ${rescanResult.detail}`);

      if (rescanResult.triggered && immichBaseline) {
        send("status", { stage: "immich_verify", message: `Verifying Immich import — expecting ${imagesMoved} new asset${imagesMoved !== 1 ? "s" : ""}…`, progress: 90 });
        immichVerification = await verifyImmichImport(
          settings.immichBaseUrl.trim(),
          settings.immichApiKey.trim(),
          immichBaseline,
          imagesMoved,
          (msg) => send("status", { stage: "immich_verify", message: msg, progress: 91 }),
        );
        opLog(`IMMICH_VERIFY: status=${immichVerification.status} imported=${immichVerification.imported}/${immichVerification.expected} — ${immichVerification.detail}`);
      } else {
        immichVerification = { expected: imagesMoved, imported: 0, status: "skipped", detail: rescanResult.detail };
      }
    }

    // ── Archive disposition (post 100% verification) ─────────────────────────
    let dispositionApplied = "kept";
    let dispositionPending = false;

    if (job.sourceType === "archive" && job.archiveDisposition !== "keep") {
      if (job.archiveDisposition === "delete") {
        // REQUIRES explicit second confirmation — do NOT delete automatically
        dispositionPending = true;
        opLog(`DISPOSITION_PENDING: delete requires explicit confirmation via apply-disposition endpoint`);
        send("status", { stage: "disposition", message: "Archive delete requires your confirmation — see summary", progress: 92 });
      } else if (job.archiveDisposition === "move_to_processed") {
        send("status", { stage: "disposition", message: "Moving archive to processed folder…", progress: 92 });
        try {
          const processedDir = path.join(getWillardAIDir(nasPath), "archive-index", "processed");
          fs.mkdirSync(processedDir, { recursive: true });
          const dest = path.join(processedDir, path.basename(job.sourcePath));
          moveFile(job.sourcePath, dest);
          dispositionApplied = `moved_to:${dest}`;
          opLog(`DISPOSE_MOVE: ${job.sourcePath} → ${dest}`);
        } catch (e: any) {
          opLog(`DISPOSE_MOVE_FAIL: ${e.message}`);
        }
      }
    }

    // ── Report ───────────────────────────────────────────────────────────────
    send("status", { stage: "report", message: "Writing job report…", progress: 95 });

    const completedAt = new Date();
    const report: any = {
      jobId: id, completedAt: completedAt.toISOString(),
      sourceType: job.sourceType, sourcePath: job.sourcePath, archiveDisposition: job.archiveDisposition,
      filesFound: sourceFiles.length, filesMoved: moved, filesExcluded: excluded,
      filesVerified: fileMoves.length, dispositionApplied, dispositionPending,
      destinations: plan.destinations,
      destVerification,
      archiveCrcValidation: crcValidation,
      immichRescan: immichResult,
      immichVerification,
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

    opLog(`=== Job #${id} COMPLETED ${completedAt.toISOString()} — moved:${moved} excluded:${excluded} verified:${fileMoves.length} ===`);
    logStream?.end();

    await db.update(organizationJobsTable).set({
      status: "completed",
      fileMoves: fileMoves as any,
      reportJson: report as any,
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
        if (fs.existsSync(mv.to)) { moveFile(mv.to, mv.from); rolledBack++; opLog(`ROLLBACK: ${mv.to} → ${mv.from}`); }
      } catch (re: any) { opLog(`ROLLBACK_FAIL: ${mv.to} — ${re.message}`); }
    }

    opLog(`=== Job #${id} ROLLED_BACK ${rolledBack}/${fileMoves.length} moves reversed ===`);
    logStream?.end();

    await db.update(organizationJobsTable).set({
      status: "rolled_back", error: errMsg, fileMoves: fileMoves as any, completedAt: new Date(),
    }).where(eq(organizationJobsTable.id, id)).catch(() => {});

    send("error", { message: errMsg, rolledBack });
  } finally {
    for (const td of tempDirs) cleanTempDir(td);
    res.end();
  }
});

/**
 * Apply archive disposition after the user explicitly confirms.
 * Only valid for completed jobs with archiveDisposition === "delete".
 * The body must include { confirm: true } to proceed.
 */
router.post("/organize/jobs/:id/apply-disposition", async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const [job] = await db.select().from(organizationJobsTable).where(eq(organizationJobsTable.id, id)).limit(1);
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    if (job.status !== "completed") { res.status(409).json({ error: "Job must be completed before applying disposition" }); return; }
    if (!req.body?.confirm) { res.status(400).json({ error: "confirm: true is required to execute a destructive disposition" }); return; }

    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const nasPath = (settingsRows[0] as any)?.nasPath ?? "";

    let dispositionResult = "kept";
    if (job.archiveDisposition === "delete") {
      if (!fs.existsSync(job.sourcePath)) {
        res.json({ ok: true, dispositionResult: "already_gone", sourcePath: job.sourcePath }); return;
      }
      fs.unlinkSync(job.sourcePath);
      dispositionResult = "deleted";
    } else if (job.archiveDisposition === "move_to_processed") {
      const processedDir = path.join(getWillardAIDir(nasPath), "archive-index", "processed");
      fs.mkdirSync(processedDir, { recursive: true });
      const dest = path.join(processedDir, path.basename(job.sourcePath));
      moveFile(job.sourcePath, dest);
      dispositionResult = `moved_to:${dest}`;
    }

    res.json({ ok: true, dispositionResult, sourcePath: job.sourcePath });
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? "Failed to apply disposition" });
  }
});

export default router;
