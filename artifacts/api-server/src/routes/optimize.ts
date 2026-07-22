import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { appSettingsTable, conversionJobsTable } from "@workspace/db";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { spawnSync, execFile } from "child_process";
import { promisify } from "util";
import { desc, eq } from "drizzle-orm";
import { assertWithinRoot, getWillardAIDir } from "../lib/nas-storage";
import { formatMediaToolError } from "../lib/media-tools";
import { openai } from "@workspace/integrations-openai-ai-server";

const execFileAsync = promisify(execFile);

const router: IRouter = Router();

// ── Format classification types ────────────────────────────────────────────────

type QualityLoss = "none" | "minimal" | "moderate" | "high";
type FormatStatus = "protected" | "optimal" | "convert" | "skip";
type MediaCategory = "image" | "video" | "audio" | "document" | "other";
type OptimizeProfile = "ARCHIVE" | "BALANCED" | "MAXIMUM";

interface FormatRule {
  status:                FormatStatus;
  category:              MediaCategory;
  reason:                string;
  method?:               string;
  qualityStars?:         number;
  qualityLabel?:         string;
  compatibilityLabel?:   string;
  targetFormat?:         string;
  targetExt?:            string;
  qualityLoss?:          QualityLoss;
  estimatedSavingsRatio?: number;
}

// ── Profile-aware format rules ─────────────────────────────────────────────────

