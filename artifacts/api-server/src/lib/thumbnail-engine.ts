import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { getWillardAIDir } from "./nas-storage";
import { formatMediaToolError } from "./media-tools";

// ── Quality presets ────────────────────────────────────────────────────────────

export type ThumbnailQuality = "FAST" | "BALANCED" | "HIGH";

interface QualityPreset { sizePx: number; quality: number }

const QUALITY_PRESETS: Record<ThumbnailQuality, QualityPreset> = {
  FAST:     { sizePx: 256, quality: 65 },
  BALANCED: { sizePx: 512, quality: 80 },
  HIGH:     { sizePx: 1024, quality: 90 },
};

export function qualityPreset(q: string | null | undefined): QualityPreset {
  const key = (q ?? "BALANCED").toUpperCase() as ThumbnailQuality;
  return QUALITY_PRESETS[key] ?? QUALITY_PRESETS.BALANCED;
}

// ── Thumbnail directory ────────────────────────────────────────────────────────

export function getThumbnailDir(nasPath: string): string {
  return path.join(getWillardAIDir(nasPath), "cache", "thumbnails");
}

export function ensureThumbnailDir(nasPath: string): string {
  const dir = getThumbnailDir(nasPath);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Safe filename from media file id ──────────────────────────────────────────

export function thumbnailFilename(mediaFileId: number): string {
  return `${mediaFileId}.webp`;
}

// ── Image thumbnail via sharp ──────────────────────────────────────────────────

const IMAGE_EXTS = new Set([
  "jpg", "jpeg", "png", "webp", "heic", "heif", "avif", "tiff", "tif",
  "bmp", "gif",
]);

async function generateImageThumbnail(
  sourcePath: string,
  destPath: string,
  sizePx: number,
  quality: number,
): Promise<string | null> {
  try {
    const sharp = (await import("sharp")).default;
    await sharp(sourcePath, { failOn: "none" })
      .rotate()
      .resize({ width: sizePx, height: sizePx, fit: "inside", withoutEnlargement: true })
      .webp({ quality })
      .toFile(destPath);
    return null;
  } catch (err: any) {
    return err?.message ?? "sharp failed";
  }
}

// ── Video thumbnail via ffmpeg ────────────────────────────────────────────────

const VIDEO_EXTS = new Set([
  "mp4", "mov", "avi", "mkv", "webm", "m4v", "wmv", "flv", "3gp",
  "ts", "mts", "m2ts", "mpeg", "mpg",
]);

function generateVideoThumbnail(
  sourcePath: string,
  destPath: string,
  sizePx: number,
): string | null {
  const tmpPng = destPath.replace(/\.webp$/, ".tmp.png");
  const result = spawnSync("ffmpeg", [
    "-y",
    "-ss", "00:00:01",
    "-i", sourcePath,
    "-frames:v", "1",
    "-vf", `scale=${sizePx}:-2`,
    tmpPng,
  ], { encoding: "buffer", timeout: 30000 });

  if (result.status !== 0 || !fs.existsSync(tmpPng)) {
    return formatMediaToolError("ffmpeg", result);
  }

  return generateImageThumbnailSync(tmpPng, destPath, sizePx);
}

function generateImageThumbnailSync(
  sourcePath: string,
  destPath: string,
  sizePx: number,
): string | null {
  const result = spawnSync("ffmpeg", [
    "-y",
    "-i", sourcePath,
    "-vf", `scale=${sizePx}:-2`,
    "-frames:v", "1",
    destPath,
  ], { encoding: "buffer", timeout: 15000 });
  try { fs.rmSync(sourcePath); } catch { /* ignore */ }
  if (result.status !== 0) {
    return formatMediaToolError("ffmpeg", result);
  }
  return null;
}

// ── PDF thumbnail via ffmpeg ───────────────────────────────────────────────────

function generatePdfThumbnail(
  sourcePath: string,
  destPath: string,
  sizePx: number,
): string | null {
  const result = spawnSync("ffmpeg", [
    "-y",
    "-i", sourcePath,
    "-frames:v", "1",
    "-vf", `scale=${sizePx}:-2`,
    destPath,
  ], { encoding: "buffer", timeout: 30000 });
  if (result.status !== 0) {
    return formatMediaToolError("ffmpeg", result);
  }
  return null;
}

// ── FFmpeg image-to-thumbnail fallback ────────────────────────────────────────
// Used when sharp is unavailable or fails (e.g. HEIC without libheif, AVIF, or
// a native binding issue on the user's platform). ffmpeg handles far more image
// formats and doesn't rely on platform-specific native add-ons.

function generateImageThumbnailFfmpeg(
  sourcePath: string,
  destPath: string,
  sizePx: number,
): string | null {
  const result = spawnSync("ffmpeg", [
    "-y",
    "-i", sourcePath,
    "-vf", `scale=${sizePx}:-2`,
    "-frames:v", "1",
    destPath,
  ], { encoding: "buffer", timeout: 30000 });
  if (result.status !== 0 || !fs.existsSync(destPath)) {
    const stderr = result.stderr ? Buffer.from(result.stderr).toString("utf8").slice(0, 200) : "";
    return `ffmpeg image conversion failed (exit ${result.status}): ${stderr}`;
  }
  return null;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export interface ThumbnailResult {
  destPath: string;
  error: string | null;
}

export async function generateThumbnail(
  mediaFileId: number,
  sourcePath: string,
  extension: string,
  nasPath: string,
  quality?: string | null,
): Promise<ThumbnailResult> {
  const thumbDir = ensureThumbnailDir(nasPath);
  const destPath = path.join(thumbDir, thumbnailFilename(mediaFileId));

  // Already generated — verify the file is non-empty.
  // Partial writes from an interrupted backfill job can leave a 0-byte file on
  // disk; a valid WebP thumbnail is always well above 100 bytes.
  if (fs.existsSync(destPath)) {
    try {
      const { size } = fs.statSync(destPath);
      if (size > 100) return { destPath, error: null };
    } catch { /* fall through and regenerate */ }
    // File is empty / unreadable — delete and regenerate
    try { fs.unlinkSync(destPath); } catch { /* ignore */ }
  }

  const preset = qualityPreset(quality);
  const ext = extension.toLowerCase().replace(/^\./, "");

  let error: string | null = null;

  if (IMAGE_EXTS.has(ext)) {
    error = await generateImageThumbnail(sourcePath, destPath, preset.sizePx, preset.quality);
    // Fallback: if sharp fails (missing native libs, HEIC without libheif, AVIF,
    // platform binding issues) try ffmpeg — it handles a much wider format range
    // without platform-specific build dependencies.
    if (error) {
      const sharpError = error;
      const ffmpegError = generateImageThumbnailFfmpeg(sourcePath, destPath, preset.sizePx);
      if (!ffmpegError && fs.existsSync(destPath)) {
        try {
          if (fs.statSync(destPath).size > 100) {
            error = null; // ffmpeg fallback succeeded
          }
        } catch { /* keep original error */ }
      }
      if (error) {
        error = `sharp: ${sharpError}; ffmpeg: ${ffmpegError ?? "unknown"}`;
      }
    }
  } else if (VIDEO_EXTS.has(ext)) {
    error = generateVideoThumbnail(sourcePath, destPath, preset.sizePx);
  } else if (ext === "pdf") {
    error = generatePdfThumbnail(sourcePath, destPath, preset.sizePx);
  } else {
    error = `Unsupported extension: ${ext}`;
  }

  if (error) {
    return { destPath: "", error };
  }
  return { destPath, error: null };
}

// ── Cache stats ───────────────────────────────────────────────────────────────

export function getThumbnailCacheSizeBytes(nasPath: string): number {
  const dir = getThumbnailDir(nasPath);
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  try {
    for (const file of fs.readdirSync(dir)) {
      try {
        total += fs.statSync(path.join(dir, file)).size;
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return total;
}

export function clearThumbnailCache(nasPath: string): number {
  const dir = getThumbnailDir(nasPath);
  if (!fs.existsSync(dir)) return 0;
  let deleted = 0;
  try {
    for (const file of fs.readdirSync(dir)) {
      try {
        fs.rmSync(path.join(dir, file));
        deleted++;
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return deleted;
}
