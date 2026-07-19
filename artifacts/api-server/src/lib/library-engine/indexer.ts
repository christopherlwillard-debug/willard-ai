import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { isSystemDir, checkSystemFile, type ScannerSettings, DEFAULT_SCANNER_SETTINGS } from "../system-filter";

export { isSystemDir };

// ── Media type classification ─────────────────────────────────────────────────

export const PHOTO_EXTS = new Set([
  "jpg", "jpeg", "png", "webp", "heic", "heif", "avif", "tiff", "tif",
  "bmp", "gif", "raw", "arw", "cr2", "cr3", "nef", "orf", "rw2", "dng",
  "raf", "psd", "svg", "ico",
]);
export const VIDEO_EXTS = new Set([
  "mp4", "mov", "avi", "mkv", "webm", "m4v", "wmv", "flv", "3gp",
  "ts", "mts", "m2ts", "mpeg", "mpg", "mxf", "vob",
]);
export const AUDIO_EXTS = new Set([
  "mp3", "flac", "wav", "aac", "ogg", "m4a", "wma", "opus", "aiff",
]);
export const DOCUMENT_EXTS = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv",
  "md", "rtf", "odt", "ods", "odp", "pages", "numbers", "key",
]);

export type MediaType = "photo" | "video" | "audio" | "document" | "other";

export function classifyMediaType(ext: string): MediaType {
  const lower = ext.toLowerCase().replace(/^\./, "");
  if (PHOTO_EXTS.has(lower))    return "photo";
  if (VIDEO_EXTS.has(lower))    return "video";
  if (AUDIO_EXTS.has(lower))    return "audio";
  if (DOCUMENT_EXTS.has(lower)) return "document";
  return "other";
}

export function guessMimeType(ext: string): string {
  const lower = ext.toLowerCase().replace(/^\./, "");
  const map: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    webp: "image/webp", heic: "image/heic", heif: "image/heif",
    avif: "image/avif", tiff: "image/tiff", tif: "image/tiff",
    gif: "image/gif", bmp: "image/bmp", svg: "image/svg+xml",
    mp4: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo",
    mkv: "video/x-matroska", webm: "video/webm", m4v: "video/mp4",
    mp3: "audio/mpeg", flac: "audio/flac", wav: "audio/wav",
    aac: "audio/aac", ogg: "audio/ogg", m4a: "audio/mp4",
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    txt: "text/plain", csv: "text/csv", md: "text/markdown",
  };
  return map[lower] ?? "application/octet-stream";
}

// ── SHA-256 hashing ───────────────────────────────────────────────────────────

export async function hashFile(fullPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const hash = createHash("sha256");
      const stream = fs.createReadStream(fullPath);
      stream.on("data", (chunk) => hash.update(chunk as Buffer));
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

// ── Fast content fingerprint ──────────────────────────────────────────────────

const FINGERPRINT_CHUNK = 64 * 1024;

export async function computeQuickFingerprint(fullPath: string, sizeBytes: number): Promise<string | null> {
  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fs.promises.open(fullPath, "r");
    const hash = createHash("sha256");
    hash.update(String(sizeBytes));
    const headLen = Math.min(FINGERPRINT_CHUNK, sizeBytes);
    if (headLen > 0) {
      const head = Buffer.alloc(headLen);
      await fd.read(head, 0, headLen, 0);
      hash.update(head);
    }
    if (sizeBytes > FINGERPRINT_CHUNK) {
      const tail = Buffer.alloc(FINGERPRINT_CHUNK);
      await fd.read(tail, 0, FINGERPRINT_CHUNK, sizeBytes - FINGERPRINT_CHUNK);
      hash.update(tail);
    }
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    await fd?.close().catch(() => {});
  }
}

// ── Index prioritization ──────────────────────────────────────────────────────

const TYPE_PRIORITY: Record<MediaType, number> = {
  photo: 0, video: 1, document: 2, audio: 3, other: 4,
};

export function sortFilesByPriority<T extends { ext: string; modifiedAt: Date; fullPath: string }>(files: T[]): T[] {
  return files.sort((a, b) => {
    const pa = TYPE_PRIORITY[classifyMediaType(a.ext)];
    const pb = TYPE_PRIORITY[classifyMediaType(b.ext)];
    if (pa !== pb) return pa - pb;
    const ta = a.modifiedAt.getTime(), tb = b.modifiedAt.getTime();
    if (ta !== tb) return tb - ta;
    return a.fullPath < b.fullPath ? -1 : a.fullPath > b.fullPath ? 1 : 0;
  });
}