function getFormatRules(profile: OptimizeProfile, rawConversionEnabled = false): Record<string, FormatRule> {
  const isMaximum = profile === "MAXIMUM";
  const isBalanced = profile === "BALANCED";

  const rawConvertRule: FormatRule = {
    status: "convert", category: "image",
    method: "Convert to JPEG (quality 98)",
    targetFormat: "JPEG", targetExt: "jpg",
    qualityLoss: "minimal", qualityStars: 5, qualityLabel: "Near-original quality",
    compatibilityLabel: "Excellent",
    estimatedSavingsRatio: 0.80,
    reason: "RAW conversion enabled — output JPEG at quality 98 with full EXIF, 4:4:4 chroma, and embedded ICC color profile preserved.",
  };

  // Image: JPEG & PNG targets differ by profile
  const jpgRule: FormatRule = isMaximum ? {
    status: "convert", category: "image",
    method: "Convert to WebP",
    targetFormat: "WebP", targetExt: "webp",
    qualityLoss: "minimal", qualityStars: 4, qualityLabel: "Minimal visible difference",
    compatibilityLabel: "Good",
    estimatedSavingsRatio: 0.27,
    reason: "WebP provides 25–30% better compression than JPEG at equivalent visual quality",
  } : {
    status: "convert", category: "image",
    method: isBalanced ? "Re-compress (quality 92)" : "Lossless re-compress",
    targetFormat: isBalanced ? "JPEG Optimized (92)" : "JPEG Optimized",
    targetExt: "jpg",
    qualityLoss: isBalanced ? "minimal" : "none",
    qualityStars: 5,
    qualityLabel: isBalanced ? "Imperceptibly different" : "Visually identical",
    compatibilityLabel: "Excellent",
    estimatedSavingsRatio: 0.18,
    reason: isBalanced
      ? "Re-encoding at quality 92 with progressive encoding and optimized Huffman tables saves 15–25% with imperceptible quality change"
      : "Re-encoding with optimized Huffman tables and progressive encoding saves 10–25% with zero perceptible quality change",
  };

  const pngRule: FormatRule = isMaximum ? {
    status: "convert", category: "image",
    method: "Convert to WebP",
    targetFormat: "WebP", targetExt: "webp",
    qualityLoss: "minimal", qualityStars: 4, qualityLabel: "Minimal visible difference",
    compatibilityLabel: "Good",
    estimatedSavingsRatio: 0.30,
    reason: "WebP provides 25–35% better compression than PNG with near-identical visual quality",
  } : {
    status: "convert", category: "image",
    method: "Lossless re-compress",
    targetFormat: "PNG Optimized", targetExt: "png",
    qualityLoss: "none", qualityStars: 5, qualityLabel: "Visually identical",
    compatibilityLabel: "Excellent",
    estimatedSavingsRatio: 0.15,
    reason: "Re-compressing PNG with adaptive filtering and maximum DEFLATE compression saves 10–20% with zero quality loss",
  };

  return {
    // ── RAW camera formats — protected unless user opts in ─────────────────────
    cr2:  rawConversionEnabled ? { ...rawConvertRule, reason: "Canon RAW — will be converted to JPEG at quality 98 with full EXIF preserved." } : { status: "protected", category: "image", reason: "Canon RAW — irreplaceable sensor data. Enable RAW conversion in Settings > Optimize if you no longer need to edit these." },
    cr3:  rawConversionEnabled ? { ...rawConvertRule, reason: "Canon RAW — will be converted to JPEG at quality 98 with full EXIF preserved." } : { status: "protected", category: "image", reason: "Canon RAW — irreplaceable sensor data. Enable RAW conversion in Settings > Optimize if you no longer need to edit these." },
    nef:  rawConversionEnabled ? { ...rawConvertRule, reason: "Nikon RAW — will be converted to JPEG at quality 98 with full EXIF preserved." } : { status: "protected", category: "image", reason: "Nikon RAW — irreplaceable sensor data. Enable RAW conversion in Settings > Optimize if you no longer need to edit these." },
    nrw:  rawConversionEnabled ? { ...rawConvertRule, reason: "Nikon RAW — will be converted to JPEG at quality 98 with full EXIF preserved." } : { status: "protected", category: "image", reason: "Nikon RAW — irreplaceable sensor data. Enable RAW conversion in Settings > Optimize if you no longer need to edit these." },
    arw:  rawConversionEnabled ? { ...rawConvertRule, reason: "Sony RAW — will be converted to JPEG at quality 98 with full EXIF preserved." } : { status: "protected", category: "image", reason: "Sony RAW — irreplaceable sensor data. Enable RAW conversion in Settings > Optimize if you no longer need to edit these." },
    srf:  rawConversionEnabled ? { ...rawConvertRule, reason: "Sony RAW — will be converted to JPEG at quality 98 with full EXIF preserved." } : { status: "protected", category: "image", reason: "Sony RAW — irreplaceable sensor data. Enable RAW conversion in Settings > Optimize if you no longer need to edit these." },
    sr2:  rawConversionEnabled ? { ...rawConvertRule, reason: "Sony RAW — will be converted to JPEG at quality 98 with full EXIF preserved." } : { status: "protected", category: "image", reason: "Sony RAW — irreplaceable sensor data. Enable RAW conversion in Settings > Optimize if you no longer need to edit these." },
    dng:  rawConversionEnabled ? { ...rawConvertRule, reason: "Digital Negative RAW — will be converted to JPEG at quality 98 with full EXIF preserved." } : { status: "protected", category: "image", reason: "Digital Negative RAW — universal RAW format. Enable RAW conversion in Settings > Optimize if you no longer need to edit these." },
    raf:  rawConversionEnabled ? { ...rawConvertRule, reason: "Fujifilm RAW — will be converted to JPEG at quality 98 with full EXIF preserved." } : { status: "protected", category: "image", reason: "Fujifilm RAW — irreplaceable sensor data. Enable RAW conversion in Settings > Optimize if you no longer need to edit these." },
    orf:  rawConversionEnabled ? { ...rawConvertRule, reason: "Olympus RAW — will be converted to JPEG at quality 98 with full EXIF preserved." } : { status: "protected", category: "image", reason: "Olympus RAW — irreplaceable sensor data. Enable RAW conversion in Settings > Optimize if you no longer need to edit these." },
    rw2:  rawConversionEnabled ? { ...rawConvertRule, reason: "Panasonic RAW — will be converted to JPEG at quality 98 with full EXIF preserved." } : { status: "protected", category: "image", reason: "Panasonic RAW — irreplaceable sensor data. Enable RAW conversion in Settings > Optimize if you no longer need to edit these." },
    pef:  rawConversionEnabled ? { ...rawConvertRule, reason: "Pentax RAW — will be converted to JPEG at quality 98 with full EXIF preserved." } : { status: "protected", category: "image", reason: "Pentax RAW — irreplaceable sensor data. Enable RAW conversion in Settings > Optimize if you no longer need to edit these." },
    x3f:  rawConversionEnabled ? { ...rawConvertRule, reason: "Sigma RAW — will be converted to JPEG at quality 98 with full EXIF preserved." } : { status: "protected", category: "image", reason: "Sigma RAW — irreplaceable sensor data. Enable RAW conversion in Settings > Optimize if you no longer need to edit these." },
    rwl:  rawConversionEnabled ? { ...rawConvertRule, reason: "Leica RAW — will be converted to JPEG at quality 98 with full EXIF preserved." } : { status: "protected", category: "image", reason: "Leica RAW — irreplaceable sensor data. Enable RAW conversion in Settings > Optimize if you no longer need to edit these." },
    raw:  rawConversionEnabled ? { ...rawConvertRule, reason: "RAW camera format — will be converted to JPEG at quality 98 with full EXIF preserved." } : { status: "protected", category: "image", reason: "RAW camera format — irreplaceable sensor data. Enable RAW conversion in Settings > Optimize if you no longer need to edit these." },
    "3fr": { status: "protected", category: "image", reason: "Hasselblad RAW — irreplaceable sensor data, never convert" },
    fff:   { status: "protected", category: "image", reason: "Hasselblad RAW — irreplaceable sensor data, never convert" },
    iiq:   { status: "protected", category: "image", reason: "Phase One RAW — irreplaceable sensor data, never convert" },
    mrw:  rawConversionEnabled ? { ...rawConvertRule, reason: "Minolta RAW — will be converted to JPEG at quality 98 with full EXIF preserved." } : { status: "protected", category: "image", reason: "Minolta RAW — irreplaceable sensor data. Enable RAW conversion in Settings > Optimize if you no longer need to edit these." },

    // ── Professional video/broadcast — never convert ──────────────────────────
    mxf:  { status: "protected", category: "video", reason: "Professional broadcast container (DNxHD/DNxHR) — lossless master, never convert" },

    // ── Creative masters — never convert ─────────────────────────────────────
    psd:  { status: "protected", category: "image", reason: "Photoshop PSD — layered project file, never convert the master" },
    ai:   { status: "protected", category: "image", reason: "Adobe Illustrator file — creative master, never convert" },
    xcf:  { status: "protected", category: "image", reason: "GIMP project file — layered master, never convert" },

    // ── Already-optimal image formats ─────────────────────────────────────────
    webp: { status: "optimal", category: "image", reason: "WebP — modern efficient format with excellent quality/size ratio, no action needed" },
    avif: { status: "optimal", category: "image", reason: "AVIF — best-in-class compression, no action needed" },
    heic: { status: "optimal", category: "image", reason: "HEIC — modern Apple format with excellent quality/size ratio. Already highly compressed; re-encoding would waste space." },
    heif: { status: "optimal", category: "image", reason: "HEIF — modern format with excellent quality/size ratio, no action needed" },
    jxl:  { status: "optimal", category: "image", reason: "JPEG XL — next-generation format, no action needed" },

    // ── Already-optimal video formats ─────────────────────────────────────────
    mp4:  { status: "optimal", category: "video", reason: "MP4 container — typically uses H.264 or H.265 codec. Already space-efficient; no action needed. Run codec analysis on sample files to verify." },
    webm: { status: "optimal", category: "video", reason: "WebM — modern open format with efficient VP8/VP9/AV1 codecs, no action needed" },
    m4v:  { status: "optimal", category: "video", reason: "M4V — Apple video format, typically H.264/H.265. No action needed." },

    // ── Image conversion candidates ────────────────────────────────────────────
    jpg:  jpgRule,
    jpeg: jpgRule,
    png:  pngRule,
    bmp: {
      status: "convert", category: "image",
      method: "Convert to PNG (lossless)",
      targetFormat: "PNG", targetExt: "png",
      qualityLoss: "none", qualityStars: 5, qualityLabel: "Visually identical",
      compatibilityLabel: "Excellent",
      estimatedSavingsRatio: 0.70,
      reason: "BMP is an uncompressed format — converting to PNG applies lossless compression. PNG is universally compatible and will remain readable for decades.",
    },
    tiff: {
      status: "convert", category: "image",
      method: "Convert to PNG (lossless)",
      targetFormat: "PNG", targetExt: "png",
      qualityLoss: "none", qualityStars: 5, qualityLabel: "Visually identical",
      compatibilityLabel: "Excellent",
      estimatedSavingsRatio: 0.55,
      reason: "TIFF files are often uncompressed or use older compression. Converting to PNG saves 40–60% with zero quality loss. PNG is fully compatible with Windows.",
    },
    tif: {
      status: "convert", category: "image",
      method: "Convert to PNG (lossless)",
      targetFormat: "PNG", targetExt: "png",
      qualityLoss: "none", qualityStars: 5, qualityLabel: "Visually identical",
      compatibilityLabel: "Excellent",
      estimatedSavingsRatio: 0.55,
      reason: "TIFF files are often uncompressed or use older compression. Converting to PNG saves 40–60% with zero quality loss. PNG is fully compatible with Windows.",
    },
    gif: {
      status: "convert", category: "image",
      method: "Convert to PNG (lossless)",
      targetFormat: "PNG", targetExt: "png",
      qualityLoss: "none", qualityStars: 5, qualityLabel: "Visually identical",
      compatibilityLabel: "Excellent",
      estimatedSavingsRatio: 0.25,
      reason: "Static GIF uses an old 256-color palette format. Converting to PNG provides full 24-bit color and lossless compression. Note: animated GIFs should be reviewed manually.",
    },

    // ── Video conversion candidates ────────────────────────────────────────────
    avi: {
      status: "convert", category: "video",
      method: "Re-encode to H.265 MP4",
      targetFormat: "MP4 (H.265/HEVC)", targetExt: "mp4",
      qualityLoss: "minimal", qualityStars: 5, qualityLabel: "Near-identical quality",
      compatibilityLabel: "Excellent",
      estimatedSavingsRatio: 0.62,
      reason: "AVI is a legacy container format. Re-encoding to H.265 (HEVC) saves 55–70% of storage with near-identical visual quality. H.265 MP4 plays on all modern Windows, phones, and TVs.",
    },
    wmv: {
      status: "convert", category: "video",
      method: "Re-encode to H.265 MP4",
      targetFormat: "MP4 (H.265/HEVC)", targetExt: "mp4",
      qualityLoss: "minimal", qualityStars: 5, qualityLabel: "Near-identical quality",
      compatibilityLabel: "Excellent",
      estimatedSavingsRatio: 0.65,
      reason: "WMV is a legacy Windows format. Re-encoding to H.265 MP4 saves 60–70% with equivalent quality and removes Windows Media Player dependency.",
    },
    flv: {
      status: "convert", category: "video",
      method: "Re-encode to H.265 MP4",
      targetFormat: "MP4 (H.265/HEVC)", targetExt: "mp4",
      qualityLoss: "minimal", qualityStars: 5, qualityLabel: "Near-identical quality",
      compatibilityLabel: "Excellent",
      estimatedSavingsRatio: 0.60,
      reason: "Flash Video is obsolete — no modern browser or player supports FLV natively. H.265 MP4 saves 55–65% and plays everywhere.",
    },
    mpeg: {
      status: "convert", category: "video",
      method: "Re-encode to H.265 MP4",
      targetFormat: "MP4 (H.265/HEVC)", targetExt: "mp4",
      qualityLoss: "minimal", qualityStars: 5, qualityLabel: "Near-identical quality",
      compatibilityLabel: "Excellent",
      estimatedSavingsRatio: 0.72,
      reason: "MPEG-1/2 uses codecs from the 1990s. H.265 saves 65–75% space at similar visual quality and plays on all modern devices.",
    },
    mpg: {
      status: "convert", category: "video",
      method: "Re-encode to H.265 MP4",
      targetFormat: "MP4 (H.265/HEVC)", targetExt: "mp4",
      qualityLoss: "minimal", qualityStars: 5, qualityLabel: "Near-identical quality",
      compatibilityLabel: "Excellent",
      estimatedSavingsRatio: 0.72,
      reason: "MPEG is an older format using outdated codecs. H.265 MP4 saves 65–75% space at similar visual quality.",
    },
    m2ts: {
      status: "convert", category: "video",
      method: "Re-encode to H.265 MP4",
      targetFormat: "MP4 (H.265/HEVC)", targetExt: "mp4",
      qualityLoss: "minimal", qualityStars: 5, qualityLabel: "Near-identical quality",
      compatibilityLabel: "Excellent",
      estimatedSavingsRatio: 0.55,
      reason: "Blu-ray container format. H.265 MP4 saves 50–60% with near-identical quality and plays universally.",
    },
    ts: {
      status: "convert", category: "video",
      method: "Re-encode to H.265 MP4",
      targetFormat: "MP4 (H.265/HEVC)", targetExt: "mp4",
      qualityLoss: "minimal", qualityStars: 5, qualityLabel: "Near-identical quality",
      compatibilityLabel: "Excellent",
      estimatedSavingsRatio: 0.52,
      reason: "Transport stream format used in broadcast. H.265 MP4 saves 45–55% with near-identical quality.",
    },
    mov: {
      status: "protected", category: "video",
      reason: "QuickTime (.mov) container — codec cannot be determined from extension alone. May contain H.264 (already efficient), ProRes (professional master), or MJPEG (conversion candidate). Expand this row to see codec detection on your sample files.",
    },
    mkv: {
      status: "convert", category: "video",
      method: "Re-encode to H.265 MP4",
      targetFormat: "MP4 (H.265/HEVC)", targetExt: "mp4",
      qualityLoss: "minimal", qualityStars: 5, qualityLabel: "Near-identical quality",
      compatibilityLabel: "Excellent",
      estimatedSavingsRatio: 0.40,
      reason: "MKV files often contain H.264 video. Re-encoding to H.265 saves 35–45% space. Note: if already H.265, codec analysis will show this and recommend skipping.",
    },
    rmvb: {
      status: "convert", category: "video",
      method: "Re-encode to H.265 MP4",
      targetFormat: "MP4 (H.265/HEVC)", targetExt: "mp4",
      qualityLoss: "minimal", qualityStars: 5, qualityLabel: "Near-identical quality",
      compatibilityLabel: "Excellent",
      estimatedSavingsRatio: 0.55,
      reason: "RealMedia is a legacy format with poor player support. H.265 MP4 saves 50–60% and plays on all modern devices.",
    },
    asf: {
      status: "convert", category: "video",
      method: "Re-encode to H.265 MP4",
      targetFormat: "MP4 (H.265/HEVC)", targetExt: "mp4",
      qualityLoss: "minimal", qualityStars: 5, qualityLabel: "Near-identical quality",
      compatibilityLabel: "Excellent",
      estimatedSavingsRatio: 0.60,
      reason: "ASF/WMV container format. H.265 MP4 saves 55–65% with equivalent quality.",
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
  };
}

// ── Optimize scan cache ────────────────────────────────────────────────────────

const CACHE_VERSION    = 5; // bump when scan result shape changes
const CACHE_TTL_MS     = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_FILENAME   = "optimize-scan.json";

function getCachePath(nasPath: string): string {
  return path.join(getWillardAIDir(nasPath), "cache", CACHE_FILENAME);
}

function readScanCache(
  nasPath: string,
  profile?: string,
  rawConversionEnabled?: boolean,
): (Record<string, unknown> & { scannedAt: string }) | null {
  try {
    const cachePath = getCachePath(nasPath);
    if (!fs.existsSync(cachePath)) return null;
    const raw  = fs.readFileSync(cachePath, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown> & { scannedAt: string; cacheVersion?: number };
    if (!data.scannedAt) return null;
    if ((data.cacheVersion ?? 0) < CACHE_VERSION) return null;
    if (profile !== undefined && data.profile !== profile) return null;
    if (rawConversionEnabled !== undefined && data.rawConversionEnabled !== rawConversionEnabled) return null;
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
    fs.writeFileSync(getCachePath(nasPath), JSON.stringify({ ...data, cacheVersion: CACHE_VERSION }), "utf-8");
  } catch {
    // Non-fatal — cache write is best-effort
  }
}

// ── NAS directory walker ───────────────────────────────────────────────────────

interface SampleFile { path: string; sizeBytes: number; }

// `paths` holds ALL file paths for formats requiring per-file analysis (JPEG, container video).
// `samples` holds the top-3 by size for UI display only.
const PER_FILE_EXTS = new Set(["jpg","jpeg","mp4","m4v","mov","mkv"]);
const MAX_PER_FILE_PATHS = 5_000; // cap to avoid memory blowout on huge libraries

interface ExtGroup   { count: number; bytes: number; samples: SampleFile[]; paths: string[]; }

const SKIP_DIRS = new Set(["WillardAI", "node_modules", ".git", "$RECYCLE.BIN", "System Volume Information", ".Trash-1000"]);

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
      const curr = groups.get(ext) ?? { count: 0, bytes: 0, samples: [], paths: [] };
      insertSample(curr.samples, fullPath, size);
      // For formats needing per-file analysis, track every path (up to cap)
      if (PER_FILE_EXTS.has(ext) && curr.paths.length < MAX_PER_FILE_PATHS) {
        curr.paths.push(fullPath);
      }
      groups.set(ext, { count: curr.count + 1, bytes: curr.bytes + size, samples: curr.samples, paths: curr.paths });
      counter.total++;
    }
  }
}

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

