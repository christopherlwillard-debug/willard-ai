import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { appSettingsTable, conversionJobsTable } from "@workspace/db";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { desc, eq } from "drizzle-orm";
import { assertWithinRoot, getWillardAIDir } from "../lib/nas-storage";
import { openai } from "@workspace/integrations-openai-ai-server";

const router: IRouter = Router();

// ── Format classification rules ───────────────────────────────────────────────

type QualityLoss = "none" | "minimal" | "moderate" | "high";
type FormatStatus = "protected" | "optimal" | "convert" | "skip";
type MediaCategory = "image" | "video" | "audio" | "document" | "other";

interface FormatRule {
  status:                FormatStatus;
  category:              MediaCategory;
  reason:                string;
  targetFormat?:         string;
  targetExt?:            string; // actual file extension for output
  qualityLoss?:          QualityLoss;
  estimatedSavingsRatio?: number; // 0-1 fraction of space potentially saved
}

const FORMAT_RULES: Record<string, FormatRule> = {
  // ── RAW camera formats — never convert ──────────────────────────────────────
  cr2:  { status: "protected", category: "image", reason: "Canon RAW — irreplaceable sensor data, never convert" },
  cr3:  { status: "protected", category: "image", reason: "Canon RAW — irreplaceable sensor data, never convert" },
  nef:  { status: "protected", category: "image", reason: "Nikon RAW — irreplaceable sensor data, never convert" },
  nrw:  { status: "protected", category: "image", reason: "Nikon RAW — irreplaceable sensor data, never convert" },
  arw:  { status: "protected", category: "image", reason: "Sony RAW — irreplaceable sensor data, never convert" },
  srf:  { status: "protected", category: "image", reason: "Sony RAW — irreplaceable sensor data, never convert" },
  sr2:  { status: "protected", category: "image", reason: "Sony RAW — irreplaceable sensor data, never convert" },
  dng:  { status: "protected", category: "image", reason: "Digital Negative RAW — universal RAW format, never convert" },
  raf:  { status: "protected", category: "image", reason: "Fujifilm RAW — irreplaceable sensor data, never convert" },
  orf:  { status: "protected", category: "image", reason: "Olympus RAW — irreplaceable sensor data, never convert" },
  rw2:  { status: "protected", category: "image", reason: "Panasonic RAW — irreplaceable sensor data, never convert" },
  pef:  { status: "protected", category: "image", reason: "Pentax RAW — irreplaceable sensor data, never convert" },
  x3f:  { status: "protected", category: "image", reason: "Sigma RAW — irreplaceable sensor data, never convert" },
  rwl:  { status: "protected", category: "image", reason: "Leica RAW — irreplaceable sensor data, never convert" },
  raw:  { status: "protected", category: "image", reason: "RAW camera format — irreplaceable sensor data, never convert" },
  "3fr": { status: "protected", category: "image", reason: "Hasselblad RAW — irreplaceable sensor data, never convert" },
  fff:   { status: "protected", category: "image", reason: "Hasselblad RAW — irreplaceable sensor data, never convert" },
  iiq:   { status: "protected", category: "image", reason: "Phase One RAW — irreplaceable sensor data, never convert" },
  mrw:  { status: "protected", category: "image", reason: "Minolta RAW — irreplaceable sensor data, never convert" },

  // ── Professional video/broadcast — never convert ──────────────────────────
  mxf:  { status: "protected", category: "video", reason: "Professional broadcast container (DNxHD/DNxHR) — lossless master, never convert" },
  // ProRes (.mov) cannot be detected by extension alone — .mov is flagged with a warning in reason

  // ── Already-optimal image formats ─────────────────────────────────────────
  webp: { status: "optimal", category: "image", reason: "WebP — modern efficient format with excellent quality/size ratio, no action needed" },
  avif: { status: "optimal", category: "image", reason: "AVIF — best-in-class compression, no action needed" },
  heic: { status: "optimal", category: "image", reason: "HEIC — modern Apple format with excellent quality/size ratio, no action needed" },
  heif: { status: "optimal", category: "image", reason: "HEIF — modern format with excellent quality/size ratio, no action needed" },
  jxl:  { status: "optimal", category: "image", reason: "JPEG XL — next-generation format, no action needed" },

  // ── Already-optimal video formats ─────────────────────────────────────────
  mp4:  { status: "optimal", category: "video", reason: "MP4 container — typically uses H.264 or H.265 codec. Already space-efficient; no action needed" },
  webm: { status: "optimal", category: "video", reason: "WebM — modern open format with efficient VP8/VP9/AV1 codecs, no action needed" },
  m4v:  { status: "optimal", category: "video", reason: "M4V — modern Apple video format, no action needed" },

  // ── Image conversion candidates ────────────────────────────────────────────
  bmp: {
    status: "convert", category: "image",
    targetFormat: "WebP",
    targetExt: "webp",
    qualityLoss: "none",
    estimatedSavingsRatio: 0.72,
    reason: "Uncompressed bitmap — converting to PNG (lossless) or WebP saves 65–80% with zero quality loss",
  },
  tiff: {
    status: "convert", category: "image",
    targetFormat: "WebP",
    targetExt: "webp",
    qualityLoss: "none",
    estimatedSavingsRatio: 0.55,
    reason: "TIFF files are typically uncompressed — converting to WebP or PNG saves 40–60% with no visible quality loss",
  },
  tif: {
    status: "convert", category: "image",
    targetFormat: "WebP",
    targetExt: "webp",
    qualityLoss: "none",
    estimatedSavingsRatio: 0.55,
    reason: "TIFF files are typically uncompressed — converting to WebP or PNG saves 40–60% with no visible quality loss",
  },
  png: {
    status: "convert", category: "image",
    targetFormat: "WebP",
    targetExt: "webp",
    qualityLoss: "minimal",
    estimatedSavingsRatio: 0.30,
    reason: "WebP provides 25–35% better compression than PNG with near-identical visual quality",
  },
  jpg: {
    status: "convert", category: "image",
    targetFormat: "WebP",
    targetExt: "webp",
    qualityLoss: "minimal",
    estimatedSavingsRatio: 0.27,
    reason: "WebP provides 25–30% better compression than JPEG at equivalent visual quality",
  },
  jpeg: {
    status: "convert", category: "image",
    targetFormat: "WebP",
    targetExt: "webp",
    qualityLoss: "minimal",
    estimatedSavingsRatio: 0.27,
    reason: "WebP provides 25–30% better compression than JPEG at equivalent visual quality",
  },
  gif: {
    status: "convert", category: "image",
    targetFormat: "WebP",
    targetExt: "webp",
    qualityLoss: "minimal",
    estimatedSavingsRatio: 0.42,
    reason: "WebP supports animation and delivers 40%+ space savings over GIF with better color depth",
  },

  // ── Video conversion candidates ────────────────────────────────────────────
  avi: {
    status: "convert", category: "video",
    targetFormat: "MP4 (H.265/HEVC)",
    targetExt: "mp4",
    qualityLoss: "minimal",
    estimatedSavingsRatio: 0.62,
    reason: "AVI is a legacy container — H.265 MP4 saves 55–70% with near-identical quality",
  },
  wmv: {
    status: "convert", category: "video",
    targetFormat: "MP4 (H.265/HEVC)",
    targetExt: "mp4",
    qualityLoss: "minimal",
    estimatedSavingsRatio: 0.65,
    reason: "WMV is a legacy Windows format — H.265 MP4 saves 60–70% with equivalent quality",
  },
  flv: {
    status: "convert", category: "video",
    targetFormat: "MP4 (H.265/HEVC)",
    targetExt: "mp4",
    qualityLoss: "minimal",
    estimatedSavingsRatio: 0.60,
    reason: "Flash Video is obsolete — H.265 MP4 saves 55–65% with equivalent quality",
  },
  mpeg: {
    status: "convert", category: "video",
    targetFormat: "MP4 (H.265/HEVC)",
    targetExt: "mp4",
    qualityLoss: "minimal",
    estimatedSavingsRatio: 0.72,
    reason: "MPEG-1/2 uses outdated codecs — H.265 saves 65–75% space at similar visual quality",
  },
  mpg: {
    status: "convert", category: "video",
    targetFormat: "MP4 (H.265/HEVC)",
    targetExt: "mp4",
    qualityLoss: "minimal",
    estimatedSavingsRatio: 0.72,
    reason: "MPEG is an older format — H.265 MP4 saves 65–75% space at similar visual quality",
  },
  m2ts: {
    status: "convert", category: "video",
    targetFormat: "MP4 (H.265/HEVC)",
    targetExt: "mp4",
    qualityLoss: "minimal",
    estimatedSavingsRatio: 0.55,
    reason: "Blu-ray container — H.265 MP4 saves 50–60% with near-identical quality",
  },
  ts: {
    status: "convert", category: "video",
    targetFormat: "MP4 (H.265/HEVC)",
    targetExt: "mp4",
    qualityLoss: "minimal",
    estimatedSavingsRatio: 0.52,
    reason: "Transport stream format — H.265 MP4 saves 45–55% with near-identical quality",
  },
  mov: {
    status: "protected", category: "video",
    reason: "QuickTime (.mov) container — may contain Apple ProRes or other professional codecs. Classified as protected by default. Do not convert without manually verifying the codec (e.g. via ffprobe). Keep original.",
  },
  mkv: {
    status: "convert", category: "video",
    targetFormat: "MP4 (H.265/HEVC)",
    targetExt: "mp4",
    qualityLoss: "minimal",
    estimatedSavingsRatio: 0.40,
    reason: "MKV with H.264 content — re-encoding to H.265 saves 35–45% space",
  },
  rmvb: {
    status: "convert", category: "video",
    targetFormat: "MP4 (H.265/HEVC)",
    targetExt: "mp4",
    qualityLoss: "minimal",
    estimatedSavingsRatio: 0.55,
    reason: "RealMedia is a legacy format — H.265 MP4 saves 50–60% with equivalent quality",
  },
  asf: {
    status: "convert", category: "video",
    targetFormat: "MP4 (H.265/HEVC)",
    targetExt: "mp4",
    qualityLoss: "minimal",
    estimatedSavingsRatio: 0.60,
    reason: "ASF/WMV container — H.265 MP4 saves 55–65% with equivalent quality",
  },

  // ── Known audio formats (out of scope but categorized) ─────────────────────
  mp3:  { status: "optimal", category: "audio", reason: "MP3 — widely compatible format. No action needed (audio optimization is out of scope)" },
  aac:  { status: "optimal", category: "audio", reason: "AAC — efficient modern audio format, no action needed" },
  flac: { status: "optimal", category: "audio", reason: "FLAC — lossless audio, no action needed" },
  ogg:  { status: "optimal", category: "audio", reason: "Ogg Vorbis — efficient open format, no action needed" },
  opus: { status: "optimal", category: "audio", reason: "Opus — best-in-class audio efficiency, no action needed" },
  m4a:  { status: "optimal", category: "audio", reason: "M4A/AAC — efficient format, no action needed" },
  wav:  { status: "skip", category: "audio", reason: "WAV is uncompressed audio — consider lossless FLAC (audio optimization is out of scope for this release)" },
  aiff: { status: "skip", category: "audio", reason: "AIFF is uncompressed audio — consider lossless FLAC (audio optimization is out of scope for this release)" },
  wma:  { status: "skip", category: "audio", reason: "WMA is a legacy Windows audio format (audio optimization is out of scope for this release)" },

  // ── Document formats (out of scope but categorized) ───────────────────────
  pdf:  { status: "optimal", category: "document", reason: "PDF — widely compatible. No action needed (document optimization is out of scope)" },
  docx: { status: "optimal", category: "document", reason: "DOCX — standard format, no action needed" },
  doc:  { status: "skip",    category: "document", reason: "Legacy DOC format — consider converting to DOCX (document optimization is out of scope for this release)" },
  psd:  { status: "protected", category: "image",  reason: "Photoshop PSD — layered project file, never convert the master" },
  ai:   { status: "protected", category: "image",  reason: "Adobe Illustrator file — creative master, never convert" },
  xcf:  { status: "protected", category: "image",  reason: "GIMP project file — layered master, never convert" },
};

