import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db";
import * as fs from "fs";
import * as path from "path";
import { assertWithinRoot } from "../lib/nas-storage";
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
    targetFormat: "WebP or PNG",
    qualityLoss: "none",
    estimatedSavingsRatio: 0.72,
    reason: "Uncompressed bitmap — converting to PNG (lossless) or WebP saves 65–80% with zero quality loss",
  },
  tiff: {
    status: "convert", category: "image",
    targetFormat: "WebP or PNG",
    qualityLoss: "none",
    estimatedSavingsRatio: 0.55,
    reason: "TIFF files are typically uncompressed — converting to WebP or PNG saves 40–60% with no visible quality loss",
  },
  tif: {
    status: "convert", category: "image",
    targetFormat: "WebP or PNG",
    qualityLoss: "none",
    estimatedSavingsRatio: 0.55,
    reason: "TIFF files are typically uncompressed — converting to WebP or PNG saves 40–60% with no visible quality loss",
  },
  png: {
    status: "convert", category: "image",
    targetFormat: "WebP",
    qualityLoss: "minimal",
    estimatedSavingsRatio: 0.30,
    reason: "WebP provides 25–35% better compression than PNG with near-identical visual quality",
  },
  jpg: {
    status: "convert", category: "image",
    targetFormat: "WebP",
    qualityLoss: "minimal",
    estimatedSavingsRatio: 0.27,
    reason: "WebP provides 25–30% better compression than JPEG at equivalent visual quality",
  },
  jpeg: {
    status: "convert", category: "image",
    targetFormat: "WebP",
    qualityLoss: "minimal",
    estimatedSavingsRatio: 0.27,
    reason: "WebP provides 25–30% better compression than JPEG at equivalent visual quality",
  },
  gif: {
    status: "convert", category: "image",
    targetFormat: "WebP",
    qualityLoss: "minimal",
    estimatedSavingsRatio: 0.42,
    reason: "WebP supports animation and delivers 40%+ space savings over GIF with better color depth",
  },

  // ── Video conversion candidates ────────────────────────────────────────────
  avi: {
    status: "convert", category: "video",
    targetFormat: "MP4 (H.265/HEVC)",
    qualityLoss: "minimal",
    estimatedSavingsRatio: 0.62,
    reason: "AVI is a legacy container — H.265 MP4 saves 55–70% with near-identical quality",
  },
  wmv: {
    status: "convert", category: "video",
    targetFormat: "MP4 (H.265/HEVC)",
    qualityLoss: "minimal",
    estimatedSavingsRatio: 0.65,
    reason: "WMV is a legacy Windows format — H.265 MP4 saves 60–70% with equivalent quality",
  },
  flv: {
    status: "convert", category: "video",
    targetFormat: "MP4 (H.265/HEVC)",
    qualityLoss: "minimal",
    estimatedSavingsRatio: 0.60,
    reason: "Flash Video is obsolete — H.265 MP4 saves 55–65% with equivalent quality",
  },
  mpeg: {
    status: "convert", category: "video",
    targetFormat: "MP4 (H.265/HEVC)",
    qualityLoss: "minimal",
    estimatedSavingsRatio: 0.72,
    reason: "MPEG-1/2 uses outdated codecs — H.265 saves 65–75% space at similar visual quality",
  },
  mpg: {
    status: "convert", category: "video",
    targetFormat: "MP4 (H.265/HEVC)",
    qualityLoss: "minimal",
    estimatedSavingsRatio: 0.72,
    reason: "MPEG is an older format — H.265 MP4 saves 65–75% space at similar visual quality",
  },
  m2ts: {
    status: "convert", category: "video",
    targetFormat: "MP4 (H.265/HEVC)",
    qualityLoss: "minimal",
    estimatedSavingsRatio: 0.55,
    reason: "Blu-ray container — H.265 MP4 saves 50–60% with near-identical quality",
  },
  ts: {
    status: "convert", category: "video",
    targetFormat: "MP4 (H.265/HEVC)",
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
    qualityLoss: "minimal",
    estimatedSavingsRatio: 0.40,
    reason: "MKV with H.264 content — re-encoding to H.265 saves 35–45% space",
  },
  rmvb: {
    status: "convert", category: "video",
    targetFormat: "MP4 (H.265/HEVC)",
    qualityLoss: "minimal",
    estimatedSavingsRatio: 0.55,
    reason: "RealMedia is a legacy format — H.265 MP4 saves 50–60% with equivalent quality",
  },
  asf: {
    status: "convert", category: "video",
    targetFormat: "MP4 (H.265/HEVC)",
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

// ── Endpoints ─────────────────────────────────────────────────────────────────

router.get("/optimize/scan", async (_req, res) => {
  try {
    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const settings = settingsRows[0] as any ?? {};
    const nasPath = (settings.nasPath ?? "").trim();
    if (!nasPath || !fs.existsSync(nasPath)) {
      res.status(400).json({ error: "NAS path is not configured or not accessible" });
      return;
    }

    assertWithinRoot(path.resolve(nasPath), path.resolve(nasPath));

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

    res.json({
      scannedAt: new Date().toISOString(),
      nasPath,
      totalFiles: counter.total,
      totalBytes: result.reduce((s, g) => s + g.totalBytes, 0),
      totalSavingsBytes,
      groups: result,
    });
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

export default router;