// ── Photo metadata (sharp + exifr) ───────────────────────────────────────────

const SHARP_EXTS = new Set([
  "jpg", "jpeg", "png", "webp", "heic", "heif", "avif", "tiff", "tif", "gif", "bmp",
]);
const EXIF_EXTS = new Set([
  "jpg", "jpeg", "heic", "heif", "tiff", "tif",
  "arw", "cr2", "cr3", "nef", "orf", "rw2", "dng", "raf", "raw",
  "png", "webp",
]);

export interface PhotoMeta {
  width: number | null;
  height: number | null;
  orientation: number | null;
  dateTaken: Date | null;
  cameraMake: string | null;
  cameraModel: string | null;
  lens: string | null;
  iso: number | null;
  aperture: number | null;
  exposure: string | null;
  focalLength: number | null;
  flash: string | null;
  colorProfile: string | null;
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  exifJson: Record<string, unknown> | null;
  error: string | null;
}

export async function extractPhotoMeta(fullPath: string, ext: string): Promise<PhotoMeta> {
  const result: PhotoMeta = {
    width: null, height: null, orientation: null,
    dateTaken: null, cameraMake: null, cameraModel: null,
    lens: null, iso: null, aperture: null, exposure: null,
    focalLength: null, flash: null, colorProfile: null,
    gpsLatitude: null, gpsLongitude: null, exifJson: null,
    error: null,
  };

  let sharpFailed = false;
  if (SHARP_EXTS.has(ext)) {
    try {
      const sharp = (await import("sharp")).default;
      const meta = await sharp(fullPath, { failOn: "none" }).metadata();
      result.width  = meta.width  ?? null;
      result.height = meta.height ?? null;
    } catch { sharpFailed = true; }
  }

  if (EXIF_EXTS.has(ext)) {
    try {
      const exifr = (await import("exifr")).default;
      const exif = await exifr.parse(fullPath, {
        tiff: true, xmp: true, icc: true, iptc: false,
        gps: true, sanitize: true, reviveValues: true,
      });
      if (exif) {
        result.exifJson = exif as Record<string, unknown>;
        const rawDate = exif.DateTimeOriginal ?? exif.CreateDate ?? exif.DateTime;
        if (rawDate instanceof Date && !isNaN(rawDate.getTime())) {
          result.dateTaken = rawDate;
        } else if (typeof rawDate === "string") {
          const d = new Date(rawDate);
          if (!isNaN(d.getTime())) result.dateTaken = d;
        }
        result.cameraMake  = strOrNull(exif.Make);
        result.cameraModel = strOrNull(exif.Model);
        result.lens        = strOrNull(exif.LensModel ?? exif.Lens);
        result.iso         = numOrNull(exif.ISO);
        result.aperture    = numOrNull(exif.FNumber ?? exif.ApertureValue);
        result.focalLength = numOrNull(exif.FocalLength);
        result.orientation = numOrNull(exif.Orientation);
        result.colorProfile = strOrNull(exif.ProfileDescription ?? exif.ColorSpace);
        const exp = exif.ExposureTime;
        if (typeof exp === "number" && exp > 0) {
          result.exposure = exp >= 1 ? `${exp}s` : `1/${Math.round(1 / exp)}s`;
        }
        if (exif.Flash !== undefined && exif.Flash !== null) {
          result.flash = String(exif.Flash);
        }
        if (typeof exif.latitude === "number" && typeof exif.longitude === "number") {
          result.gpsLatitude  = exif.latitude;
          result.gpsLongitude = exif.longitude;
        }
        if (result.width === null)  result.width  = numOrNull(exif.ExifImageWidth  ?? exif.ImageWidth);
        if (result.height === null) result.height = numOrNull(exif.ExifImageHeight ?? exif.ImageHeight);
      }
    } catch { /* non-fatal */ }
  }

  if (sharpFailed && result.width === null && result.height === null) {
    result.error = `Corrupt or unreadable ${ext.toUpperCase()} image`;
  }

  return result;
}

// ── Video metadata (ffprobe) ──────────────────────────────────────────────────

export const VIDEO_META_EXTS = new Set([
  "mp4", "mov", "avi", "mkv", "webm", "m4v", "wmv", "flv", "3gp",
  "ts", "mts", "m2ts", "mpeg", "mpg",
]);