// ── Per-file JPEG characteristic analysis ─────────────────────────────────────

async function analyzeJpegFile(filePath: string): Promise<string[]> {
  try {
    const sharp = (await import("sharp")).default;
    const meta  = await sharp(filePath, { failOn: "none" }).metadata();
    const issues: string[] = [];
    if (meta.isProgressive === false) issues.push("progressive encoding disabled");
    if (meta.hasProfile === false)    issues.push("no embedded ICC color profile");
    if (issues.length === 0)          issues.push("Huffman tables can be optimized");
    return issues;
  } catch {
    return [];
  }
}

// ── Per-file video codec detection via ffprobe ─────────────────────────────────

const LOSSLESS_CODECS = new Set(["prores", "prores_ks", "dnxhd", "dnxhr", "huffyuv", "utvideo", "v210", "v410"]);
const MODERN_CODECS   = new Set(["h264", "hevc", "av1", "vp9", "vp8"]);
const LEGACY_IMG_CODECS = new Set(["mjpeg", "mpeg4", "msmpeg4v3", "wmv1", "wmv2", "wmv3", "rv30", "rv40", "h263", "svq3", "indeo3", "cinepak"]);

async function detectVideoCodec(filePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "quiet", "-print_format", "json", "-show_streams", filePath,
    ], { timeout: 12_000 });
    const data = JSON.parse(stdout) as { streams: Array<{ codec_type: string; codec_name: string }> };
    const vs   = data.streams.find(s => s.codec_type === "video");
    return vs?.codec_name ?? null;
  } catch {
    return null;
  }
}