// ── Optimize scan cache ────────────────────────────────────────────────────────

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_FILENAME = "optimize-scan.json";

function getCachePath(nasPath: string): string {
  return path.join(getWillardAIDir(nasPath), "cache", CACHE_FILENAME);
}

function readScanCache(nasPath: string): (Record<string, unknown> & { scannedAt: string }) | null {
  try {
    const cachePath = getCachePath(nasPath);
    if (!fs.existsSync(cachePath)) return null;
    const raw = fs.readFileSync(cachePath, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown> & { scannedAt: string };
    if (!data.scannedAt) return null;
    const age = Date.now() - new Date(data.scannedAt).getTime();
    if (age > CACHE_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function writeScanCache(nasPath: string, data: Record<string, unknown>): void {
  try {
    const cacheDir = path.join(getWillardAIDir(nasPath), "cache");
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(getCachePath(nasPath), JSON.stringify(data), "utf-8");
  } catch {
    // Non-fatal — cache write is best-effort
  }
}

// ── NAS directory walker ───────────────────────────────────────────────────────

interface SampleFile { path: string; sizeBytes: number; }
interface ExtGroup   { count: number; bytes: number; samples: SampleFile[]; }

const SKIP_DIRS = new Set(["WillardAI", "node_modules", ".git", "$RECYCLE.BIN", "System Volume Information", ".Trash-1000"]);

/** Keep the top-3 largest sample files per extension. */
function insertSample(samples: SampleFile[], filePath: string, size: number): void {
  samples.push({ path: filePath, sizeBytes: size });
  samples.sort((a, b) => b.sizeBytes - a.sizeBytes);
  if (samples.length > 3) samples.pop();
}

function walkForOptimize(
  dir: string,
  groups: Map<string, ExtGroup>,
  maxFiles: number,
  counter: { total: number },
): void {
  if (counter.total >= maxFiles) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (counter.total >= maxFiles) return;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
        walkForOptimize(path.join(dir, entry.name), groups, maxFiles, counter);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      if (!ext || ext.length > 10) continue;
      const fullPath = path.join(dir, entry.name);
      let size = 0;
      try { size = fs.statSync(fullPath).size; } catch { /* skip unreadable */ }
      const curr = groups.get(ext) ?? { count: 0, bytes: 0, samples: [] };
      insertSample(curr.samples, fullPath, size);
      groups.set(ext, { count: curr.count + 1, bytes: curr.bytes + size, samples: curr.samples });
      counter.total++;
    }
  }
}

/** Walk NAS collecting files whose extension matches approvedExts (skips WillardAI dir and backup dir). */
function walkForConversion(
  dir: string,
  approvedExtSet: Set<string>,
  results: Array<{ fullPath: string; ext: string }>,
  skipDirs: Set<string>,
): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".") && !skipDirs.has(fullPath)) {
        walkForConversion(fullPath, approvedExtSet, results, skipDirs);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      if (approvedExtSet.has(ext)) {
        results.push({ fullPath, ext });
      }
    }
  }
}

