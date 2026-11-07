import * as fs from "fs";
import * as path from "path";

import { ensureDataDirectoryWithinRoot, getWillardAIDir, resolveWithinRoot } from "./nas-storage.ts";
import { formatMediaToolExecutionError, runMediaToolAsync } from "./media-tools.ts";
import { StoragePolicyError } from "./storage-policy.ts";

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

/** Return an existing cache directory only after rejecting symlinked ancestors. */
function getExistingThumbnailDir(nasPath: string): string | null {
  const dir = getThumbnailDir(nasPath);
  try {
    fs.lstatSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return ensureDataDirectoryWithinRoot(dir, nasPath);
}

export function ensureThumbnailDir(nasPath: string): string {
  const dir = getThumbnailDir(nasPath);
  try {
    return ensureDataDirectoryWithinRoot(dir, nasPath);
  } catch (err) {
    throw new StoragePolicyError(
      `NAS storage is required for thumbnail derivatives; the NAS cache directory could not be created safely: ${
        err instanceof Error ? err.message : "unknown error"
      }`,
    );
  }
}

// ── Safe filename from media file id ──────────────────────────────────────────

export function thumbnailFilename(mediaFileId: number): string {
  return `${mediaFileId}.webp`;
}

/**
 * Return the first usable derivative for a catalog row. The database pointer is
 * preferred, but the canonical id-based cache path is also checked so a
 * process restart between publishing the file and saving the pointer does not
 * queue work that is already complete.
 */
export function findValidThumbnailPath(
  mediaFileId: number,
  nasPath: string,
  storedPath?: string | null,
): string | null {
  const root = getWillardAIDir(nasPath);
  try {
    getExistingThumbnailDir(nasPath);
  } catch {
    return null;
  }
  if (storedPath) {
    try {
      const safePath = resolveWithinRoot(storedPath, root);
      if (isThumbnailFileValid(safePath)) return safePath;
    } catch {
      // A stale or unsafe pointer is treated as a cache miss.
    }
  }

  try {
    const canonicalPath = resolveWithinRoot(
      path.join(getThumbnailDir(nasPath), thumbnailFilename(mediaFileId)),
      root,
    );
    return isThumbnailFileValid(canonicalPath) ? canonicalPath : null;
  } catch {
    return null;
  }
}

export const THUMBNAIL_REUSE_PROBE_MAX_FILES = 500;

/**
 * Inspect at most one thumbnail-job slice. This keeps restart cache healing
 * independent of total library size and makes the probe budget testable.
 */
export function findReusableThumbnailPaths(
  mediaFileIds: number[],
  nasPath: string,
  limit = THUMBNAIL_REUSE_PROBE_MAX_FILES,
  storedPaths = new Map<number, string | null>(),
): Map<number, string> {
  const boundedLimit = Math.max(0, Math.min(
    limit,
    THUMBNAIL_REUSE_PROBE_MAX_FILES,
    mediaFileIds.length,
  ));
  const reusable = new Map<number, string>();
  for (const id of mediaFileIds.slice(0, boundedLimit)) {
    const validPath = findValidThumbnailPath(id, nasPath, storedPaths.get(id) ?? null);
    if (validPath) reusable.set(id, validPath);
  }
  return reusable;
}

// A tiny valid WebP can be smaller than 100 bytes, so use the minimum size
// needed for a RIFF/WebP header and validate the declared RIFF length too.
const MIN_VALID_THUMBNAIL_BYTES = 32;
/** A backfill is intentionally bounded; on-demand requests remain lazy. */
export const THUMBNAIL_CACHE_MAX_BYTES = 1 * 1024 * 1024 * 1024;
const INCOMPLETE_FILE_RETENTION_MS = 15 * 60_000;
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
        // Never steal a lock based only on age: thumbnail generation can
        // legitimately exceed two minutes on slow disks or large media. A
        // stale lock may require operator cleanup after a crash, but deleting
        // it here could let two processes publish the same derivative.
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

async function generateVideoThumbnail(
  sourcePath: string,
  destPath: string,
  sizePx: number,
): Promise<string | null> {
  const tmpPng = destPath.replace(/\.webp$/, ".frame.png");
  try {
    await runMediaToolAsync("ffmpeg", [
      "-nostdin", "-v", "error",
      "-y",
      "-ss", "00:00:01",
      "-i", sourcePath,
      "-frames:v", "1",
      "-vf", `scale=${sizePx}:-2`,
      tmpPng,
    ], { timeoutMs: 30_000, maxBufferBytes: 1024 * 1024 });

    if (!fs.existsSync(tmpPng)) return "ffmpeg did not produce a video frame";
    return await generateImageThumbnailFfmpeg(tmpPng, destPath, sizePx);
  } catch (error) {
    return formatMediaToolExecutionError("ffmpeg", error, 30_000);
  } finally {
    try { fs.rmSync(tmpPng, { force: true }); } catch { /* best effort */ }
  }
}

// ── PDF thumbnail via ffmpeg ───────────────────────────────────────────────────

async function generatePdfThumbnail(
  sourcePath: string,
  destPath: string,
  sizePx: number,
): Promise<string | null> {
  try {
    await runMediaToolAsync("ffmpeg", [
      "-nostdin", "-v", "error",
      "-y",
      "-i", sourcePath,
      "-frames:v", "1",
      "-vf", `scale=${sizePx}:-2`,
      destPath,
    ], { timeoutMs: 30_000, maxBufferBytes: 1024 * 1024 });
    return fs.existsSync(destPath) ? null : "ffmpeg did not produce a PDF thumbnail";
  } catch (error) {
    return formatMediaToolExecutionError("ffmpeg", error, 30_000);
  }
}

// ── FFmpeg image-to-thumbnail fallback ────────────────────────────────────────
// Used when sharp is unavailable or fails (e.g. HEIC without libheif, AVIF, or
// a native binding issue on the user's platform). ffmpeg handles far more image
// formats and doesn't rely on platform-specific native add-ons.

async function generateImageThumbnailFfmpeg(
  sourcePath: string,
  destPath: string,
  sizePx: number,
): Promise<string | null> {
  try {
    await runMediaToolAsync("ffmpeg", [
      "-nostdin", "-v", "error",
      "-y",
      "-i", sourcePath,
      "-vf", `scale=${sizePx}:-2`,
      "-frames:v", "1",
      destPath,
    ], { timeoutMs: 30_000, maxBufferBytes: 1024 * 1024 });
    return fs.existsSync(destPath) ? null : "ffmpeg did not produce an image thumbnail";
  } catch (error) {
    return formatMediaToolExecutionError("ffmpeg", error, 30_000);
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

export interface ThumbnailResult {
  destPath: string;
  error: string | null;
  /** True when an existing valid derivative was reused without regeneration. */
  reused?: boolean;
}

export interface ThumbnailCacheStats {
  /** Valid, durable WebP bytes only. Locks and partial outputs are excluded. */
  bytes: number;
  files: number;
  /** Valid thumbnails are all rebuildable and therefore reclaimable. */
  reclaimableBytes: number;
  incompleteFiles: number;
  incompleteBytes: number;
}

function isIncompleteThumbnailName(name: string): boolean {
  return name.endsWith(".lock") || name.endsWith(".tmp.webp") || name.endsWith(".frame.png");
}

function isStalePartialName(name: string): boolean {
  return name.endsWith(".tmp.webp") || name.endsWith(".frame.png");
}

/** Derive the final WebP destination name from a known temporary output name. */
function thumbnailDestinationNameForPartial(name: string): string | null {
  if (name.endsWith(".frame.png")) {
    return `${name.slice(0, -".frame.png".length)}.webp`;
  }
  const match = name.match(/^(.+\.webp)\.\d+\.\d+\.\d+\.tmp\.webp$/);
  return match?.[1] ?? null;
}

/**
 * Remove old temporary outputs only while holding the destination's publisher
 * lock. A crashed process may leave a lock behind; it is preserved rather than
 * risking deletion of a live worker's partial output.
 */
export async function cleanStaleThumbnailPartials(
  nasPath: string,
  olderThanMs = INCOMPLETE_FILE_RETENTION_MS,
): Promise<{ files: number; bytes: number }> {
  const dir = getExistingThumbnailDir(nasPath);
  if (!dir) return { files: 0, bytes: 0 };

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return { files: 0, bytes: 0 };
  }

  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !isStalePartialName(entry.name)) continue;
    const destinationName = thumbnailDestinationNameForPartial(entry.name);
    if (!destinationName) continue;
    const destPath = path.join(dir, destinationName);
    const lockPath = `${destPath}.lock`;

    // Fast path for an active publisher. If a publisher races this check,
    // acquireThumbnailLock below serializes cleanup with that writer.
    try {
      await fs.promises.lstat(lockPath);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
    }

    let releaseLock: (() => void) | null = null;
    try {
      releaseLock = await acquireThumbnailLock(destPath);
    } catch {
      continue;
    }

    try {
      const currentDir = getExistingThumbnailDir(nasPath);
      if (!currentDir || path.resolve(currentDir) !== path.resolve(dir)) continue;
      const filePath = path.join(dir, entry.name);
      const stat = await fs.promises.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (Date.now() - stat.mtimeMs < olderThanMs) continue;
      await fs.promises.unlink(filePath);
      files++;
      bytes += stat.size;
    } catch {
      // The worker may have completed or replaced its partial while we waited.
    } finally {
      releaseLock?.();
    }
  }

  return { files, bytes };
}

