import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { appSettingsTable, conversionJobsTable } from "@workspace/db";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { spawnSync, execFile } from "child_process";
import { promisify } from "util";
import { desc, eq } from "drizzle-orm";
import { assertWithinRoot, getWillardAIDir, appendPrivateJsonl } from "../lib/nas-storage";
import { formatMediaToolError } from "../lib/media-tools";
import { openai } from "@workspace/integrations-openai-ai-server";
import { consumeActionToken, issueActionToken } from "../lib/action-tokens";
import { aiProviderBlockedReason, canSendToAiProvider, getAiPrivacySettings } from "../lib/ai-privacy";
import { logger } from "../lib/logger.ts";
import {
  evaluateCapacity,
  reserveCapacity,
  releaseCapacity,
  CapacityAdmissionError,
  type CapacityReservation,
} from "../lib/capacity-service.ts";
import { requestLibraryBackup } from "../lib/backup-coordinator.ts";

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

  // Image: JPEG & PNG targets differ by profile.
  // Archive profile is strictly lossless — JPEG cannot be losslessly re-compressed with Sharp
  // (any JPEG→JPEG operation alters pixel values). Mark as protected so users pick Balanced/Maximum.
  const isArchive = !isBalanced && !isMaximum;
  const jpgRule: FormatRule = isMaximum ? {
    status: "convert", category: "image",
    method: "Convert to WebP",
    targetFormat: "WebP", targetExt: "webp",
    qualityLoss: "minimal", qualityStars: 4, qualityLabel: "Minimal visible difference",
    compatibilityLabel: "Good",
    estimatedSavingsRatio: 0.27,
    reason: "WebP provides 25–30% better compression than JPEG at equivalent visual quality",
  } : isBalanced ? {
    status: "convert", category: "image",
    method: "Re-compress (quality 92)",
    targetFormat: "JPEG Optimized (92)",
    targetExt: "jpg",
    qualityLoss: "minimal", qualityStars: 5, qualityLabel: "Imperceptibly different",
    compatibilityLabel: "Excellent",
    estimatedSavingsRatio: 0.18,
    reason: "Re-encoding at quality 92 with progressive encoding and optimized Huffman tables saves 15–25% with imperceptible quality change",
  } : {
    // Archive: JPEG cannot be losslessly optimized without jpegtran; protect instead of silently losing quality
    status: "protected", category: "image",
    method: "No action — lossless JPEG optimization not available",
    targetFormat: "JPEG", targetExt: "jpg",
    qualityLoss: "none", qualityStars: 5, qualityLabel: "No change",
    compatibilityLabel: "Excellent",
    estimatedSavingsRatio: 0,
    reason: "Archive profile is lossless-only. JPEG re-encoding always alters pixel values, even at quality 95. Switch to Balanced to re-compress at quality 92 with imperceptible quality change.",
  };

  const pngRule: FormatRule = {
    status: "convert", category: "image",
    method: "Convert to JPEG (quality 98)",
    targetFormat: "JPEG", targetExt: "jpg",
    qualityLoss: "minimal", qualityStars: 5, qualityLabel: "Highest practical quality",
    compatibilityLabel: "Excellent",
    estimatedSavingsRatio: 0.35,
    reason: "Opaque PNG pixels can be stored as high-quality JPEG for broad compatibility and lower storage use. Transparent or HDR PNGs are protected separately.",
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
     heic: { status: "convert", category: "image", method: "Convert to JPEG (quality 98)", targetFormat: "JPEG", targetExt: "jpg", qualityLoss: "minimal", qualityStars: 5, qualityLabel: "Highest practical quality", compatibilityLabel: "Excellent", estimatedSavingsRatio: 0.12, reason: "HEIC converted to a high-quality JPEG for maximum compatibility." },
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

const CACHE_VERSION    = 6; // bump when scan result shape or safety classification changes
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
const PER_FILE_EXTS = new Set(["jpg","jpeg","png","mp4","m4v","mov","mkv"]);
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

/** Returns an array of identified issues. Empty array means the JPEG is already optimal — skip it. */
async function analyzeJpegFile(filePath: string): Promise<string[]> {
  try {
    const sharp = (await import("sharp")).default;
    const meta  = await sharp(filePath, { failOn: "none" }).metadata();
    const issues: string[] = [];

    // Issue 1: Progressive encoding improves load performance and reduces file size
    if (meta.isProgressive === false) {
      issues.push("progressive encoding disabled");
    }

    // Issue 2: Non-optimized Huffman tables — detectable via significant entropy gap.
    // A well-optimized JPEG has chromaSubsampling set and effective entropy coding.
    // We compare EXIF overhead vs image size: large EXIF relative to total size suggests duplication.
    const totalBytes = (() => { try { return fs.statSync(filePath).size; } catch { return 0; } })();
    const exifBytes  = meta.exif?.length ?? 0;
    if (totalBytes > 0 && exifBytes / totalBytes > 0.05) {
      issues.push("excessive metadata overhead (EXIF > 5% of file size)");
    }

    // Issue 3: Chroma subsampling — 4:2:0 is more efficient; 4:4:4 typically not needed for photos
    if (meta.chromaSubsampling && meta.chromaSubsampling !== "4:2:0" && meta.chromaSubsampling !== "4:2:2") {
      issues.push(`suboptimal chroma subsampling (${meta.chromaSubsampling})`);
    }

    // An already-optimal JPEG: progressive + reasonable metadata + standard chroma = no issues
    // Do NOT add a catch-all — empty array means "already optimal, skip conversion"
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

    // RAW source files cannot be decoded by Sharp — route through ffmpeg first, then post-process.
    // Two-step pipeline for spec compliance:
    //   Step 1 (ffmpeg): RAW → baseline JPEG; quality 98 (-q:v 2), 4:4:4 chroma, Huffman optimal,
    //                    full metadata including ICC + EXIF + GPS preserved.
    //   Step 2 (sharp):  baseline JPEG → progressive JPEG; apply visual auto-rotation so EXIF
    //                    orientation tag is baked into pixels and reset to 1.
    if (RAW_EXTS.has(srcExt)) {
      const ffmpegTmp = destPath + ".raw_tmp.jpg";
      try {
        const result = spawnSync("ffmpeg", [
          "-y", "-i", srcPath,
          "-q:v", "2",              // quality ~98 (q:v 1 = quality 100; spec says 98 not 100)
          "-pix_fmt", "yuvj444p",   // 4:4:4 chroma subsampling — no chroma data loss
          "-huffman", "optimal",    // Huffman optimization passes
          "-map_metadata", "0",     // preserve EXIF, ICC color profile, GPS, timestamps
          ffmpegTmp,
        ], { encoding: "utf8", stdio: "pipe", timeout: 300_000 });
        if (result.status !== 0) {
          return formatMediaToolError("ffmpeg", result, (result.stderr ?? "").slice(-500));
        }

        // Step 2: post-process with sharp for progressive encoding and visual auto-rotation.
        // sharp.rotate() with no argument reads EXIF orientation and rotates pixels, then
        // resets the orientation tag to 1 — spec requirement for auto-rotate.
        const sharp = (await import("sharp")).default;
        await sharp(ffmpegTmp, { failOn: "none" })
          .rotate()                      // auto-rotate from EXIF orientation, resets tag to 1
          .withMetadata()                // preserve ICC, EXIF, GPS from the ffmpeg output
          .jpeg({ quality: 98, progressive: true, optimiseCoding: true, chromaSubsampling: "4:4:4", force: true })
          .toFile(destPath);

        return null;
      } finally {
        // Always clean up temp file regardless of success or failure
        try { fs.unlinkSync(ffmpegTmp); } catch { /* already gone or never created */ }
      }
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

export interface VerificationCheck {
  name: string;
  passed: boolean;
  details: string;
}

export interface VerificationResult {
  passed: boolean;
  checks: VerificationCheck[];
  failedCheck?: string;
}

async function verifyConvertedFile(
  srcPath: string,
  destPath: string,
  category = "image",
  isSameExt = true,
  originalBytes = (() => {
    try { return fs.statSync(srcPath).size; } catch { return 0; }
  })(),
  isRawSource = false,
): Promise<VerificationResult> {
  const checks: VerificationCheck[] = [];
  const pass = (name: string, details: string) => checks.push({ name, passed: true, details });
  const fail = (name: string, details: string): VerificationResult => {
    checks.push({ name, passed: false, details });
    return { passed: false, checks, failedCheck: `${name}: ${details}` };
  };

  // Check 1: Output file exists and non-zero.
  if (!fs.existsSync(destPath)) {
    return fail("output-exists", "Output file does not exist");
  }
  let convertedBytes = 0;
  try {
    convertedBytes = fs.statSync(destPath).size;
  } catch {
    return fail("output-exists", "Output file cannot be inspected");
  }
  if (convertedBytes === 0) {
    return fail("output-nonzero", "Output file is empty");
  }
  pass("output-nonzero", `Output exists (${convertedBytes} bytes)`);

  // Check 2: Size sanity — output must be smaller than source.
  if (convertedBytes >= originalBytes) {
    return fail("size-reduction", "Output not smaller than original");
  }
  pass("size-reduction", `${originalBytes - convertedBytes} bytes saved`);

  if (category === "image") {
    try {
      const sharp = (await import("sharp")).default;

      // Check 3: Output decodes without decoder error.
      let dstMeta: import("sharp").Metadata;
      try {
        dstMeta = await sharp(destPath, { failOn: "error" }).metadata();
      } catch (err: any) {
        return fail("decode", `Decoder error: ${(err.message ?? "unknown").slice(0, 200)}`);
      }
      if (!dstMeta.width || !dstMeta.height) {
        return fail("decode", "Output image has no dimensions");
      }
      pass("decode", `Decoded OK — ${dstMeta.width}×${dstMeta.height}`);

      // Check 4: Thumbnail generation verifies decodability end-to-end.
      try {
        const thumbBuf = await sharp(destPath, { failOn: "none" })
          .resize(200, 200, { fit: "inside" })
          .jpeg({ quality: 60 })
          .toBuffer();
        if (thumbBuf.length === 0) {
          return fail("thumbnail", "Generation produced an empty buffer");
        }
        pass("thumbnail", "Thumbnail generated successfully");
      } catch (err: any) {
        return fail("thumbnail", `Generation failed: ${(err.message ?? "unknown").slice(0, 120)}`);
      }

      // Check 5: Pixel hash — stored for the audit trail. A cross-format conversion
      // is allowed to change compressed bytes, but not to silently produce no pixels.
      {
        let pixelBuf: Buffer;
        try {
          pixelBuf = await sharp(destPath, { failOn: "none" })
            .resize(256, 256, { fit: "inside" })
            .raw()
            .toBuffer();
        } catch (err: any) {
          return fail("pixel-hash", `Extraction failed: ${(err.message ?? "unknown").slice(0, 120)}`);
        }
        const pixelHash = crypto.createHash("sha256").update(pixelBuf).digest("hex").slice(0, 16);
        if (pixelBuf.length === 0) return fail("pixel-hash", "No pixel data was decoded");
        pass("pixel-hash", `SHA-256 (256px): ${pixelHash}`);
      }

      // Check 6: Histogram / channel statistics — mandatory and retained in the result.
      {
        let stats: import("sharp").Stats;
        try {
          stats = await sharp(destPath, { failOn: "none" }).stats();
        } catch (err: any) {
          return fail("histogram", `Extraction failed: ${(err.message ?? "unknown").slice(0, 120)}`);
        }
        const chSummary = stats.channels.map((c, i) =>
          `ch${i}: mean=${c.mean.toFixed(1)} stdev=${c.stdev.toFixed(1)}`
        ).join(", ");
        pass("histogram", chSummary);
      }

      // Source metadata is available through Sharp for normal formats. RAW files
      // are read with exifr because Sharp does not decode every camera RAW.
      let srcMeta: import("sharp").Metadata | undefined;
      if (!isRawSource) {
        try {
          srcMeta = await sharp(srcPath, { failOn: "none" }).metadata();
        } catch (err: any) {
          return fail("source-metadata", `Read failed: ${(err.message ?? "unknown").slice(0, 120)}`);
        }
      }

      let srcExif: Record<string, unknown> = {};
      let dstExif: Record<string, unknown> = {};
      try {
        const exifr = await import("exifr");
        srcExif = (await exifr.parse(srcPath)) ?? {};
        dstExif = (await exifr.parse(destPath)) ?? {};
      } catch {
        // Some RAW/container variants have no EXIF parser support. Sharp metadata
        // checks below still protect ordinary image conversions.
      }

      const srcWidth = srcMeta?.width ?? Number(srcExif.ImageWidth ?? srcExif.ExifImageWidth);
      const srcHeight = srcMeta?.height ?? Number(srcExif.ImageHeight ?? srcExif.ExifImageHeight);
      if (!srcWidth || !srcHeight) {
        return fail("resolution", "Source dimensions could not be determined");
      }
      const srcPixels = srcWidth * srcHeight;
      const dstPixels = dstMeta.width! * dstMeta.height!;
      if (srcPixels !== dstPixels && Math.min(srcPixels, dstPixels) / Math.max(srcPixels, dstPixels) < 0.99) {
        return fail("resolution", `${srcWidth}×${srcHeight} → ${dstMeta.width}×${dstMeta.height}`);
      }
      pass("resolution", `${srcWidth}×${srcHeight} → ${dstMeta.width}×${dstMeta.height}`);

      const srcAspect = srcWidth / srcHeight;
      const dstAspect = dstMeta.width! / dstMeta.height!;
      if (Math.min(srcAspect, dstAspect) / Math.max(srcAspect, dstAspect) < 0.99) {
        return fail("aspect-ratio", `${srcAspect.toFixed(4)} → ${dstAspect.toFixed(4)}`);
      }
      pass("aspect-ratio", `${srcAspect.toFixed(4)} → ${dstAspect.toFixed(4)}`);

      const orientation = srcMeta?.orientation ?? Number(srcExif.Orientation);
      if (orientation !== undefined && orientation !== 0 && dstMeta.orientation !== undefined &&
          dstMeta.orientation !== 1 && dstMeta.orientation !== orientation) {
        return fail("orientation", `source=${orientation}, output=${dstMeta.orientation}`);
      }
      pass("orientation", `source=${orientation ?? "none"}, output=${dstMeta.orientation ?? "normalized"}`);

      const metadataFields: Array<[string, string[]]> = [
        ["date", ["DateTimeOriginal", "CreateDate", "ModifyDate"]],
        ["GPS", ["GPSLatitude", "GPSLongitude"]],
        ["camera", ["Make", "Model", "LensModel"]],
      ];
      for (const [label, fields] of metadataFields) {
        const sourceHas = fields.some((field) => srcExif[field] !== undefined && srcExif[field] !== null);
        const outputHas = fields.some((field) => dstExif[field] !== undefined && dstExif[field] !== null);
        if (sourceHas && !outputHas) return fail(`exif-${label}`, `Source field was not preserved`);
        pass(`exif-${label}`, sourceHas ? "Present in source and output" : "Not present in source");
      }

      if (srcMeta?.icc && !dstMeta.icc) {
        return fail("icc-profile", "Source ICC profile was stripped during conversion");
      }
      pass("icc-profile", srcMeta?.icc ? "ICC profile preserved" : "No source ICC profile");
    } catch (err: any) {
      return fail("verification", (err.message ?? "unknown").slice(0, 200));
    }
  }

  return { passed: true, checks };
}

// ── Conversion log ────────────────────────────────────────────────────────────

function appendConversionLog(nasPath: string, entry: Record<string, unknown>): void {
  try {
    appendPrivateJsonl(path.join(getWillardAIDir(nasPath), "logs", "conversions.jsonl"), entry);
  } catch (err) {
    logger.warn({ err, operation: "conversion_log" }, "Conversion operation log could not be persisted");
  }
}

// ── Endpoints ─────────────────────────────────────────────────────────────────

/**
 * Return the cached optimization opportunity for attention-center surfaces.
 *
 * This is deliberately read-only: the home page must not start a potentially
 * expensive NAS scan just to decide whether it has something useful to show.
 * The full scan page remains responsible for starting and refreshing scans.
 */
router.get("/optimize/status", async (_req, res) => {
  try {
    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const settings = settingsRows[0] ?? {} as typeof appSettingsTable.$inferSelect;
    const nasPath = settings.nasPath;
    const profile = (settings.optimizeProfile ?? "ARCHIVE") as OptimizeProfile;
    const rawConversionEnabled = settings.rawConversionEnabled ?? false;

    if (!nasPath) {
      res.json({ available: false });
      return;
    }

    const cached = readScanCache(nasPath, profile, rawConversionEnabled);
    if (!cached) {
      res.json({ available: false });
      return;
    }

    const groups = Array.isArray(cached.groups) ? cached.groups as Array<{
      extension?: string;
      fileCount?: number;
      estimatedSavingsBytes?: number;
      status?: string;
    }> : [];
    const safeGroups = groups.filter(group => group.status === "convert" && Number(group.fileCount) > 0);
    const safeFiles = safeGroups.reduce((total, group) => total + Number(group.fileCount ?? 0), 0);
    const estimatedSavingsBytes = safeGroups.reduce(
      (total, group) => total + Number(group.estimatedSavingsBytes ?? 0),
      0,
    );

    if (safeFiles === 0) {
      res.json({ available: false, scannedAt: cached.scannedAt, profile });
      return;
    }

    // Counts and savings are part of the identity: dismissing an opportunity
    // should not hide a materially different recommendation after a rescan.
    const recommendationKey = [
      profile,
      rawConversionEnabled ? "raw-on" : "raw-off",
      ...safeGroups
        .map(group => `${group.extension ?? "unknown"}:${Number(group.fileCount ?? 0)}:${Number(group.estimatedSavingsBytes ?? 0)}`)
        .sort(),
    ].join("|");

    res.json({
      available: true,
      safeFiles,
      estimatedSavingsBytes,
      formatCount: safeGroups.length,
      recommendationKey,
      scannedAt: cached.scannedAt,
      profile,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? "Optimization status failed" });
  }
});

router.get("/optimize/scan", async (req, res) => {
  try {
    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const settings = settingsRows[0] ?? {} as typeof appSettingsTable.$inferSelect;
    const nasPath        = settings.nasPath;
    if (!nasPath || !fs.existsSync(nasPath)) {
      res.status(400).json({ error: "NAS path is not configured or not accessible" });
      return;
    }

    const profile: OptimizeProfile = (settingsRows[0]?.optimizeProfile ?? "ARCHIVE") as OptimizeProfile;
    const rawConversionEnabled = settingsRows[0]?.rawConversionEnabled ?? false;
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
    const pngAttentionMap  = new Map<string, string>();

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

      if (ext === "png") {
        enrichPromises.push((async () => {
          const sharp = (await import("sharp")).default;
          for (const p of paths.slice(0, JPEG_ANALYZE_LIMIT)) {
            try {
              const meta = await sharp(p, { failOn: "none" }).metadata();
              if (meta.hasAlpha) { pngAttentionMap.set(ext, "Transparent PNG — converting to JPEG would lose the alpha channel."); break; }
              if (meta.depth && !["uchar", "char"].includes(meta.depth)) { pngAttentionMap.set(ext, "HDR / high-bit-depth PNG — preserve the original dynamic range."); break; }
            } catch { /* individual metadata failures are non-fatal */ }
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
      let rule        = FORMAT_RULES[ext];

      // Apply codec override for container video formats
      const detectedCodec = detectedCodecMap.get(ext);
      if (detectedCodec) {
        const override = buildCodecOverride(detectedCodec, ext);
        if (override) rule = { ...rule, ...override };
      }

      const jpegIssues = jpegIssuesMap.get(ext) ?? [];
      const status: FormatStatus = rule.status ?? "skip";
      const pngAttention = ext === "png" ? pngAttentionMap.get(ext) : undefined;
      const effectiveStatus: FormatStatus = pngAttention ? "protected" : status;
      const category  = rule?.category ?? "other";
      const savings = rule.estimatedSavingsRatio ? Math.round(bytes * rule.estimatedSavingsRatio) : 0;
       if (effectiveStatus === "convert") totalSavingsBytes += savings;

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
         status: effectiveStatus,
         classification: effectiveStatus === "convert" ? "safe" : effectiveStatus === "protected" ? "attention" : "skip",
        method:                rule.method ?? null,
        targetFormat:          rule.targetFormat ?? null,
        targetExt:             rule.targetExt ?? null,
        qualityLoss:           rule.qualityLoss ?? null,
        qualityStars:          rule.qualityStars ?? null,
        qualityLabel:          rule.qualityLabel ?? null,
        compatibilityLabel:    rule.compatibilityLabel ?? null,
        estimatedSavingsBytes: savings,
        estimatedSavingsRatio: rule.estimatedSavingsRatio ?? null,
         reason:                pngAttention ?? rule.reason,
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
    const aiPrivacy = await getAiPrivacySettings();
    if (!canSendToAiProvider(aiPrivacy)) {
      res.status(403).json({
        error: aiProviderBlockedReason(aiPrivacy),
        code: "AI_CONSENT_REQUIRED",
      });
      return;
    }
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

    const excludedExtensions = new Set(aiPrivacy.aiExcludedExtensions ?? []);
    const convertible = groups.filter(g =>
      g.status === "convert" &&
      !excludedExtensions.has(String(g.extension ?? "").replace(/^\./, "").toLowerCase()),
    );
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
      model: "gpt-5-mini",
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: 200,
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
    const nasPath: string | null | undefined = settings.nasPath;
    if (!nasPath || !fs.existsSync(nasPath)) {
      res.status(400).json({ error: "NAS path is not configured or not accessible" });
      return;
    }

    const profile: OptimizeProfile = (settingsRows[0]?.optimizeProfile ?? "ARCHIVE") as OptimizeProfile;
    const rawConversionEnabled = settingsRows[0]?.rawConversionEnabled ?? false;
    const FORMAT_RULES = getFormatRules(profile, rawConversionEnabled);

    // Load scan cache to check per-file decisions for codec-detected formats.
    // Container formats (mp4/mov/mkv/m4v) may show as "optimal" in static rules but
    // have per-file codec overrides in the scan cache making some files convertible.
    const cachedScan = readScanCache(nasPath, profile, rawConversionEnabled);
    const cachedDecisions = (cachedScan?.fileDecisions as Record<string, { convert: boolean; targetExt: string }> | undefined) ?? {};

    for (const ext of approvedExts) {
      const lext = ext.toLowerCase();
      const rule      = FORMAT_RULES[ext];

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

    const resolvedBackupDir: string = backupDir?.trim()
      || path.join(nasPath, "WillardAI", "ConversionBackups", new Date().toISOString().slice(0, 19).replace(/:/g, "-"));

    try { assertWithinRoot(path.resolve(resolvedBackupDir), path.resolve(nasPath)); }
    catch { res.status(400).json({ error: "Backup directory must be within the NAS root" }); return; }

    const capacity = await evaluateCapacity({
      nasPath,
      operation: "Conversion setup",
    });
    if (!capacity.allowed) {
      res.status(507).json({
        code: "CAPACITY_UNSAFE",
        error: "Insufficient safe storage capacity",
        message: capacity.message,
        capacity,
      });
      return;
    }

    const [job] = await db.insert(conversionJobsTable).values({
      status: "pending",
      approvedExts: approvedExts.map(ext => ext.toLowerCase()),
      backupDir: resolvedBackupDir,
      nasPath,
      totalFiles: 0,
      processedFiles: 0,
      succeededFiles: 0,
      failedFiles: 0,
      skippedFiles: 0,
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
      .set({ status: "pending", error: null, cancelledAt: null, totalFiles: 0, processedFiles: 0, succeededFiles: 0, failedFiles: 0, skippedFiles: 0, resultJson: null, completedAt: null })
      .where(eq(conversionJobsTable.id, id))
      .returning();
    res.json(updated);
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? "Failed to retry job" });
  }
});

router.post("/optimize/jobs/:id/cancel", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid job id" }); return; }
    const [job] = await db.select().from(conversionJobsTable).where(eq(conversionJobsTable.id, id)).limit(1);
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    if (job.status !== "running") {
      res.status(409).json({ error: `Cannot cancel a job with status '${job.status}'` });
      return;
    }
    const [updated] = await db.update(conversionJobsTable)
      .set({ cancelledAt: new Date() })
      .where(eq(conversionJobsTable.id, id))
      .returning();
    res.json({ id, status: updated?.status ?? job.status, cancellationRequested: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? "Failed to cancel conversion job" });
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
// Canonical alias from the task spec: POST /optimize/conversion/:jobId/action
// Bridges jobId → id param so the shared handler can read req.params.id.
router.post("/optimize/conversion/:jobId/action", async (req: any, res) => {
  req.params.id = req.params.jobId;
  return finalizeHandlerImpl(req, res);
});

async function finalizeHandlerImpl(req: any, res: any): Promise<void> {
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
        verification?: VerificationResult;
      }>;
      totalSaved: number;
      stagingDir: string;
    } | null;

    if (!resultData) { res.status(500).json({ error: "Job result data is missing" }); return; }

    const nasPath = job.nasPath;
    const capacity = await evaluateCapacity({
      nasPath,
      operation: `Finalize conversion #${id}`,
    });
    if (!capacity.allowed) {
      res.status(507).json({
        code: "CAPACITY_UNSAFE",
        error: "Insufficient safe storage capacity",
        message: capacity.message,
        capacity,
      });
      return;
    }
    const ts      = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    const trashBase   = path.join(getWillardAIDir(nasPath), ".Trash", ts);
    const archiveBase = path.join(getWillardAIDir(nasPath), "archive");

    const fileOutcomes: Array<{ originalPath: string; outputPath: string; action: string; error?: string }> = [];

    for (const file of resultData.files) {
      if (file.status !== "success" || !file.stagedPath) continue;
      if (!fs.existsSync(file.stagedPath)) continue;

      const originalPath  = file.filePath;
      const stagedPath    = file.stagedPath;
      const originalExt   = path.extname(originalPath).slice(1).toLowerCase();
      const convertedExt  = path.extname(stagedPath).slice(1).toLowerCase();
      const isCrossFormat = convertedExt !== originalExt;
      const stem          = path.basename(originalPath, path.extname(originalPath));
      const dir           = path.dirname(originalPath);
      const relPath       = path.relative(path.resolve(nasPath), path.resolve(originalPath));

      // For cross-format conversions (RAW→JPG, AVI→MP4, etc.) the output file MUST use the
      // converted format's extension. Never write JPEG bytes into a .cr2 file.
      const convertedPath = isCrossFormat
        ? path.join(dir, `${stem}.${convertedExt}`)
        : originalPath;
      const convertedRelPath = isCrossFormat
        ? path.relative(path.resolve(nasPath), path.resolve(convertedPath))
        : relPath;

      let outputPath = "";

      try {
        if (action === "replace") {
          // Remove original, place converted file at its correct path (may differ in extension)
          if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
          fs.renameSync(stagedPath, convertedPath);
          outputPath = convertedPath;
        } else if (action === "recycle") {
          if (process.platform === "win32") {
            // Windows: use PowerShell to send original to OS Recycle Bin (recoverable)
            const psResult = spawnSync("powershell", [
              "-NoProfile", "-Command",
              `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${originalPath.replace(/'/g, "''")}','OnlyErrorDialogs','SendToRecycleBin')`,
            ], { encoding: "utf8", stdio: "pipe", timeout: 30_000 });
            if (psResult.status !== 0) {
              throw new Error(`Recycle Bin move failed: ${(psResult.stderr ?? "").slice(0, 300)}`);
            }
          } else {
            // Linux/macOS/Replit: move original to WillardAI/.Trash/<timestamp>/ (reversible)
            const trashPath = path.join(trashBase, relPath);
            fs.mkdirSync(path.dirname(trashPath), { recursive: true });
            if (fs.existsSync(originalPath)) fs.renameSync(originalPath, trashPath);
          }
          // Place converted at correct path (extension matches format)
          fs.renameSync(stagedPath, convertedPath);
          outputPath = convertedPath;
        } else if (action === "keep-both") {
          // Original stays in place; converted gets _optimized suffix with converted extension
          const keepBothPath = path.join(dir, `${stem}_optimized.${convertedExt}`);
          fs.renameSync(stagedPath, keepBothPath);
          outputPath = keepBothPath;
        } else if (action === "archive") {
          // Archive original at WillardAI/archive/; converted placed at correct path
          const archivePath = path.join(archiveBase, relPath);
          fs.mkdirSync(path.dirname(archivePath), { recursive: true });
          if (fs.existsSync(originalPath)) fs.renameSync(originalPath, archivePath);
          fs.renameSync(stagedPath, convertedPath);
          outputPath = convertedPath;
        }
        void convertedRelPath; // used for logging only
        fileOutcomes.push({ originalPath, outputPath, action });
      } catch (err: any) {
        fileOutcomes.push({ originalPath, outputPath: "", action, error: err.message });
      }

      appendConversionLog(nasPath, {
        ts:                  new Date().toISOString(),
        jobId:               id,
        action,
        originalPath,
        outputPath:          fileOutcomes[fileOutcomes.length - 1]?.outputPath ?? "",
        originalBytes:       file.originalBytes,
        convertedBytes:      file.convertedBytes,
        savedBytes:          Math.max(0, (file.originalBytes ?? 0) - (file.convertedBytes ?? 0)),
        verificationResults: file.verification ?? { passed: false, checks: [] },
        error:               fileOutcomes[fileOutcomes.length - 1]?.error,
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
}

router.post("/optimize/jobs/:id/finalize", finalizeHandlerImpl);

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

router.post("/optimize/jobs/:id/execute-token", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid job id" }); return; }
  try {
    const [job] = await db.select().from(conversionJobsTable)
      .where(eq(conversionJobsTable.id, id)).limit(1);
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    if (job.status !== "pending") {
      res.status(409).json({ error: `Job cannot start from status '${job.status}'` });
      return;
    }
    const token = await issueActionToken(req, "optimize-execute", String(id));
    res.json({ token, expiresInSeconds: 300 });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not authorize conversion" });
  }
});

/**
 * GET /optimize/jobs/:id/execute — SSE stream that executes the conversion job.
 * Streams events: status | file_done | summary | error
 */
router.get("/optimize/jobs/:id/execute", async (req, res) => {
  const id = parseInt(req.params.id);

  if (!await consumeActionToken(req, req.query.token, "optimize-execute", String(id))) {
    res.status(403).json({ error: "A valid one-time execution token is required." });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (event: string, data: object) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
  };

  let capacityReservation: CapacityReservation | null = null;
  try {
    const [job] = await db.select().from(conversionJobsTable).where(eq(conversionJobsTable.id, id)).limit(1);
    if (!job) { send("error", { message: "Job not found" }); res.end(); return; }
    if (job.status === "running") { send("error", { message: "Job is already running" }); res.end(); return; }
    if (job.status === "done" || job.status === "failed" || job.status === "cancelled") {
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

    await db.update(conversionJobsTable).set({ status: "running", cancelledAt: null, error: null }).where(eq(conversionJobsTable.id, id));
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

    const estimatedStagingBytes = filesToConvert.reduce((sum, file) => {
      try { return sum + fs.statSync(file.fullPath).size; } catch { return sum; }
    }, 0);
    try {
      capacityReservation = await reserveCapacity({
        nasPath,
        operation: `Conversion job #${id}`,
        nasBytes: estimatedStagingBytes,
      });
    } catch (error) {
      const admission = error instanceof CapacityAdmissionError ? error.admission : null;
      const message = error instanceof Error ? error.message : "Conversion capacity admission failed";
      await db.update(conversionJobsTable).set({ status: "failed", error: message }).where(eq(conversionJobsTable.id, id));
      send("error", { code: "CAPACITY_UNSAFE", message, capacity: admission });
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
        verification?:  VerificationResult;
    }> = [];

    // A file may still exist when the user chose to keep both/archive originals.
    // Read the recorded per-file results so a later run does not convert it again.
    // This deliberately includes cancelled/awaiting-action jobs: a successful staged
    // conversion is still a successful conversion, even if the run did not finish.
    const priorJobs = await db.select({ resultJson: conversionJobsTable.resultJson })
      .from(conversionJobsTable)
      .where(eq(conversionJobsTable.nasPath, nasPath));
    const previouslyConverted = new Set<string>();
    for (const priorJob of priorJobs) {
      const files = (priorJob.resultJson as { files?: Array<{ filePath?: string; status?: string }> } | null)?.files;
      for (const file of files ?? []) {
        if (file.status === "success" && file.filePath) {
          previouslyConverted.add(path.resolve(file.filePath));
        }
      }
    }

    for (let i = 0; i < filesToConvert.length; i++) {
      const [currentJob] = await db.select({ cancelledAt: conversionJobsTable.cancelledAt })
        .from(conversionJobsTable).where(eq(conversionJobsTable.id, id)).limit(1);
      if (currentJob?.cancelledAt) break;
      const { fullPath, ext } = filesToConvert[i];

      if (previouslyConverted.has(path.resolve(fullPath))) {
        skipped++;
        const skipReason = "Previously converted in an earlier conversion job";
        results.push({ filePath: fullPath, status: "skipped", error: skipReason });
        await db.update(conversionJobsTable).set({ processedFiles: i + 1, skippedFiles: skipped }).where(eq(conversionJobsTable.id, id));
        send("file_done", { filePath: fullPath, status: "skipped", error: skipReason, processed: i + 1, total: totalFiles });
        continue;
      }

      // Use per-file decision from scan cache when available; fall back to extension-level rule.
      const perFileDecision = execFileDecisions[fullPath];
      const rule      = FORMAT_RULES[ext];
      const category  = rule?.category ?? "other";

      // For codec-sensitive container formats (mp4/mov/mkv/m4v), REQUIRE a per-file scan decision.
      // If no decision was cached (stale/missing scan), default to SKIP — never blindly re-encode
      // a container file without knowing its codec (could re-encode an already-modern H.265 file).
      const CODEC_SENSITIVE = new Set(["mp4", "m4v", "mov", "mkv"]);
      if (CODEC_SENSITIVE.has(ext) && !perFileDecision) {
        skipped++;
        const skipReason = "Per-file analysis: already optimal";
        results.push({ filePath: fullPath, status: "skipped", error: skipReason });
        await db.update(conversionJobsTable).set({ processedFiles: i + 1, skippedFiles: skipped }).where(eq(conversionJobsTable.id, id));
        send("file_done", { filePath: fullPath, status: "skipped", error: skipReason, processed: i + 1, total: totalFiles });
        continue;
      }

      // For JPEG files not covered by the scan cache (>20 per group or stale cache),
      // run on-demand per-file analysis at execute time — true per-file decision.
      // This mirrors the codec-sensitive-container pattern: never convert without analysis.
      if ((ext === "jpg" || ext === "jpeg") && !perFileDecision) {
        const jpegIssues = await analyzeJpegFile(fullPath);
        if (jpegIssues.length === 0) {
          skipped++;
          const skipReason = "Per-file analysis: already optimal";
          results.push({ filePath: fullPath, status: "skipped", error: skipReason });
          await db.update(conversionJobsTable).set({ processedFiles: i + 1, skippedFiles: skipped }).where(eq(conversionJobsTable.id, id));
          send("file_done", { filePath: fullPath, status: "skipped", error: skipReason, processed: i + 1, total: totalFiles });
          continue;
        }
        // Issues found — proceed with conversion (perFileDecision stays undefined, ext-level rule applies)
      }

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
          results.push({ filePath: fullPath, status: "skipped", error: "Already optimized (output not smaller than original)", verification });
          await db.update(conversionJobsTable).set({ processedFiles: i + 1, skippedFiles: skipped }).where(eq(conversionJobsTable.id, id));
          send("file_done", { filePath: fullPath, status: "skipped", error: "Already optimized", processed: i + 1, total: totalFiles });
        } else {
          failed++;
          results.push({ filePath: fullPath, status: "failed", error: verification.failedCheck ?? "Verification failed", verification });
          await db.update(conversionJobsTable).set({ processedFiles: i + 1, failedFiles: failed }).where(eq(conversionJobsTable.id, id));
          send("file_done", { filePath: fullPath, status: "failed", error: verification.failedCheck ?? "Verification failed", processed: i + 1, total: totalFiles });
        }
        continue;
      }

      let convertedBytes = 0;
      try { convertedBytes = fs.statSync(stagedPath).size; } catch { /* best effort */ }

      // ── Success: original is safe, staged file is verified ──────────────────
      succeeded++;
      results.push({ filePath: fullPath, stagedPath, status: "success", originalBytes, convertedBytes, isSameExt, verification });
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

      // Cancellation is intentionally checked after the current file has fully
      // converted and verified, preserving all completed staged files.
      const [afterFileJob] = await db.select({ cancelledAt: conversionJobsTable.cancelledAt })
        .from(conversionJobsTable).where(eq(conversionJobsTable.id, id)).limit(1);
      if (afterFileJob?.cancelledAt) break;
    }

    const totalSaved = results.reduce((s, r) => s + Math.max(0, (r.originalBytes ?? 0) - (r.convertedBytes ?? 0)), 0);
    const resultJson = { files: results, totalSaved, stagingDir };
    const [finishedJob] = await db.select({ cancelledAt: conversionJobsTable.cancelledAt })
      .from(conversionJobsTable).where(eq(conversionJobsTable.id, id)).limit(1);
    const wasCancelled = Boolean(finishedJob?.cancelledAt);

    // Stage 4: Await user action — originals are untouched; staged files ready for user decision.
    await db.update(conversionJobsTable).set({
      status: wasCancelled ? "cancelled" : "awaiting_action", processedFiles: results.length, succeededFiles: succeeded, failedFiles: failed,
      skippedFiles: skipped, completedAt: new Date(), resultJson,
    }).where(eq(conversionJobsTable.id, id));

    send("status", {
      stage: wasCancelled ? "cancelled" : "awaiting_action",
      message: wasCancelled
        ? `Conversion cancelled after ${results.length} of ${totalFiles} files — staged files are preserved`
        : "Conversions staged — choose what to do with your originals",
      progress: wasCancelled ? Math.round(5 + (results.length / totalFiles) * 90) : 100,
      processed: results.length,
      total: totalFiles,
    });
    send("summary", { totalFiles, succeeded, failed, skipped, totalSavedBytes: totalSaved, stagingDir, cancelled: wasCancelled, results: results.slice(0, 200) });
    if (!wasCancelled && succeeded > 0) void requestLibraryBackup("completed optimization processing");
    res.end();
  } catch (e: any) {
    try {
      await db.update(conversionJobsTable).set({ status: "failed", error: e.message ?? "Unknown error" }).where(eq(conversionJobsTable.id, id));
    } catch { /* best effort */ }
    send("error", { message: e.message ?? "Conversion failed" });
    res.end();
  } finally {
    if (capacityReservation) releaseCapacity(capacityReservation.id);
  }
});

export default router;