export interface VideoMeta {
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  videoCodec: string | null;
  videoBitrate: number | null;
  fps: number | null;
  audioCodec: string | null;
  dateCreated: Date | null;
  error: string | null;
}

const EMPTY_VIDEO_META: VideoMeta = {
  width: null, height: null, durationSeconds: null,
  videoCodec: null, videoBitrate: null, fps: null, audioCodec: null, dateCreated: null,
  error: null,
};

export function extractVideoMeta(fullPath: string): VideoMeta {
  const result = spawnSync("ffprobe", [
    "-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", fullPath,
  ], { encoding: "utf8", timeout: 15000 });

  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { ...EMPTY_VIDEO_META };
  }
  if (result.status !== 0 || !result.stdout) {
    return { ...EMPTY_VIDEO_META, error: "Unreadable video (corrupt file or unsupported codec)" };
  }
  try {
    const json = JSON.parse(result.stdout);
    const vs = (json.streams ?? []).find((s: any) => s.codec_type === "video");
    const as_ = (json.streams ?? []).find((s: any) => s.codec_type === "audio");
    const duration = parseFloat(json.format?.duration ?? "0") || null;

    let fps: number | null = null;
    const fpsRaw: string = vs?.avg_frame_rate ?? "";
    if (fpsRaw && fpsRaw !== "0/0") {
      const [num, den] = fpsRaw.split("/").map(Number);
      if (den && den !== 0) fps = Math.round((num / den) * 100) / 100;
    }

    let dateCreated: Date | null = null;
    const creationRaw = json.format?.tags?.creation_time;
    if (creationRaw) {
      const d = new Date(creationRaw);
      if (!isNaN(d.getTime())) dateCreated = d;
    }

    return {
      width: vs?.width ?? null, height: vs?.height ?? null,
      durationSeconds: duration,
      videoCodec: vs?.codec_name ?? null,
      videoBitrate: json.format?.bit_rate ? Math.round(Number(json.format.bit_rate) / 1000) : null,
      fps, audioCodec: as_?.codec_name ?? null, dateCreated,
      error: null,
    };
  } catch {
    return { ...EMPTY_VIDEO_META, error: "Unreadable video (corrupt file or unsupported codec)" };
  }
}

// ── PDF metadata (pdfjs-dist) ─────────────────────────────────────────────────

export interface PdfMeta {
  pageCount: number | null;
  pdfAuthor: string | null;
  pdfTitle: string | null;
  pdfSubject: string | null;
  pdfKeywords: string | null;
  error: string | null;
}

export async function extractPdfMeta(fullPath: string): Promise<PdfMeta> {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const buffer = fs.readFileSync(fullPath);
    const uint8 = new Uint8Array(buffer);
    const loadingTask = (pdfjsLib as any).getDocument({ data: uint8, verbosity: 0 });
    const doc = await loadingTask.promise;
    const meta = await doc.getMetadata().catch(() => null);
    const numPages: number = doc.numPages;
    await doc.destroy();
    const info = meta?.info ?? {};
    return {
      pageCount: numPages || null,
      pdfAuthor: strOrNull(info.Author), pdfTitle: strOrNull(info.Title),
      pdfSubject: strOrNull(info.Subject), pdfKeywords: strOrNull(info.Keywords),
      error: null,
    };
  } catch (err: any) {
    const isPassword = err?.name === "PasswordException" || /password/i.test(err?.message ?? "");
    return {
      pageCount: null, pdfAuthor: null, pdfTitle: null, pdfSubject: null, pdfKeywords: null,
      error: isPassword ? "Password-protected PDF" : "Corrupt or unreadable PDF",
    };
  }
}

// ── File entry (result of walking) ────────────────────────────────────────────

export interface FileEntry {
  fullPath:   string;
  name:       string;
  ext:        string;
  sizeBytes:  number;
  modifiedAt: Date;
}

// ── Directory cache entry (v2: mtime + entry count) ──────────────────────────

export interface DirCacheEntry {
  mtimeMs:    number;
  entryCount: number;
}

// ── NAS walker ────────────────────────────────────────────────────────────────
// Optional dir-mtime-cache params enable the directory short-circuit optimisation.
// scannerSettings: user-configured exclusion rules applied before stat().