export function getThumbnailCacheStats(nasPath: string): ThumbnailCacheStats {
  const dir = getExistingThumbnailDir(nasPath);
  if (!dir) {
    return { bytes: 0, files: 0, reclaimableBytes: 0, incompleteFiles: 0, incompleteBytes: 0 };
  }
  let bytes = 0;
  let files = 0;
  let incompleteFiles = 0;
  let incompleteBytes = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const filePath = path.join(dir, entry.name);
      let size = 0;
      try { size = fs.statSync(filePath).size; } catch { continue; }
      if (isIncompleteThumbnailName(entry.name)) {
        incompleteFiles++;
        incompleteBytes += size;
      } else if (entry.name.endsWith(".webp") && isThumbnailFileValid(filePath)) {
        files++;
        bytes += size;
      }
    }
  } catch { /* report the bounded portion that was measurable */ }
  return {
    bytes,
    files,
    reclaimableBytes: bytes,
    incompleteFiles,
    incompleteBytes,
  };
}

/**
 * Keep the rebuildable thumbnail cache bounded on the NAS. Oldest valid
 * thumbnails are evicted first; the just-published thumbnail is protected so a
 * request never deletes the result it is about to serve.
 */
export async function enforceThumbnailCacheQuota(
  nasPath: string,
  maxBytes = THUMBNAIL_CACHE_MAX_BYTES,
  protectedPath?: string,
): Promise<ThumbnailCacheStats> {
  const dir = getExistingThumbnailDir(nasPath);
  if (!dir) return getThumbnailCacheStats(nasPath);

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return getThumbnailCacheStats(nasPath);
  }

  const protectedResolved = protectedPath ? path.resolve(protectedPath) : null;
  const candidates: Array<{
    filePath: string;
    size: number;
    mtimeMs: number;
    ino: number;
    dev: number;
  }> = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".webp")) continue;
    const filePath = path.join(dir, entry.name);
    if (protectedResolved && path.resolve(filePath) === protectedResolved) continue;
    try {
      const stat = await fs.promises.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || !isThumbnailFileValid(filePath)) continue;
      candidates.push({
        filePath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ino: stat.ino,
        dev: stat.dev,
      });
    } catch {
      // Entries can disappear while another process is reconciling the cache.
    }
  }

  let current = getThumbnailCacheStats(nasPath).bytes;
  if (current > maxBytes) {
    candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const candidate of candidates) {
      if (current <= maxBytes) break;
      const lockPath = `${candidate.filePath}.lock`;
      try {
        await fs.promises.lstat(lockPath);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
      }

      let releaseLock: (() => void) | null = null;
      try {
        releaseLock = await acquireThumbnailLock(candidate.filePath);
      } catch {
        continue;
      }

      try {
        const currentDir = getExistingThumbnailDir(nasPath);
        if (!currentDir || path.resolve(currentDir) !== path.resolve(dir)) break;
        const stat = await fs.promises.lstat(candidate.filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          current = getThumbnailCacheStats(nasPath).bytes;
          continue;
        }
        if (
          stat.ino !== candidate.ino ||
          stat.dev !== candidate.dev ||
          stat.size !== candidate.size ||
          stat.mtimeMs !== candidate.mtimeMs
        ) {
          current = getThumbnailCacheStats(nasPath).bytes;
          continue;
        }
        if (!isThumbnailFileValid(candidate.filePath)) {
          current = getThumbnailCacheStats(nasPath).bytes;
          continue;
        }
        await fs.promises.unlink(candidate.filePath);
        current = Math.max(0, current - stat.size);
      } catch {
        // Quota enforcement is best-effort; a busy or unsafe entry is retained.
        try {
          current = getThumbnailCacheStats(nasPath).bytes;
        } catch {
          break;
        }
      } finally {
        releaseLock?.();
      }
    }
  }

  return getThumbnailCacheStats(nasPath);
}