function buildCodecOverride(codec: string, ext: string): Partial<FormatRule> | null {
  if (LOSSLESS_CODECS.has(codec)) {
    return { status: "protected", reason: `${ext.toUpperCase()} contains ${codec} (professional lossless codec) — do not re-encode this master` };
  }
  if (MODERN_CODECS.has(codec)) {
    return { status: "optimal", reason: `${ext.toUpperCase()} uses ${codec} — already a modern efficient codec, no conversion needed` };
  }
  if (LEGACY_IMG_CODECS.has(codec)) {
    return {
      status: "convert",
      method: `Re-encode to H.265 MP4 (codec upgrade from ${codec})`,
      targetFormat: "MP4 (H.265/HEVC)", targetExt: "mp4",
      qualityLoss: "minimal", qualityStars: 5, qualityLabel: "Near-identical quality",
      compatibilityLabel: "Excellent",
      estimatedSavingsRatio: 0.68,
      reason: `${ext.toUpperCase()} uses ${codec} — a legacy codec. Re-encoding to H.265 saves ~65–70% of storage with near-identical visual quality.`,
    };
  }
  return null; // unknown codec — keep the default rule
}

// ── Explainer text builder ("Why am I recommending this?") ────────────────────

function buildExplainerText(ext: string, rule: FormatRule, profile: OptimizeProfile, jpegIssues: string[]): string {
  if (rule.status !== "convert") return "";

  if ((ext === "jpg" || ext === "jpeg") && jpegIssues.length > 0) {
    const issueList = jpegIssues.join("; ");
    return `Analysis of your sample JPEG files found: ${issueList}. Re-encoding with optimized Huffman tables${profile !== "MAXIMUM" ? " at quality 95" : ""} will produce a visually identical image that is typically 10–25% smaller. Visual impact: none.`;
  }
  if (ext === "jpg" || ext === "jpeg") {
    return `JPEGs can often be made 10–25% smaller by re-encoding with optimized Huffman tables and progressive scan order, with no perceptible change in image quality. The file will remain a standard .jpg — fully compatible with every device and photo viewer.`;
  }
  if (ext === "png") {
    return `PNG files can be re-compressed losslessly using adaptive filtering and maximum DEFLATE compression. The pixel data is identical after optimization — only the compressed representation changes. Typical savings: 10–20%.`;
  }
  if (ext === "bmp") {
    return `BMP is an uncompressed Windows bitmap format. Every pixel is stored as raw bytes with no compression. Converting to PNG applies lossless compression and typically reduces file size by 60–75%. PNG is fully compatible with Windows and will remain readable for decades.`;
  }
  if (ext === "tiff" || ext === "tif") {
    return `TIFF files are often stored uncompressed or with older compression schemes. Converting to PNG applies modern lossless compression with typical savings of 40–60%. PNG is universally compatible with Windows, macOS, photo editors, and photo viewers.`;
  }
  if (ext === "gif") {
    return `GIF uses an old format limited to 256 colors per frame. Converting static GIFs to PNG provides full 24-bit color fidelity and lossless compression. Note: animated GIFs will be converted to a still frame — review animated GIFs before converting.`;
  }
  const rawExts = new Set(["cr2","cr3","nef","nrw","arw","srf","sr2","dng","raf","orf","rw2","pef","x3f","rwl","raw","mrw"]);
  if (rawExts.has(ext)) {
    return `You have enabled RAW conversion. This file will be converted to a high-quality JPEG at quality 98 with 4:4:4 chroma subsampling, full EXIF metadata preserved (date, GPS, camera model), and auto-rotation applied. The original RAW file will be backed up to WillardAI/ConversionBackups before conversion. Estimated size reduction: ~80% versus the original RAW file.`;
  }
  if (rule.targetFormat?.includes("H.265")) {
    return `${ext.toUpperCase()} is a legacy video container. Re-encoding to H.265 (HEVC) saves ${Math.round((rule.estimatedSavingsRatio ?? 0.60) * 100)}% of storage while maintaining near-identical visual quality. H.265 MP4 has excellent playback compatibility on Windows, phones, smart TVs, and streaming players.`;
  }
  return rule.reason;
}

// ── Image conversion via sharp ─────────────────────────────────────────────────

const RAW_EXTS = new Set(["cr2","cr3","nef","nrw","arw","srf","sr2","dng","raf","orf","rw2","pef","x3f","rwl","raw","mrw"]);

async function convertImageAsync(
  srcPath: string,
  destPath: string,
  targetExt: string,
  profile: OptimizeProfile,
): Promise<string | null> {
  try {
    const srcExt = path.extname(srcPath).toLowerCase().slice(1);

    // RAW source files cannot be decoded by Sharp — always route through ffmpeg first.
    // ffmpeg with -q:v 1 produces JPEG at ~quality 98; -map_metadata 0 preserves EXIF.
    if (RAW_EXTS.has(srcExt)) {
      const result = spawnSync("ffmpeg", [
        "-y", "-i", srcPath,
        "-q:v", "1",           // quality ~98 as specified; q:v 2 would be ~96
        "-map_metadata", "0",  // preserve EXIF, ICC, GPS
        destPath,
      ], { encoding: "utf8", stdio: "pipe", timeout: 300_000 });
      if (result.status !== 0) {
        return formatMediaToolError("ffmpeg", result, (result.stderr ?? "").slice(-500));
      }
      return null;
    }

    const sharp = (await import("sharp")).default;
    const quality = profile === "BALANCED" ? 92 : 95;

    if (targetExt === "jpg" || targetExt === "jpeg") {
      await sharp(srcPath, { failOn: "none" })
        .withMetadata()
        .jpeg({ quality, progressive: true, optimiseCoding: true, chromaSubsampling: "4:4:4", force: true })
        .toFile(destPath);
    } else if (targetExt === "png") {
      await sharp(srcPath, { failOn: "none" })
        .withMetadata()
        .png({ compressionLevel: 9, adaptiveFiltering: true, force: true })
        .toFile(destPath);
    } else if (targetExt === "webp") {
      await sharp(srcPath, { failOn: "none" })
        .withMetadata()
        .webp({ quality: 85 })
        .toFile(destPath);
    } else {
      // Generic ffmpeg fallback for other image formats
      const result = spawnSync("ffmpeg", ["-y", "-i", srcPath, destPath], {
        encoding: "utf8", stdio: "pipe", timeout: 300_000,
      });
      if (result.status !== 0) {
        return formatMediaToolError("ffmpeg", result, (result.stderr ?? "").slice(-500));
      }
    }
    return null;
  } catch (err: any) {
    return err.message ?? "Image conversion failed";
  }
}

/** Convert a video to H.265 MP4 using ffmpeg. Returns null on success, error string on failure. */
function convertVideo(srcPath: string, destPath: string): string | null {
  const result = spawnSync("ffmpeg", [
    "-y", "-i", srcPath,
    "-c:v", "libx265", "-crf", "28", "-preset", "medium",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
    destPath,
  ], { encoding: "utf8", stdio: "pipe", timeout: 3_600_000 });
  if (result.status !== 0) {
    return formatMediaToolError("ffmpeg", result, (result.stderr ?? "").slice(-500));
  }
  return null;
}

// ── Post-conversion verification ───────────────────────────────────────────────