export function walkNas(
  dir: string,
  skipDirs: Set<string>,
  results: FileEntry[],
  onDir?: (dir: string) => void,
  onSkip?: (fullPath: string, reason: string) => void,
  dirCacheIn?: ReadonlyMap<string, DirCacheEntry>,
  dirCacheOut?: Map<string, DirCacheEntry>,
  skippedDirs?: string[],
  nasRoot?: string,
  scannerSettings?: ScannerSettings,
): void {
  const useDirCache =
    dirCacheIn !== undefined &&
    dirCacheOut !== undefined &&
    skippedDirs !== undefined &&
    nasRoot !== undefined;

  const settings: ScannerSettings = scannerSettings ?? DEFAULT_SCANNER_SETTINGS;

  function recurse(currentDir: string): void {
    // ── User-configured ignored folder check ────────────────────────────
    if (nasRoot && settings.ignoredFolders.length > 0) {
      const relDir = path.relative(nasRoot, currentDir).replace(/\\/g, "/");
      if (relDir && relDir !== ".") {
        for (const ignored of settings.ignoredFolders) {
          const norm = ignored.replace(/\\/g, "/").replace(/\/$/, "");
          if (relDir === norm || relDir.startsWith(norm + "/")) {
            onSkip?.(currentDir, "user_ignored_folder");
            return;
          }
        }
      }
    }

    // ── Directory mtime + entry-count short-circuit ─────────────────────
    if (useDirCache) {
      const relDir = path.relative(nasRoot!, currentDir).replace(/\\/g, "/");
      if (relDir && relDir !== ".") {
        let entries: fs.Dirent[] | null = null;
        try {
          const dStat = fs.statSync(currentDir);
          const mtimeMs = dStat.mtimeMs;
          try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); }
          catch {
            onSkip?.(currentDir, "Could not read folder (permission denied or unreadable)");
            return;
          }
          const entryCount = entries.length;
          dirCacheOut!.set(relDir, { mtimeMs, entryCount });
          const cached = dirCacheIn!.get(relDir);
          if (cached !== undefined && mtimeMs === cached.mtimeMs && entryCount === cached.entryCount) {
            skippedDirs!.push(relDir);
            return;
          }
        } catch { /* fall through to normal walk */ }
        if (entries !== null) {
          for (const entry of entries) processEntry(entry, currentDir);
          return;
        }
      }
    }

    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); }
    catch {
      onSkip?.(currentDir, "Could not read folder (permission denied or unreadable)");
      return;
    }

    // Ignore empty directories when the toggle is enabled
    if (settings.ignoreEmptyFolders && entries.length === 0) {
      onSkip?.(currentDir, "system_directory");
      return;
    }

    for (const entry of entries) {
      processEntry(entry, currentDir);
    }
  }

  function processEntry(entry: fs.Dirent, currentDir: string): void {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      // isSystemDir only applies to directories (prevents misclassifying hidden files)
      if (isSystemDir(entry.name, settings)) {
        onSkip?.(fullPath, "system_directory");
        return;
      }
      if (skipDirs.has(path.resolve(fullPath))) return;
      onDir?.(fullPath);
      recurse(fullPath);
    } else if (entry.isFile() || (settings.followSymlinks && entry.isSymbolicLink())) {
      // For symlinks, resolve the target to determine whether it's a file or dir
      if (settings.followSymlinks && entry.isSymbolicLink()) {
        try {
          const target = fs.statSync(fullPath); // follows the symlink
          if (target.isDirectory()) {
            if (!skipDirs.has(path.resolve(fullPath))) {
              onDir?.(fullPath);
              recurse(fullPath);
            }
            return;
          }
          if (!target.isFile()) return; // socket, device, fifo, etc.
        } catch {
          return; // broken symlink — skip silently
        }
      }

      const ext = path.extname(entry.name).replace(/^\./, "").toLowerCase();

      // Apply system/user file filter BEFORE stat (saves NAS I/O)
      const skipReason = checkSystemFile(entry.name, ext, settings);
      if (skipReason !== null) {
        onSkip?.(fullPath, skipReason);
        return;
      }

      // Skip unclassified (non-media, non-document) files when the toggle is off
      if (!settings.indexOtherFiles && classifyMediaType(ext) === "other") {
        onSkip?.(fullPath, "other_type_excluded");
        return;
      }

      try {
        const stat = fs.statSync(fullPath);
        results.push({ fullPath, name: entry.name, ext, sizeBytes: stat.size, modifiedAt: stat.mtime });
      } catch {
        onSkip?.(fullPath, "Could not read file (permission denied or unreadable)");
      }
    }
  }

  recurse(dir);
}

