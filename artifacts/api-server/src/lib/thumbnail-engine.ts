import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { getWillardAIDir } from "./nas-storage.ts";
import { formatMediaToolError } from "./media-tools.ts";

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

// A tiny valid WebP can be smaller than 100 bytes, so use the minimum size
// needed for a RIFF/WebP header and validate the declared RIFF length too.
const MIN_VALID_THUMBNAIL_BYTES = 32;
const THUMBNAIL_LOCK_STALE_MS = 2 * 60_000;
let tempSequence = 0;
const thumbnailLocks = new Map<string, Promise<void>>();

export function isThumbnailFileValid(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= MIN_VALID_THUMBNAIL_BYTES) return false;
    const header = Buffer.alloc(12);
    const fd = fs.openSync(filePath, "r");
    try {
      const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
      return bytesRead >= 12 &&
        header.subarray(0, 4).toString("ascii") === "RIFF" &&
        header.subarray(8, 12).toString("ascii") === "WEBP" &&
        header.readUInt32LE(4) + 8 <= stat.size;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function acquireThumbnailLock(destPath: string): Promise<() => void> {
  const previous = thumbnailLocks.get(destPath) ?? Promise.resolve();
  let releaseLocal!: () => void;
  const localTurn = new Promise<void>(resolve => { releaseLocal = resolve; });
  thumbnailLocks.set(destPath, localTurn);
  await previous;

  const lockPath = `${destPath}.lock`;
  let fd: number | null = null;
  try {
    for (let attempt = 0; attempt < 600; attempt++) {
      try {
        fd = fs.openSync(lockPath, "wx");
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
        break;
      } catch (err: any) {
        if (err?.code !== "EEXIST") throw err;
        try {
          const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
          if (ageMs > THUMBNAIL_LOCK_STALE_MS) fs.unlinkSync(lockPath);
        } catch { /* another process may be replacing/removing the lock */ }
        await sleep(50);
      }
    }
    if (fd === null) throw new Error("Timed out waiting for thumbnail generation lock");
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
      try { fs.unlinkSync(lockPath); } catch { /* best effort */ }
    }
    releaseLocal();
    if (thumbnailLocks.get(destPath) === localTurn) thumbnailLocks.delete(destPath);
    throw err;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { fs.closeSync(fd!); } catch { /* already closed */ }
    try { fs.unlinkSync(lockPath); } catch { /* stale or already removed */ }
    releaseLocal();
    if (thumbnailLocks.get(destPath) === localTurn) thumbnailLocks.delete(destPath);
  };
}

function uniqueThumbnailTempPath(destPath: string): string {
  return `${destPath}.${process.pid}.${Date.now()}.${++tempSequence}.tmp.webp`;
}

function publishThumbnail(tempPath: string, destPath: string): void {
  if (!isThumbnailFileValid(tempPath)) {
    throw new Error("Thumbnail generation produced a missing or corrupt WebP");
  }
  try {
    fs.renameSync(tempPath, destPath);
  } catch (err: any) {
    // A valid destination wins rather than being overwritten by a second
    // process that did not observe the lock (for example, an older build).
    if ((err?.code === "EEXIST" || err?.code === "EPERM") && isThumbnailFileValid(destPath)) {
      fs.rmSync(tempPath, { force: true });
      return;
    }
    throw err;
  }
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
  const tmpPng = destPath.replace(/\.webp$/, ".frame.png");
  try {
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
  } finally {
    try { fs.rmSync(tmpPng, { force: true }); } catch { /* best effort */ }
  }
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

  // Publishers never write directly to the final path, so this fast path
  // cannot expose an in-progress file. Invalid legacy output is handled only
  // after acquiring the destination lock.
  if (isThumbnailFileValid(destPath)) return { destPath, error: null };

  let releaseLock: (() => void) | null = null;
  try {
    releaseLock = await acquireThumbnailLock(destPath);
  } catch (err: any) {
    return { destPath: "", error: err?.message ?? "Could not lock thumbnail destination" };
  }

  const tempPath = uniqueThumbnailTempPath(destPath);
  try {
    // Re-check after waiting: another process may have published it.
    if (isThumbnailFileValid(destPath)) return { destPath, error: null };
    try { fs.rmSync(destPath, { force: true }); } catch { /* regenerate below */ }

    const preset = qualityPreset(quality);
    const ext = extension.toLowerCase().replace(/^\./, "");
    let error: string | null = null;

    if (IMAGE_EXTS.has(ext)) {
      error = await generateImageThumbnail(sourcePath, tempPath, preset.sizePx, preset.quality);
      // Fallback: if sharp fails (missing native libs, HEIC without libheif,
      // AVIF, or another platform binding issue), try ffmpeg.
      if (error) {
        const sharpError = error;
        const ffmpegError = generateImageThumbnailFfmpeg(sourcePath, tempPath, preset.sizePx);
        if (!ffmpegError && isThumbnailFileValid(tempPath)) error = null;
        if (error) error = `sharp: ${sharpError}; ffmpeg: ${ffmpegError ?? "unknown"}`;
      }
    } else if (VIDEO_EXTS.has(ext)) {
      error = generateVideoThumbnail(sourcePath, tempPath, preset.sizePx);
    } else if (ext === "pdf") {
      error = generatePdfThumbnail(sourcePath, tempPath, preset.sizePx);
    } else {
      error = `Unsupported extension: ${ext}`;
    }

    if (error) return { destPath: "", error };
    publishThumbnail(tempPath, destPath);
    return { destPath, error: null };
  } catch (err: any) {
    return { destPath: "", error: err?.message ?? "Thumbnail publication failed" };
  } finally {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* best effort */ }
    releaseLock();
  }
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