export async function generateThumbnail(
  mediaFileId: number,
  sourcePath: string,
  extension: string,
  nasPath: string,
  quality?: string | null,
  onReady?: (thumbnail: { destPath: string; reused: boolean }) => Promise<void>,
): Promise<ThumbnailResult> {
  const thumbDir = ensureThumbnailDir(nasPath);
  await cleanStaleThumbnailPartials(nasPath);
  const destPath = path.join(thumbDir, thumbnailFilename(mediaFileId));

  // Hold the same destination lock through both file publication and the
  // caller's canonical catalog-pointer update. Cache clearing uses this lock
  // too, so it cannot unlink a thumbnail and then race a late DB pointer write.
  let releaseLock: (() => void) | null = null;
  try {
    releaseLock = await acquireThumbnailLock(destPath);
  } catch (err: any) {
    return { destPath: "", error: err?.message ?? "Could not lock thumbnail destination" };
  }

  const tempPath = uniqueThumbnailTempPath(destPath);
  try {
    // Re-check after acquiring the lock: another process may have published it.
    if (isThumbnailFileValid(destPath)) {
      await onReady?.({ destPath, reused: true });
      return { destPath, error: null, reused: true };
    }
    try { fs.rmSync(destPath, { force: true }); } catch { /* regenerate below */ }

    const preset = qualityPreset(quality);
    const ext = extension.toLowerCase().replace(/^\\./, "");
    let error: string | null = null;

    if (IMAGE_EXTS.has(ext)) {
      error = await generateImageThumbnail(sourcePath, tempPath, preset.sizePx, preset.quality);
      // Fallback: if sharp fails (missing native libs, HEIC without libheif,
      // AVIF, or another platform binding issue), try ffmpeg.
      if (error) {
        const sharpError = error;
        const ffmpegError = await generateImageThumbnailFfmpeg(sourcePath, tempPath, preset.sizePx);
        if (!ffmpegError && isThumbnailFileValid(tempPath)) error = null;
        if (error) error = `sharp: ${sharpError}; ffmpeg: ${ffmpegError ?? "unknown"}`;
      }
    } else if (VIDEO_EXTS.has(ext)) {
      error = await generateVideoThumbnail(sourcePath, tempPath, preset.sizePx);
    } else if (ext === "pdf") {
      error = await generatePdfThumbnail(sourcePath, tempPath, preset.sizePx);
    } else {
      error = `Unsupported extension: ${ext}`;
    }

    if (error) return { destPath: "", error };
    publishThumbnail(tempPath, destPath);
    await onReady?.({ destPath, reused: false });

    // Do not hold this destination lock while quota eviction acquires locks
    // for older thumbnails; that could deadlock concurrent publishers.
    releaseLock?.();
    releaseLock = null;
    await enforceThumbnailCacheQuota(nasPath, THUMBNAIL_CACHE_MAX_BYTES, destPath);
    return { destPath, error: null, reused: false };
  } catch (err: any) {
    return { destPath: "", error: err?.message ?? "Thumbnail publication failed" };
  } finally {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* best effort */ }
    releaseLock?.();
  }
}

// ── Cache stats ───────────────────────────────────────────────────────────────

export function getThumbnailCacheSizeBytes(nasPath: string): number {
  return getThumbnailCacheStats(nasPath).bytes;
}

export async function clearThumbnailCache(
  nasPath: string,
  shouldStop?: () => boolean,
): Promise<number> {
  const dir = getExistingThumbnailDir(nasPath);
  if (!dir) return 0;
  let files: string[];
  try {
    files = await fs.promises.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }

  let deleted = 0;
  for (const file of files) {
    if (shouldStop?.()) break;
    if (isIncompleteThumbnailName(file) || !file.toLowerCase().endsWith(".webp")) continue;

    const filePath = path.join(dir, file);
    // Use the same per-thumbnail inter-process lock as publishers. A directory
    // snapshot alone is insufficient: an on-demand request can publish a file
    // after readdir but before this cleanup reaches that filename.
    const releaseLock = await acquireThumbnailLock(filePath);
    try {
      if (shouldStop?.()) break;
      try {
        await fs.promises.unlink(filePath);
        deleted++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } finally {
      releaseLock();
    }
  }
  return deleted;
}
