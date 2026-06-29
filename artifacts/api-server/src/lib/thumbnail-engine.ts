import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { getWillardAIDir } from "./nas-storage";

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
): Promise<string | null> {
  try {
    const sharp = (await import("sharp")).default;
    await sharp(sourcePath, { failOn: "none" })
      .rotate()
      .resize({ width: 400, height: 400, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 75 })
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
): string | null {
  const tmpPng = destPath.replace(/\.webp$/, ".tmp.png");
  const result = spawnSync("ffmpeg", [
    "-y",
    "-ss", "00:00:01",
    "-i", sourcePath,
    "-frames:v", "1",
    "-vf", "scale=400:-2",
    tmpPng,
  ], { encoding: "buffer", timeout: 30000 });

  if (result.status !== 0 || !fs.existsSync(tmpPng)) {
    return `ffmpeg exited ${result.status}`;
  }

  // Convert PNG → WebP via sharp
  return generateImageThumbnailSync(tmpPng, destPath);
}

function generateImageThumbnailSync(
  sourcePath: string,
  destPath: string,
): string | null {
  const result = spawnSync("ffmpeg", [
    "-y",
    "-i", sourcePath,
    "-vf", "scale=400:-2",
    "-frames:v", "1",
    destPath,
  ], { encoding: "buffer", timeout: 15000 });
  try { fs.rmSync(sourcePath); } catch { /* ignore */ }
  if (result.status !== 0) {
    return `ffmpeg conversion failed: ${result.status}`;
  }
  return null;
}

// ── PDF thumbnail via ImageMagick / ffmpeg fallback ───────────────────────────

function generatePdfThumbnail(
  sourcePath: string,
  destPath: string,
): string | null {
  const result = spawnSync("ffmpeg", [
    "-y",
    "-i", sourcePath,
    "-frames:v", "1",
    "-vf", "scale=400:-2",
    destPath,
  ], { encoding: "buffer", timeout: 30000 });
  if (result.status !== 0) {
    return `ffmpeg pdf thumbnail failed: ${result.status}`;
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
): Promise<ThumbnailResult> {
  const thumbDir = ensureThumbnailDir(nasPath);
  const destPath = path.join(thumbDir, thumbnailFilename(mediaFileId));

  // Already generated
  if (fs.existsSync(destPath)) {
    return { destPath, error: null };
  }

  const ext = extension.toLowerCase().replace(/^\./, "");

  let error: string | null = null;

  if (IMAGE_EXTS.has(ext)) {
    error = await generateImageThumbnail(sourcePath, destPath);
  } else if (VIDEO_EXTS.has(ext)) {
    error = generateVideoThumbnail(sourcePath, destPath);
  } else if (ext === "pdf") {
    error = generatePdfThumbnail(sourcePath, destPath);
  } else {
    error = `Unsupported extension: ${ext}`;
  }

  if (error) {
    return { destPath: "", error };
  }
  return { destPath, error: null };
}