// ── Conversion helpers ─────────────────────────────────────────────────────────

/** Convert an image to webp using ffmpeg. Returns null on success, error string on failure. */
function convertImage(srcPath: string, destPath: string): string | null {
  const result = spawnSync("ffmpeg", [
    "-y",
    "-i", srcPath,
    "-quality", "85",
    destPath,
  ], { encoding: "utf8", stdio: "pipe", timeout: 120_000 });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").slice(-500);
    return `ffmpeg exited ${result.status}: ${stderr}`;
  }
  return null;
}

/** Convert a video to H.265 MP4 using ffmpeg. Returns null on success, error string on failure. */
function convertVideo(srcPath: string, destPath: string): string | null {
  const result = spawnSync("ffmpeg", [
    "-y",
    "-i", srcPath,
    "-c:v", "libx265",
    "-crf", "28",
    "-preset", "medium",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    destPath,
  ], { encoding: "utf8", stdio: "pipe", timeout: 3_600_000 }); // 1h max per video
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").slice(-500);
    return `ffmpeg exited ${result.status}: ${stderr}`;
  }
  return null;
}

// ── Endpoints ─────────────────────────────────────────────────────────────────

router.get("/optimize/scan", async (req, res) => {
  try {
    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const settings = settingsRows[0] as any ?? {};
    const nasPath = (settings.nasPath ?? "").trim();
    if (!nasPath || !fs.existsSync(nasPath)) {
      res.status(400).json({ error: "NAS path is not configured or not accessible" });
      return;
    }

    assertWithinRoot(path.resolve(nasPath), path.resolve(nasPath));

    // ── Return cached result if fresh enough and not forcing a re-scan ──────
    const force = req.query.force === "true";
    if (!force) {
      const cached = readScanCache(nasPath);
      if (cached) {
        res.json({ ...cached, fromCache: true });
        return;
      }
    }

    const groups = new Map<string, ExtGroup>();
    const counter = { total: 0 };
    walkForOptimize(nasPath, groups, 500_000, counter);

    const result = [];
    let totalSavingsBytes = 0;

    for (const [ext, { count, bytes, samples }] of groups.entries()) {
      const rule = FORMAT_RULES[ext];
      const status: FormatStatus = rule?.status ?? "skip";
      const category: MediaCategory = rule?.category ?? "other";
      const savings = rule?.estimatedSavingsRatio ? Math.round(bytes * rule.estimatedSavingsRatio) : 0;
      if (status === "convert") totalSavingsBytes += savings;

      // Enrich sample files with estimated post-conversion size
      const sampleFiles = samples.map(s => ({
        path:              s.path,
        sizeBytes:         s.sizeBytes,
        estimatedAfterBytes: rule?.estimatedSavingsRatio
          ? Math.round(s.sizeBytes * (1 - rule.estimatedSavingsRatio))
          : s.sizeBytes,
      }));

      result.push({
        extension:             ext,
        fileCount:             count,
        totalBytes:            bytes,
        category,
        status,
        targetFormat:          rule?.targetFormat ?? null,
        qualityLoss:           rule?.qualityLoss ?? null,
        estimatedSavingsBytes: savings,
        estimatedSavingsRatio: rule?.estimatedSavingsRatio ?? null,
        reason:                rule?.reason ?? `Unknown format — no conversion recommendation available`,
        sampleFiles,
      });
    }

    // Sort: convert first (by savings desc), then protected, then optimal, then skip/unknown
    const ORDER: Record<FormatStatus, number> = { convert: 0, protected: 1, optimal: 2, skip: 3 };
    result.sort((a, b) => {
      const orderDiff = (ORDER[a.status] ?? 4) - (ORDER[b.status] ?? 4);
      if (orderDiff !== 0) return orderDiff;
      return b.estimatedSavingsBytes - a.estimatedSavingsBytes;
    });

    const payload = {
      scannedAt: new Date().toISOString(),
      nasPath,
      totalFiles: counter.total,
      totalBytes: result.reduce((s, g) => s + g.totalBytes, 0),
      totalSavingsBytes,
      groups: result,
      fromCache: false,
    };

    writeScanCache(nasPath, payload);
    res.json(payload);
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? "Scan failed" });
  }
});