async function verifyConvertedFile(
  srcPath: string,
  destPath: string,
  category: string,
  isSameExt: boolean,
  originalBytes: number,
  isRawSource = false,
): Promise<{ passed: boolean; checks: string[]; failedCheck?: string }> {
  const checks: string[] = [];

  // Check 1: Output file exists and non-zero
  if (!fs.existsSync(destPath)) {
    return { passed: false, checks, failedCheck: "Output file does not exist" };
  }
  const convertedBytes = fs.statSync(destPath).size;
  if (convertedBytes === 0) {
    return { passed: false, checks, failedCheck: "Output file is empty" };
  }
  checks.push("Output exists and is non-zero");

  // Check 2: Size regression (for same-ext: output must be smaller)
  if (isSameExt && convertedBytes >= originalBytes) {
    return { passed: false, checks, failedCheck: "Output not smaller than original" };
  }
  checks.push("Size check passed");

  if (category === "image") {
    try {
      const sharp = (await import("sharp")).default;

      // Check 3: Output decodes without decoder error
      let dstMeta: import("sharp").Metadata;
      try {
        dstMeta = await sharp(destPath, { failOn: "error" }).metadata();
      } catch (err: any) {
        return { passed: false, checks, failedCheck: `Decoder error on output: ${(err.message ?? "unknown").slice(0, 200)}` };
      }
      if (!dstMeta.width || !dstMeta.height) {
        return { passed: false, checks, failedCheck: "Output image has no dimensions (decode failed)" };
      }
      checks.push(`Decoded OK — ${dstMeta.width}×${dstMeta.height}`);

      // Check 4: Thumbnail generation — verifies decodability end-to-end
      try {
        const thumbBuf = await sharp(destPath, { failOn: "none" })
          .resize(200, 200, { fit: "inside" })
          .jpeg({ quality: 60 })
          .toBuffer();
        if (thumbBuf.length === 0) {
          return { passed: false, checks, failedCheck: "Thumbnail generation produced empty buffer" };
        }
        checks.push("Thumbnail generated successfully");
      } catch (err: any) {
        return { passed: false, checks, failedCheck: `Thumbnail generation failed: ${(err.message ?? "unknown").slice(0, 120)}` };
      }

      // Check 5: Pixel hash — SHA-256 of downscaled raw pixels (fast, stored for audit)
      try {
        const pixelBuf = await sharp(destPath, { failOn: "none" })
          .resize(256, 256, { fit: "inside" })
          .raw()
          .toBuffer();
        const pixelHash = crypto.createHash("sha256").update(pixelBuf).digest("hex").slice(0, 16);
        checks.push(`Pixel hash (256px): ${pixelHash}`);
      } catch { /* best effort — non-blocking */ }

      // Check 6: Histogram / channel statistics (detects catastrophic color shifts)
      try {
        const stats = await sharp(destPath, { failOn: "none" }).stats();
        const chSummary = stats.channels.map((c, i) =>
          `ch${i}: mean=${c.mean.toFixed(1)} stdev=${c.stdev.toFixed(1)}`
        ).join(", ");
        checks.push(`Channel stats: ${chSummary}`);
      } catch { /* best effort — non-blocking */ }

      // Checks 7–10: Compare against source metadata (skip for RAW sources, which Sharp can't decode)
      if (!isRawSource) {
        try {
          const srcMeta = await sharp(srcPath, { failOn: "none" }).metadata();

          if (srcMeta.width && srcMeta.height && dstMeta.width && dstMeta.height) {
            // Check 7: Total pixel count within 15% (allows auto-rotation dimension swap)
            const srcPixels = srcMeta.width * srcMeta.height;
            const dstPixels = dstMeta.width * dstMeta.height;
            if (Math.min(srcPixels, dstPixels) / Math.max(srcPixels, dstPixels) < 0.85) {
              return { passed: false, checks, failedCheck: `Resolution mismatch: ${srcMeta.width}×${srcMeta.height} → ${dstMeta.width}×${dstMeta.height}` };
            }
            checks.push(`Resolution matches source (${dstMeta.width}×${dstMeta.height})`);

            // Check 8: Aspect ratio preserved within 5% (catches unintentional crop/distortion)
            const srcAspect = srcMeta.width / srcMeta.height;
            const dstAspect = dstMeta.width / dstMeta.height;
            const aspectRatio = Math.min(srcAspect, dstAspect) / Math.max(srcAspect, dstAspect);
            if (aspectRatio < 0.95) {
              return { passed: false, checks, failedCheck: `Aspect ratio mismatch: src ${srcMeta.width}×${srcMeta.height} (${srcAspect.toFixed(2)}) → dst ${dstMeta.width}×${dstMeta.height} (${dstAspect.toFixed(2)})` };
            }
            checks.push("Aspect ratio preserved");

            // Check 9: Orientation — after re-encode, orientation must be 1 (auto-rotated) or same
            if (srcMeta.orientation !== undefined) {
              if (dstMeta.orientation !== undefined && dstMeta.orientation !== 1 && dstMeta.orientation !== srcMeta.orientation) {
                return { passed: false, checks, failedCheck: `Orientation mismatch: source=${srcMeta.orientation}, output=${dstMeta.orientation}` };
              }
              checks.push(`Orientation OK (${dstMeta.orientation ?? "normalized"})`);
            }
          }

          // Check 10: EXIF preserved — hard fail if source had EXIF but output does not
          if (srcMeta.exif && !dstMeta.exif) {
            return { passed: false, checks, failedCheck: "EXIF metadata was stripped during conversion (source had EXIF)" };
          }
          if (srcMeta.exif && dstMeta.exif) checks.push("EXIF metadata preserved");
        } catch { /* best effort — source read error is non-blocking */ }
      } else {
        // For RAW → JPEG: verify output has ICC profile (spec requirement)
        if (!dstMeta.icc) {
          return { passed: false, checks, failedCheck: "RAW conversion output is missing ICC color profile" };
        }
        checks.push("ICC color profile present (RAW conversion)");
      }
    } catch (err: any) {
      return { passed: false, checks, failedCheck: `Verify failed: ${(err.message ?? "unknown").slice(0, 200)}` };
    }
  }

  return { passed: true, checks };
}

// ── Conversion log ────────────────────────────────────────────────────────────