// ── Priority scoring for streaming scan queue ──────────────────────────────────
// photo=0, document=1, audio=2, video=3, other=4; within each type, smaller
// files first so thumbnails appear quickly and large videos are last.

const QUEUE_TYPE_PRIORITY: Record<MediaType, number> = {
  photo: 0, document: 1, audio: 2, video: 3, other: 4,
};

function queueScore(entry: FileEntry): number {
  const t = QUEUE_TYPE_PRIORITY[classifyMediaType(entry.ext)] ?? 4;
  // type dominates; size breaks ties (cap at ~1 TB to stay in float64 precision)
  return t * 1e12 + Math.min(entry.sizeBytes, 999_999_999_999);
}

// ── ScanPriorityQueue ─────────────────────────────────────────────────────────
// Async min-heap.  push() inserts immediately; pop() awaits if empty+open.
// close() causes all pending pop() calls to return null.

export class ScanPriorityQueue {
  private heap: Array<{ entry: FileEntry; score: number }> = [];
  private waiters: Array<() => void> = [];
  private _closed = false;

  get size(): number { return this.heap.length; }
  get isClosed(): boolean { return this._closed; }

  push(entry: FileEntry): void {
    const score = queueScore(entry);
    this.heap.push({ entry, score });
    let i = this.heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.heap[p]!.score <= score) break;
      [this.heap[p], this.heap[i]] = [this.heap[i]!, this.heap[p]!];
      i = p;
    }
    if (this.waiters.length > 0) this.waiters.shift()!();
  }

  /** Returns the highest-priority entry. Waits if empty+open; returns null if closed+empty. */
  async pop(): Promise<FileEntry | null> {
    for (;;) {
      if (this.heap.length > 0) {
        const top = this.heap[0]!.entry;
        const last = this.heap.pop()!;
        if (this.heap.length > 0) {
          this.heap[0] = last;
          let i = 0;
          for (;;) {
            const l = 2 * i + 1, r = 2 * i + 2;
            let s = i;
            if (l < this.heap.length && this.heap[l]!.score < this.heap[s]!.score) s = l;
            if (r < this.heap.length && this.heap[r]!.score < this.heap[s]!.score) s = r;
            if (s === i) break;
            [this.heap[i], this.heap[s]] = [this.heap[s]!, this.heap[i]!];
            i = s;
          }
        }
        return top;
      }
      if (this._closed) return null;
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }
  }

  close(): void {
    this._closed = true;
    const ws = this.waiters.splice(0);
    for (const w of ws) w();
  }
}

// ── Async NAS walker ──────────────────────────────────────────────────────────
// Like walkNas but fully async: uses fs.promises.readdir with up to
// MAX_CONCURRENT_READDIR simultaneous directory reads.  Files are pushed to
// the ScanPriorityQueue as they are discovered so workers can start
// processing immediately — before the walk finishes.
// The caller closes the queue after resolveSkippedDirs finishes.

const MAX_CONCURRENT_READDIR = 8;