router.post("/optimize/ai-summary", async (req, res) => {
  try {
    const { groups, totalFiles, totalBytes, totalSavingsBytes } = req.body as {
      groups: Array<{
        extension: string; fileCount: number; totalBytes: number;
        status: string; targetFormat?: string; estimatedSavingsBytes: number;
      }>;
      totalFiles: number;
      totalBytes: number;
      totalSavingsBytes: number;
    };

    if (!groups || !Array.isArray(groups)) {
      res.status(400).json({ error: "groups array required" });
      return;
    }

    const convertible = groups.filter(g => g.status === "convert");
    const formatSummary = convertible
      .slice(0, 10)
      .map(g => `  - ${g.fileCount} .${g.extension} files (${(g.totalBytes / 1e9).toFixed(2)} GB) → ${g.targetFormat ?? "better format"}, saves ~${(g.estimatedSavingsBytes / 1e9).toFixed(2)} GB`)
      .join("\n");

    const prompt = `You are analyzing a media library on a home NAS server. Based on the following format scan, write a concise plain-English summary (2-4 sentences) of the optimization opportunity. Be specific about the numbers. Focus on the biggest wins. Avoid technical jargon.

Scan summary:
- Total files scanned: ${totalFiles.toLocaleString()}
- Total storage used: ${(totalBytes / 1e9).toFixed(1)} GB
- Estimated recoverable storage: ${(totalSavingsBytes / 1e9).toFixed(1)} GB
- Formats with conversion potential:
${formatSummary || "  (none)"}

Write only the summary paragraph. No headers, no bullet points, no markdown.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
      temperature: 0.4,
    });

    const summary = completion.choices[0]?.message?.content?.trim() ?? "Analysis complete.";
    res.json({ summary });
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? "AI summary failed" });
  }
});

// ── Conversion job endpoints ───────────────────────────────────────────────────

/** POST /optimize/run — create a new conversion job. */
router.post("/optimize/run", async (req, res) => {
  try {
    const { approvedExts, backupDir } = req.body as {
      approvedExts: string[];
      backupDir?: string;
    };

    if (!Array.isArray(approvedExts) || approvedExts.length === 0) {
      res.status(400).json({ error: "approvedExts must be a non-empty array of extensions" });
      return;
    }

    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const settings = settingsRows[0] as any ?? {};
    const nasPath = (settings.nasPath ?? "").trim();
    if (!nasPath || !fs.existsSync(nasPath)) {
      res.status(400).json({ error: "NAS path is not configured or not accessible" });
      return;
    }

    // Validate all extensions are known convert-status rules
    for (const ext of approvedExts) {
      const rule = FORMAT_RULES[ext.toLowerCase()];
      if (!rule || rule.status !== "convert") {
        res.status(400).json({ error: `Extension "${ext}" is not a convertible format` });
        return;
      }
    }

    // Resolve backup dir (default: WillardAI/ConversionBackups/<timestamp>)
    const resolvedBackupDir = backupDir?.trim()
      || path.join(nasPath, "WillardAI", "ConversionBackups", new Date().toISOString().slice(0, 19).replace(/:/g, "-"));

    // Validate backup dir is within NAS root
    try { assertWithinRoot(path.resolve(resolvedBackupDir), path.resolve(nasPath)); }
    catch { res.status(400).json({ error: "Backup directory must be within the NAS root" }); return; }

    const [job] = await db.insert(conversionJobsTable).values({
      status:       "pending",
      approvedExts: approvedExts.map(e => e.toLowerCase()),
      backupDir:    resolvedBackupDir,
      nasPath,
      totalFiles:   0,
    }).returning();

    res.status(201).json(job);
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? "Failed to create conversion job" });
  }
});

/** GET /optimize/jobs — list recent conversion jobs. */
router.get("/optimize/jobs", async (_req, res) => {
  try {
    const jobs = await db.select().from(conversionJobsTable)
      .orderBy(desc(conversionJobsTable.createdAt))
      .limit(20);
    res.json(jobs);
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? "Failed to list jobs" });
  }
});

/**
 * POST /optimize/jobs/:id/retry — reset a failed conversion job back to pending
 * so the execute endpoint can re-run it from scratch.
 * The backup dir from the original (partial) run is preserved and carried over.
 */
router.post("/optimize/jobs/:id/retry", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid job id" }); return; }
    const [job] = await db.select().from(conversionJobsTable).where(eq(conversionJobsTable.id, id)).limit(1);
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    if (job.status !== "failed") {
      res.status(409).json({ error: `Cannot retry a job with status '${job.status}' — only failed jobs can be retried` });
      return;
    }
    const [updated] = await db
      .update(conversionJobsTable)
      .set({
        status:         "pending",
        error:          null,
        totalFiles:     0,
        processedFiles: 0,
        succeededFiles: 0,
        failedFiles:    0,
        skippedFiles:   0,
        resultJson:     null,
        completedAt:    null,
      })
      .where(eq(conversionJobsTable.id, id))
      .returning();
    res.json(updated);
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? "Failed to retry job" });
  }
});

/** GET /optimize/jobs/:id — get a single conversion job. */
router.get("/optimize/jobs/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [job] = await db.select().from(conversionJobsTable).where(eq(conversionJobsTable.id, id)).limit(1);
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    res.json(job);
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? "Failed to get job" });
  }
});

/**
 * GET /optimize/jobs/:id/execute — SSE stream that executes the conversion job.
 * Streams events: status | file_done | summary | error
 */
router.get("/optimize/jobs/:id/execute", async (req, res) => {
  const id = parseInt(req.params.id);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (event: string, data: object) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
  };

  try {
    const [job] = await db.select().from(conversionJobsTable).where(eq(conversionJobsTable.id, id)).limit(1);
    if (!job) { send("error", { message: "Job not found" }); res.end(); return; }
    if (job.status === "running") { send("error", { message: "Job is already running" }); res.end(); return; }
    if (job.status === "done" || job.status === "failed") {
      send("error", { message: `Job already ${job.status}` }); res.end(); return;
    }

    const nasPath     = job.nasPath;
    const backupDir   = job.backupDir!;
    const approvedExtSet = new Set<string>((job.approvedExts as string[]).map(e => e.toLowerCase()));

    await db.update(conversionJobsTable).set({ status: "running" }).where(eq(conversionJobsTable.id, id));
    send("status", { stage: "scanning", message: "Scanning NAS for files to convert…", progress: 2 });

    // Collect all matching files (skip backup dir and WillardAI dir)
    const skipDirs = new Set<string>([
      path.resolve(backupDir),
      path.resolve(path.join(nasPath, "WillardAI")),
    ]);
    const filesToConvert: Array<{ fullPath: string; ext: string }> = [];
    walkForConversion(path.resolve(nasPath), approvedExtSet, filesToConvert, skipDirs);

    const totalFiles = filesToConvert.length;
    await db.update(conversionJobsTable).set({ totalFiles }).where(eq(conversionJobsTable.id, id));

    if (totalFiles === 0) {
      send("status", { stage: "done", message: "No files found to convert", progress: 100 });
      await db.update(conversionJobsTable).set({
        status: "done",
        processedFiles: 0,
        succeededFiles: 0,
        failedFiles: 0,
        skippedFiles: 0,
        completedAt: new Date(),
        resultJson: { files: [] },
      }).where(eq(conversionJobsTable.id, id));
      send("summary", { totalFiles: 0, succeeded: 0, failed: 0, skipped: 0, results: [] });
      res.end();
      return;
    }

    send("status", { stage: "converting", message: `Found ${totalFiles} file${totalFiles !== 1 ? "s" : ""} to convert`, progress: 5, totalFiles });

    // Ensure backup dir exists
    fs.mkdirSync(backupDir, { recursive: true });

    let succeeded = 0;
    let failed    = 0;
    let skipped   = 0;
    const results: Array<{
      filePath: string;
      status:   "success" | "failed" | "skipped";
      originalBytes?: number;
      convertedBytes?: number;
      error?: string;
    }> = [];

    for (let i = 0; i < filesToConvert.length; i++) {
      const { fullPath, ext } = filesToConvert[i];
      const rule = FORMAT_RULES[ext];
      const targetExt = rule?.targetExt ?? (rule?.category === "video" ? "mp4" : "webp");
      const category  = rule?.category ?? "other";

      // Progress percentage: 5–95% during file processing
      const progress = 5 + Math.round(((i) / totalFiles) * 90);
      const shortName = path.basename(fullPath);
      send("status", {
        stage: "converting",
        message: `[${i + 1}/${totalFiles}] ${shortName}`,
        progress,
        currentFile: fullPath,
        processed: i,
        total: totalFiles,
      });

      // Skip if file no longer exists (may have been moved/deleted since scan)
      if (!fs.existsSync(fullPath)) {
        skipped++;
        results.push({ filePath: fullPath, status: "skipped", error: "File no longer exists" });
        await db.update(conversionJobsTable).set({ processedFiles: i + 1, skippedFiles: skipped }).where(eq(conversionJobsTable.id, id));
        send("file_done", { filePath: fullPath, status: "skipped", error: "File no longer exists", processed: i + 1, total: totalFiles });
        continue;
      }

      let originalBytes = 0;
      try { originalBytes = fs.statSync(fullPath).size; } catch { /* best effort */ }

      // ── Backup original ──────────────────────────────────────────────────────
      const relPath     = path.relative(path.resolve(nasPath), path.resolve(fullPath));
      const backupPath  = path.join(backupDir, relPath);
      try {
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.copyFileSync(fullPath, backupPath);
      } catch (backupErr: any) {
        failed++;
        const errMsg = `Backup failed: ${backupErr.message}`;
        results.push({ filePath: fullPath, status: "failed", error: errMsg });
        await db.update(conversionJobsTable).set({ processedFiles: i + 1, failedFiles: failed }).where(eq(conversionJobsTable.id, id));
        send("file_done", { filePath: fullPath, status: "failed", error: errMsg, processed: i + 1, total: totalFiles });
        continue;
      }

      // ── Convert ──────────────────────────────────────────────────────────────
      const stem      = path.basename(fullPath, path.extname(fullPath));
      const dir       = path.dirname(fullPath);
      const destPath  = path.join(dir, `${stem}.${targetExt}`);

      // If destination already exists with same name (e.g. .webp next to .png), skip
      if (fs.existsSync(destPath) && destPath !== fullPath) {
        skipped++;
        // Clean up the backup copy since we didn't convert
        try { fs.unlinkSync(backupPath); } catch { /* best effort */ }
        results.push({ filePath: fullPath, status: "skipped", error: `Output already exists: ${path.basename(destPath)}` });
        await db.update(conversionJobsTable).set({ processedFiles: i + 1, skippedFiles: skipped }).where(eq(conversionJobsTable.id, id));
        send("file_done", { filePath: fullPath, status: "skipped", error: `Output already exists: ${path.basename(destPath)}`, processed: i + 1, total: totalFiles });
        continue;
      }

      let convertError: string | null = null;
      if (category === "image") {
        convertError = convertImage(fullPath, destPath);
      } else if (category === "video") {
        convertError = convertVideo(fullPath, destPath);
      } else {
        convertError = `Unsupported category for conversion: ${category}`;
      }

      if (convertError) {
        // Remove any partial output
        try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch { /* best effort */ }
        // Restore original from backup
        try { fs.copyFileSync(backupPath, fullPath); } catch { /* best effort */ }
        failed++;
        results.push({ filePath: fullPath, status: "failed", error: convertError });
        await db.update(conversionJobsTable).set({ processedFiles: i + 1, failedFiles: failed }).where(eq(conversionJobsTable.id, id));
        send("file_done", { filePath: fullPath, status: "failed", error: convertError.slice(0, 300), processed: i + 1, total: totalFiles });
        continue;
      }

      // ── Remove original (backup is already in place) ─────────────────────────
      try { fs.unlinkSync(fullPath); } catch { /* original may already be gone */ }

      let convertedBytes = 0;
      try { convertedBytes = fs.statSync(destPath).size; } catch { /* best effort */ }

      succeeded++;
      results.push({ filePath: fullPath, status: "success", originalBytes, convertedBytes });
      await db.update(conversionJobsTable).set({ processedFiles: i + 1, succeededFiles: succeeded }).where(eq(conversionJobsTable.id, id));
      send("file_done", {
        filePath: fullPath,
        destPath,
        status: "success",
        originalBytes,
        convertedBytes,
        savedBytes: Math.max(0, originalBytes - convertedBytes),
        processed: i + 1,
        total: totalFiles,
      });
    }

    // ── Final summary ─────────────────────────────────────────────────────────
    const totalSaved = results.reduce((s, r) => s + Math.max(0, (r.originalBytes ?? 0) - (r.convertedBytes ?? 0)), 0);
    const resultJson = { files: results, totalSaved };

    await db.update(conversionJobsTable).set({
      status:         "done",
      processedFiles: totalFiles,
      succeededFiles: succeeded,
      failedFiles:    failed,
      skippedFiles:   skipped,
      completedAt:    new Date(),
      resultJson,
    }).where(eq(conversionJobsTable.id, id));

    send("status", { stage: "done", message: "Conversion complete", progress: 100 });
    send("summary", {
      totalFiles,
      succeeded,
      failed,
      skipped,
      totalSavedBytes: totalSaved,
      backupDir,
      results: results.slice(0, 200), // cap payload
    });
    res.end();
  } catch (e: any) {
    try {
      await db.update(conversionJobsTable).set({ status: "failed", error: e.message ?? "Unknown error" }).where(eq(conversionJobsTable.id, id));
    } catch { /* best effort */ }
    send("error", { message: e.message ?? "Conversion failed" });
    res.end();
  }
});

export default router;