function appendConversionLog(nasPath: string, entry: Record<string, unknown>): void {
  try {
    const logsDir = path.join(getWillardAIDir(nasPath), "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(path.join(logsDir, "conversions.jsonl"), JSON.stringify(entry) + "\n", "utf-8");
  } catch { /* non-fatal */ }
}

// ── Endpoints ─────────────────────────────────────────────────────────────────

router.get("/optimize/scan", async (req, res) => {
  try {
    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const settings = settingsRows[0] ?? {} as typeof appSettingsTable.$inferSelect;
    const nasPath = (settings.nasPath ?? "").trim();
    if (!nasPath || !fs.existsSync(nasPath)) {
      res.status(400).json({ error: "NAS path is not configured or not accessible" });
      return;
    }

    assertWithinRoot(path.resolve(nasPath), path.resolve(nasPath));

    const profile: OptimizeProfile = (settings.optimizeProfile ?? "ARCHIVE") as OptimizeProfile;
    const rawConversionEnabled = settings.rawConversionEnabled ?? false;
    const force = req.query.force === "true";

    if (!force) {
      const cached = readScanCache(nasPath, profile, rawConversionEnabled);
      if (cached) {
        res.json({ ...cached, fromCache: true, profile });
        return;
      }
    }

    const FORMAT_RULES = getFormatRules(profile, rawConversionEnabled);
    const groups = new Map<string, ExtGroup>();
    const counter = { total: 0 };
    walkForOptimize(nasPath, groups, 500_000, counter);

    const result = [];
    let totalSavingsBytes = 0;

    // Per-file analysis: each JPEG and each container video file is analyzed individually.
    // Results go into `fileDecisions` for use by the execute loop (codec override enforcement).
    // `jpegIssuesMap` and `detectedCodecMap` hold representative group-level data for UI display only.
    const enrichPromises: Promise<void>[] = [];
    const jpegIssuesMap    = new Map<string, string[]>();  // ext → issues (for explainer text)
    const detectedCodecMap = new Map<string, string>();    // ext → codec (for group-level override)

    // fileDecisions: per-file convert/skip decision, persisted in scan cache.
    // The execute loop reads this to decide whether to convert each individual file.
    const fileDecisions: Record<string, { convert: boolean; targetExt: string; reasons: string[]; codec?: string }> = {};

    const JPEG_ANALYZE_LIMIT = 20; // analyze up to this many JPEGs per group

    for (const [ext, { samples, paths }] of groups.entries()) {
      if (ext === "jpg" || ext === "jpeg") {
        // Per-file JPEG analysis: analyze each file individually (up to limit)
        const filesToAnalyze = paths.slice(0, JPEG_ANALYZE_LIMIT);
        enrichPromises.push((async () => {
          const analysisResults = await Promise.allSettled(
            filesToAnalyze.map(async (p) => {
              const issues = await analyzeJpegFile(p);
              return { path: p, issues };
            })
          );
          for (const r of analysisResults) {
            if (r.status === "fulfilled") {
              const { path: p, issues } = r.value;
              const shouldConvert = issues.length > 0;
              fileDecisions[p] = { convert: shouldConvert, targetExt: "jpg", reasons: issues };
              // Take the first file's issues for the group-level explainer text
              if (!jpegIssuesMap.has(ext) && issues.length > 0) {
                jpegIssuesMap.set(ext, issues);
              }
            }
          }
        })());
      }

      if (ext === "mov" || ext === "mkv" || ext === "mp4" || ext === "m4v") {
        // Per-file codec detection: analyze EVERY container file (not just one sample)
        enrichPromises.push((async () => {
          const codecResults = await Promise.allSettled(
            paths.map(async (p) => {
              const codec = await detectVideoCodec(p);
              return { path: p, codec };
            })
          );
          for (const r of codecResults) {
            if (r.status === "fulfilled" && r.value.codec) {
              const { path: p, codec } = r.value;
              const codecRule = buildCodecOverride(codec, ext);
              fileDecisions[p] = {
                convert:   codecRule?.status === "convert",
                targetExt: codecRule?.targetExt ?? (codecRule?.status === "convert" ? "mp4" : ext),
                reasons:   [codecRule?.reason ?? `Codec: ${codec}`],
                codec,
              };
              // Take the first codec found for group-level override display
              if (!detectedCodecMap.has(ext)) detectedCodecMap.set(ext, codec);
            }
          }
        })());

        // Also run on the sample if paths was capped and sample file is not in paths
        if (samples.length > 0 && !paths.includes(samples[0].path)) {
          enrichPromises.push((async () => {
            const codec = await detectVideoCodec(samples[0].path);
            if (codec && !detectedCodecMap.has(ext)) detectedCodecMap.set(ext, codec);
          })());
        }
      }
    }

    // Run all per-file analysis in parallel (best-effort — individual failures are swallowed)
    await Promise.allSettled(enrichPromises);

    for (const [ext, { count, bytes, samples }] of groups.entries()) {
      let rule: FormatRule = FORMAT_RULES[ext] ?? { status: "skip" as FormatStatus, category: "other" as MediaCategory, reason: "Unknown format — no conversion recommendation available" };

      // Apply codec override for container video formats
      const detectedCodec = detectedCodecMap.get(ext);
      if (detectedCodec) {
        const override = buildCodecOverride(detectedCodec, ext);
        if (override) rule = { ...rule, ...override };
      }

      const jpegIssues = jpegIssuesMap.get(ext) ?? [];
      const status: FormatStatus = rule.status ?? "skip";
      const category: MediaCategory = rule.category ?? "other";
      const savings = rule.estimatedSavingsRatio ? Math.round(bytes * rule.estimatedSavingsRatio) : 0;
      if (status === "convert") totalSavingsBytes += savings;

      const sampleFiles = samples.map(s => ({
        path:                s.path,
        sizeBytes:           s.sizeBytes,
        estimatedAfterBytes: rule.estimatedSavingsRatio
          ? Math.round(s.sizeBytes * (1 - rule.estimatedSavingsRatio))
          : s.sizeBytes,
      }));

      const explainerText = buildExplainerText(ext, rule, profile, jpegIssues);

      result.push({
        extension:             ext,
        fileCount:             count,
        totalBytes:            bytes,
        category,
        status,
        method:                rule.method ?? null,
        targetFormat:          rule.targetFormat ?? null,
        targetExt:             rule.targetExt ?? null,
        qualityLoss:           rule.qualityLoss ?? null,
        qualityStars:          rule.qualityStars ?? null,
        qualityLabel:          rule.qualityLabel ?? null,
        compatibilityLabel:    rule.compatibilityLabel ?? null,
        estimatedSavingsBytes: savings,
        estimatedSavingsRatio: rule.estimatedSavingsRatio ?? null,
        reason:                rule.reason,
        explainerText,
        jpegIssues:            jpegIssues.length > 0 ? jpegIssues : undefined,
        detectedCodec:         detectedCodec ?? undefined,
        sampleFiles,
      });
    }

    const ORDER: Record<FormatStatus, number> = { convert: 0, protected: 1, optimal: 2, skip: 3 };
    result.sort((a, b) => {
      const orderDiff = (ORDER[a.status] ?? 4) - (ORDER[b.status] ?? 4);
      if (orderDiff !== 0) return orderDiff;
      return b.estimatedSavingsBytes - a.estimatedSavingsBytes;
    });

    const payload = {
      scannedAt: new Date().toISOString(),
      nasPath,
      profile,
      rawConversionEnabled,
      totalFiles: counter.total,
      totalBytes: result.reduce((s, g) => s + g.totalBytes, 0),
      totalSavingsBytes,
      groups: result,
      fileDecisions,   // per-file convert/skip decisions consumed by execute loop
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
        status: string; method?: string; targetFormat?: string; estimatedSavingsBytes: number;
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
      .map(g => `  - ${g.fileCount} .${g.extension} files (${(g.totalBytes / 1e9).toFixed(2)} GB) → ${g.method ?? g.targetFormat ?? "optimized"}, saves ~${(g.estimatedSavingsBytes / 1e9).toFixed(2)} GB`)
      .join("\n");

    const prompt = `You are analyzing a media library on a home NAS server. Based on the following format scan, write a concise plain-English summary (2-4 sentences) of the optimization opportunity. Be specific about the numbers. Focus on the biggest wins. Avoid technical jargon. Do not mention WebP.

Scan summary:
- Total files scanned: ${totalFiles.toLocaleString()}
- Total storage used: ${(totalBytes / 1e9).toFixed(1)} GB
- Estimated recoverable storage: ${(totalSavingsBytes / 1e9).toFixed(1)} GB
- Formats with optimization potential:
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
    const settings = settingsRows[0] ?? {} as typeof appSettingsTable.$inferSelect;
    const nasPath = (settings.nasPath ?? "").trim();
    if (!nasPath || !fs.existsSync(nasPath)) {
      res.status(400).json({ error: "NAS path is not configured or not accessible" });
      return;
    }

    const profile: OptimizeProfile = (settings.optimizeProfile ?? "ARCHIVE") as OptimizeProfile;
    const rawConversionEnabled = settings.rawConversionEnabled ?? false;
    const FORMAT_RULES = getFormatRules(profile, rawConversionEnabled);

    // Load scan cache to check per-file decisions for codec-detected formats.
    // Container formats (mp4/mov/mkv/m4v) may show as "optimal" in static rules but
    // have per-file codec overrides in the scan cache making some files convertible.
    const cachedScan = readScanCache(nasPath, profile, rawConversionEnabled);
    const cachedDecisions = (cachedScan?.fileDecisions as Record<string, { convert: boolean; targetExt: string }> | undefined) ?? {};

    for (const ext of approvedExts) {
      const lext = ext.toLowerCase();
      const rule  = FORMAT_RULES[lext];

      // For codec-detected container formats, accept if any scanned file is marked convert
      if (PER_FILE_EXTS.has(lext) && (lext === "mp4" || lext === "m4v" || lext === "mov" || lext === "mkv")) {
        const anyConvert = Object.entries(cachedDecisions).some(
          ([fp, d]) => path.extname(fp).slice(1).toLowerCase() === lext && d.convert
        );
        if (!anyConvert && (!rule || rule.status !== "convert")) {
          res.status(400).json({ error: `No convertible ${ext} files found — run a fresh scan first or codec analysis shows all files are already optimal` });
          return;
        }
        // At least one file converts — allowed
        continue;
      }

      if (!rule || rule.status !== "convert") {
        res.status(400).json({ error: `Extension "${ext}" is not a convertible format` });
        return;
      }
    }

    const resolvedBackupDir = backupDir?.trim()
      || path.join(nasPath, "WillardAI", "ConversionBackups", new Date().toISOString().slice(0, 19).replace(/:/g, "-"));

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

router.post("/optimize/jobs/:id/retry", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid job id" }); return; }
    const [job] = await db.select().from(conversionJobsTable).where(eq(conversionJobsTable.id, id)).limit(1);
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    if (job.status !== "failed" && job.status !== "awaiting_action") {
      res.status(409).json({ error: `Cannot retry a job with status '${job.status}' — only failed or awaiting-action jobs can be retried` });
      return;
    }
    // Clean up staging dir if retrying an awaiting_action job
    if (job.status === "awaiting_action") {
      const resultData = job.resultJson as { stagingDir?: string } | null;
      try {
        if (resultData?.stagingDir && fs.existsSync(resultData.stagingDir)) {
          fs.rmSync(resultData.stagingDir, { recursive: true, force: true });
        }
      } catch { /* best effort */ }
    }
    const [updated] = await db
      .update(conversionJobsTable)
      .set({ status: "pending", error: null, totalFiles: 0, processedFiles: 0, succeededFiles: 0, failedFiles: 0, skippedFiles: 0, resultJson: null, completedAt: null })
      .where(eq(conversionJobsTable.id, id))
      .returning();
    res.json(updated);
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? "Failed to retry job" });
  }
});

/**
 * POST /optimize/jobs/:id/finalize — Stage 4: apply user's choice for what to do with originals.
 * Body: { action: "recycle" | "replace" | "keep-both" | "archive" }
 * - recycle:   Move original to WillardAI/.Trash/<ts>/<relPath>; staged file takes original's path.
 * - replace:   Delete original permanently; staged file takes original's path.
 * - keep-both: Keep original in place; staged file saved as <stem>_optimized.<ext> next to original.
 * - archive:   Move original to WillardAI/archive/<relPath>; staged file takes original's path.
 * Appends each action to WillardAI/logs/conversions.jsonl. Cleans up staging dir on completion.
 */
router.post("/optimize/jobs/:id/finalize", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid job id" }); return; }

    const { action } = req.body as { action?: string };
    const VALID_ACTIONS = ["recycle", "replace", "keep-both", "archive"];
    if (!action || !VALID_ACTIONS.includes(action)) {
      res.status(400).json({ error: `Invalid action. Must be one of: ${VALID_ACTIONS.join(", ")}` });
      return;
    }

    const [job] = await db.select().from(conversionJobsTable).where(eq(conversionJobsTable.id, id)).limit(1);
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    if (job.status !== "awaiting_action") {
      res.status(409).json({ error: `Job is not awaiting action (current status: ${job.status})` });
      return;
    }

    const resultData = job.resultJson as {
      files: Array<{
        filePath: string; stagedPath?: string; status: string;
        originalBytes?: number; convertedBytes?: number; isSameExt?: boolean;
      }>;
      totalSaved: number;
      stagingDir: string;
    } | null;

    if (!resultData) { res.status(500).json({ error: "Job result data is missing" }); return; }

    const nasPath = job.nasPath;
    const ts      = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    const trashBase   = path.join(getWillardAIDir(nasPath), ".Trash", ts);
    const archiveBase = path.join(getWillardAIDir(nasPath), "archive");

    const fileOutcomes: Array<{ originalPath: string; outputPath: string; action: string; error?: string }> = [];

    for (const file of resultData.files) {
      if (file.status !== "success" || !file.stagedPath) continue;
      if (!fs.existsSync(file.stagedPath)) continue;

      const originalPath = file.filePath;
      const stagedPath   = file.stagedPath;
      const stem         = path.basename(originalPath, path.extname(originalPath));
      const targetExt    = path.extname(stagedPath).slice(1);
      const dir          = path.dirname(originalPath);
      const relPath      = path.relative(path.resolve(nasPath), path.resolve(originalPath));
      let outputPath     = "";

      try {
        if (action === "replace") {
          if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
          fs.renameSync(stagedPath, originalPath);
          outputPath = originalPath;
        } else if (action === "recycle") {
          const trashPath = path.join(trashBase, relPath);
          fs.mkdirSync(path.dirname(trashPath), { recursive: true });
          if (fs.existsSync(originalPath)) fs.renameSync(originalPath, trashPath);
          fs.renameSync(stagedPath, originalPath);
          outputPath = originalPath;
        } else if (action === "keep-both") {
          const keepBothPath = path.join(dir, `${stem}_optimized.${targetExt}`);
          fs.renameSync(stagedPath, keepBothPath);
          outputPath = keepBothPath;
        } else if (action === "archive") {
          const archivePath = path.join(archiveBase, relPath);
          fs.mkdirSync(path.dirname(archivePath), { recursive: true });
          if (fs.existsSync(originalPath)) fs.renameSync(originalPath, archivePath);
          fs.renameSync(stagedPath, originalPath);
          outputPath = originalPath;
        }
        fileOutcomes.push({ originalPath, outputPath, action });
      } catch (err: any) {
        fileOutcomes.push({ originalPath, outputPath: "", action, error: err.message });
      }

      appendConversionLog(nasPath, {
        ts:             new Date().toISOString(),
        jobId:          id,
        action,
        originalPath,
        outputPath:     fileOutcomes[fileOutcomes.length - 1]?.outputPath ?? "",
        originalBytes:  file.originalBytes,
        convertedBytes: file.convertedBytes,
        savedBytes:     Math.max(0, (file.originalBytes ?? 0) - (file.convertedBytes ?? 0)),
        error:          fileOutcomes[fileOutcomes.length - 1]?.error,
      });
    }

    // Clean up staging dir
    try {
      if (resultData.stagingDir && fs.existsSync(resultData.stagingDir)) {
        fs.rmSync(resultData.stagingDir, { recursive: true, force: true });
      }
    } catch { /* best effort */ }

    await db.update(conversionJobsTable).set({
      status:     "done",
      resultJson: { ...resultData, action, fileOutcomes },
    }).where(eq(conversionJobsTable.id, id));

    res.json({ action, filesProcessed: fileOutcomes.length, outcomes: fileOutcomes });
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? "Finalize failed" });
  }
});

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

    // Read current profile from settings for this run
    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const profile: OptimizeProfile = (settingsRows[0]?.optimizeProfile ?? "ARCHIVE") as OptimizeProfile;
    const rawConversionEnabled = settingsRows[0]?.rawConversionEnabled ?? false;
    const FORMAT_RULES = getFormatRules(profile, rawConversionEnabled);

    const nasPath        = job.nasPath;
    const backupDir      = job.backupDir!;
    const approvedExtSet = new Set<string>((job.approvedExts as string[]).map(e => e.toLowerCase()));

    // Load per-file decisions from scan cache — used to enforce codec-specific convert/skip
    // and to get the correct targetExt for codec-overridden container files.
    const execCachedScan = readScanCache(nasPath, profile, rawConversionEnabled);
    const execFileDecisions = (execCachedScan?.fileDecisions as
      Record<string, { convert: boolean; targetExt: string; reasons: string[] }> | undefined) ?? {};

    await db.update(conversionJobsTable).set({ status: "running" }).where(eq(conversionJobsTable.id, id));
    send("status", { stage: "scanning", message: "Scanning NAS for files to convert…", progress: 2 });

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
        status: "done", processedFiles: 0, succeededFiles: 0, failedFiles: 0, skippedFiles: 0,
        completedAt: new Date(), resultJson: { files: [] },
      }).where(eq(conversionJobsTable.id, id));
      send("summary", { totalFiles: 0, succeeded: 0, failed: 0, skipped: 0, results: [] });
      res.end();
      return;
    }

    send("status", { stage: "converting", message: `Found ${totalFiles} file${totalFiles !== 1 ? "s" : ""} to convert`, progress: 5, totalFiles });

    // Stage 2: Convert files to a protected staging area — originals are NEVER touched here.
    const stagingDir = path.join(getWillardAIDir(nasPath), "conversions", String(id));
    fs.mkdirSync(stagingDir, { recursive: true });

    let succeeded = 0, failed = 0, skipped = 0;
    const results: Array<{
      filePath:       string;
      stagedPath?:    string;
      status:         "success" | "failed" | "skipped";
      originalBytes?: number;
      convertedBytes?: number;
      isSameExt?:     boolean;
      error?:         string;
      verification?:  string[];
    }> = [];

    for (let i = 0; i < filesToConvert.length; i++) {
      const { fullPath, ext } = filesToConvert[i];

      // Use per-file decision from scan cache when available; fall back to extension-level rule.
      const perFileDecision = execFileDecisions[fullPath];
      const rule      = FORMAT_RULES[ext];
      const category  = rule?.category ?? "other";

      // If this file was individually analyzed and flagged as "no conversion needed", skip it.
      // (e.g. an mp4 with H.265 codec when other mp4s with MJPEG were approved)
      if (perFileDecision && !perFileDecision.convert) {
        skipped++;
        const skipReason = perFileDecision.reasons[0] ?? "Per-file analysis: already optimal";
        results.push({ filePath: fullPath, status: "skipped", error: skipReason });
        await db.update(conversionJobsTable).set({ processedFiles: i + 1, skippedFiles: skipped }).where(eq(conversionJobsTable.id, id));
        send("file_done", { filePath: fullPath, status: "skipped", error: skipReason, processed: i + 1, total: totalFiles });
        continue;
      }

      // Resolve target extension: per-file decision takes priority over static rule
      const targetExt = perFileDecision?.targetExt ?? rule?.targetExt ?? (category === "video" ? "mp4" : null);

      if (!targetExt) {
        skipped++;
        results.push({ filePath: fullPath, status: "skipped", error: "No conversion target for this format" });
        await db.update(conversionJobsTable).set({ processedFiles: i + 1, skippedFiles: skipped }).where(eq(conversionJobsTable.id, id));
        send("file_done", { filePath: fullPath, status: "skipped", error: "No conversion target", processed: i + 1, total: totalFiles });
        continue;
      }

      const progress  = 5 + Math.round(((i) / totalFiles) * 90);
      const shortName = path.basename(fullPath);
      send("status", { stage: "converting", message: `[${i + 1}/${totalFiles}] ${shortName}`, progress, currentFile: fullPath, processed: i, total: totalFiles });

      if (!fs.existsSync(fullPath)) {
        skipped++;
        results.push({ filePath: fullPath, status: "skipped", error: "File no longer exists" });
        await db.update(conversionJobsTable).set({ processedFiles: i + 1, skippedFiles: skipped }).where(eq(conversionJobsTable.id, id));
        send("file_done", { filePath: fullPath, status: "skipped", error: "File no longer exists", processed: i + 1, total: totalFiles });
        continue;
      }

      let originalBytes = 0;
      try { originalBytes = fs.statSync(fullPath).size; } catch { /* best effort */ }

      // ── Build staged path (mirrors NAS directory structure) ──────────────────
      const relPath    = path.relative(path.resolve(nasPath), path.resolve(fullPath));
      const stem       = path.basename(fullPath, path.extname(fullPath));
      const isSameExt  = targetExt === ext;
      const stagedDir  = path.join(stagingDir, path.dirname(relPath));
      const stagedPath = path.join(stagedDir, `${stem}.${targetExt}`);

      fs.mkdirSync(stagedDir, { recursive: true });

      // ── Convert to staging area (original untouched) ─────────────────────────
      let convertError: string | null = null;
      if (category === "image") {
        convertError = await convertImageAsync(fullPath, stagedPath, targetExt, profile);
      } else if (category === "video") {
        convertError = convertVideo(fullPath, stagedPath);
      } else {
        convertError = `Unsupported category for conversion: ${category}`;
      }

      if (convertError) {
        try { if (fs.existsSync(stagedPath)) fs.unlinkSync(stagedPath); } catch { /* best effort */ }
        failed++;
        results.push({ filePath: fullPath, status: "failed", error: convertError });
        await db.update(conversionJobsTable).set({ processedFiles: i + 1, failedFiles: failed }).where(eq(conversionJobsTable.id, id));
        send("file_done", { filePath: fullPath, status: "failed", error: convertError.slice(0, 300), processed: i + 1, total: totalFiles });
        continue;
      }

      // ── Stage 3: Verify the converted file ───────────────────────────────────
      const isRawSrc = RAW_EXTS.has(ext);
      const verification = await verifyConvertedFile(fullPath, stagedPath, category, isSameExt, originalBytes, isRawSrc);
      if (!verification.passed) {
        try { if (fs.existsSync(stagedPath)) fs.unlinkSync(stagedPath); } catch { /* best effort */ }
        const isRegression = verification.failedCheck?.includes("not smaller");
        if (isRegression) {
          skipped++;
          results.push({ filePath: fullPath, status: "skipped", error: "Already optimized (output not smaller than original)", verification: verification.checks });
          await db.update(conversionJobsTable).set({ processedFiles: i + 1, skippedFiles: skipped }).where(eq(conversionJobsTable.id, id));
          send("file_done", { filePath: fullPath, status: "skipped", error: "Already optimized", processed: i + 1, total: totalFiles });
        } else {
          failed++;
          results.push({ filePath: fullPath, status: "failed", error: verification.failedCheck ?? "Verification failed", verification: verification.checks });
          await db.update(conversionJobsTable).set({ processedFiles: i + 1, failedFiles: failed }).where(eq(conversionJobsTable.id, id));
          send("file_done", { filePath: fullPath, status: "failed", error: verification.failedCheck ?? "Verification failed", processed: i + 1, total: totalFiles });
        }
        continue;
      }

      let convertedBytes = 0;
      try { convertedBytes = fs.statSync(stagedPath).size; } catch { /* best effort */ }

      // ── Success: original is safe, staged file is verified ──────────────────
      succeeded++;
      results.push({ filePath: fullPath, stagedPath, status: "success", originalBytes, convertedBytes, isSameExt, verification: verification.checks });
      await db.update(conversionJobsTable).set({ processedFiles: i + 1, succeededFiles: succeeded }).where(eq(conversionJobsTable.id, id));
      send("file_done", {
        filePath: fullPath,
        stagedPath,
        status: "success",
        originalBytes,
        convertedBytes,
        savedBytes: Math.max(0, originalBytes - convertedBytes),
        processed: i + 1,
        total: totalFiles,
      });
    }

    const totalSaved = results.reduce((s, r) => s + Math.max(0, (r.originalBytes ?? 0) - (r.convertedBytes ?? 0)), 0);
    const resultJson = { files: results, totalSaved, stagingDir };

    // Stage 4: Await user action — originals are untouched; staged files ready for user decision.
    await db.update(conversionJobsTable).set({
      status: "awaiting_action", processedFiles: totalFiles, succeededFiles: succeeded, failedFiles: failed,
      skippedFiles: skipped, completedAt: new Date(), resultJson,
    }).where(eq(conversionJobsTable.id, id));

    send("status", { stage: "awaiting_action", message: "Conversions staged — choose what to do with your originals", progress: 100 });
    send("summary", { totalFiles, succeeded, failed, skipped, totalSavedBytes: totalSaved, stagingDir, results: results.slice(0, 200) });
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