export async function walkNasAsync(
  dir: string,
  skipDirs: Set<string>,
  queue: ScanPriorityQueue,
  onFile?: (entry: FileEntry) => void,
  onDir?: (dir: string) => void,
  onSkip?: (fullPath: string, reason: string) => void,
  dirCacheIn?: ReadonlyMap<string, DirCacheEntry>,
  dirCacheOut?: Map<string, DirCacheEntry>,
  skippedDirs?: string[],
  nasRoot?: string,
  scannerSettings?: ScannerSettings,
  stopSignal?: { stop: boolean },
): Promise<void> {
  let activeReaddirs = 0;
  const readdirWaiters: Array<() => void> = [];

  const acquireReaddir = (): Promise<void> => {
    if (activeReaddirs < MAX_CONCURRENT_READDIR) { activeReaddirs++; return Promise.resolve(); }
    return new Promise(resolve => readdirWaiters.push(() => { activeReaddirs++; resolve(); }));
  };
  const releaseReaddir = (): void => {
    activeReaddirs--;
    if (readdirWaiters.length > 0) readdirWaiters.shift()!();
  };

  const useDirCache =
    dirCacheIn  !== undefined &&
    dirCacheOut !== undefined &&
    skippedDirs !== undefined &&
    nasRoot     !== undefined;

  const settings: ScannerSettings = scannerSettings ?? DEFAULT_SCANNER_SETTINGS;

  async function recurse(currentDir: string): Promise<void> {
    if (stopSignal?.stop) return;

    // User-configured ignored folder check
    if (nasRoot && settings.ignoredFolders.length > 0) {
      const relDir = path.relative(nasRoot, currentDir).replace(/\\/g, "/");
      if (relDir && relDir !== ".") {
        for (const ignored of settings.ignoredFolders) {
          const norm = ignored.replace(/\\/g, "/").replace(/\/$/, "");
          if (relDir === norm || relDir.startsWith(norm + "/")) {
            onSkip?.(currentDir, "user_ignored_folder");
            return;
          }
        }
      }
    }

    // Dir-mtime cache short-circuit (preserve exact behaviour from sync walkNas)
    if (useDirCache) {
      const relDir = path.relative(nasRoot!, currentDir).replace(/\\/g, "/");
      if (relDir && relDir !== ".") {
        let entries: fs.Dirent[] | null = null;
        try {
          const dStat  = await fs.promises.stat(currentDir);
          const mtimeMs = dStat.mtimeMs;
          await acquireReaddir();
          try { entries = await fs.promises.readdir(currentDir, { withFileTypes: true }); }
          finally { releaseReaddir(); }
          const entryCount = entries.length;
          dirCacheOut!.set(relDir, { mtimeMs, entryCount });
          const cached = dirCacheIn!.get(relDir);
          if (cached !== undefined && mtimeMs === cached.mtimeMs && entryCount === cached.entryCount) {
            skippedDirs!.push(relDir);
            return;
          }
        } catch {
          if (entries === null) {
            onSkip?.(currentDir, "Could not read folder (permission denied or unreadable)");
            return;
          }
        }
        if (entries !== null) {
          await Promise.all(entries.map(e => processEntry(e, currentDir)));
          return;
        }
      }
    }

    // Normal async readdir
    await acquireReaddir();
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch {
      releaseReaddir();
      onSkip?.(currentDir, "Could not read folder (permission denied or unreadable)");
      return;
    }
    releaseReaddir();

    if (settings.ignoreEmptyFolders && entries.length === 0) {
      onSkip?.(currentDir, "system_directory");
      return;
    }

    await Promise.all(entries.map(e => processEntry(e, currentDir)));
  }

  async function processEntry(entry: fs.Dirent, currentDir: string): Promise<void> {
    if (stopSignal?.stop) return;

    const fullPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      if (isSystemDir(entry.name, settings)) { onSkip?.(fullPath, "system_directory"); return; }
      if (skipDirs.has(path.resolve(fullPath))) return;
      onDir?.(fullPath);
      await recurse(fullPath);
    } else if (entry.isFile() || (settings.followSymlinks && entry.isSymbolicLink())) {
      if (settings.followSymlinks && entry.isSymbolicLink()) {
        try {
          const target = fs.statSync(fullPath);
          if (target.isDirectory()) {
            if (!skipDirs.has(path.resolve(fullPath))) { onDir?.(fullPath); await recurse(fullPath); }
            return;
          }
          if (!target.isFile()) return;
        } catch { return; }
      }

      const ext = path.extname(entry.name).replace(/^\./, "").toLowerCase();
      const skipReason = checkSystemFile(entry.name, ext, settings);
      if (skipReason !== null) { onSkip?.(fullPath, skipReason); return; }

      // Skip unclassified (non-media, non-document) files when the toggle is off
      if (!settings.indexOtherFiles && classifyMediaType(ext) === "other") {
        onSkip?.(fullPath, "other_type_excluded");
        return;
      }

      if (stopSignal?.stop) return;

      try {
        const stat = await fs.promises.stat(fullPath);
        const fileEntry: FileEntry = { fullPath, name: entry.name, ext, sizeBytes: stat.size, modifiedAt: stat.mtime };
        queue.push(fileEntry);
        onFile?.(fileEntry);
      } catch {
        onSkip?.(fullPath, "Could not read file (permission denied or unreadable)");
      }
    }
  }

  await recurse(dir);
}

// ── Utility ───────────────────────────────────────────────────────────────────

export function strOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

export function numOrNull(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}
