import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { spawnSync } from "child_process";

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
}

export async function extractPhotoMeta(fullPath: string, ext: string): Promise<PhotoMeta> {
  const result: PhotoMeta = {
    width: null, height: null, orientation: null,
    dateTaken: null, cameraMake: null, cameraModel: null,
    lens: null, iso: null, aperture: null, exposure: null,
    focalLength: null, flash: null, colorProfile: null,
    gpsLatitude: null, gpsLongitude: null, exifJson: null,
  };

  if (SHARP_EXTS.has(ext)) {
    try {
      const sharp = (await import("sharp")).default;
      const meta = await sharp(fullPath, { failOn: "none" }).metadata();
      result.width  = meta.width  ?? null;
      result.height = meta.height ?? null;
    } catch { /* ignore */ }
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
}

const EMPTY_VIDEO_META: VideoMeta = {
  width: null, height: null, durationSeconds: null,
  videoCodec: null, videoBitrate: null, fps: null, audioCodec: null, dateCreated: null,
};

export function extractVideoMeta(fullPath: string): VideoMeta {
  const result = spawnSync("ffprobe", [
    "-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", fullPath,
  ], { encoding: "utf8", timeout: 15000 });

  if (result.status !== 0 || !result.stdout) return { ...EMPTY_VIDEO_META };
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
    };
  } catch {
    return { ...EMPTY_VIDEO_META };
  }
}

// ── PDF metadata (pdfjs-dist) ─────────────────────────────────────────────────

export interface PdfMeta {
  pageCount: number | null;
  pdfAuthor: string | null;
  pdfTitle: string | null;
  pdfSubject: string | null;
  pdfKeywords: string | null;
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
    };
  } catch {
    return { pageCount: null, pdfAuthor: null, pdfTitle: null, pdfSubject: null, pdfKeywords: null };
  }
}

// ── System/NAS directory exclusion ────────────────────────────────────────────

const SYSTEM_DIR_NAMES = new Set([
  "$RECYCLE.BIN", "System Volume Information", "RECYCLER", "Recycle Bin",
  "@eaDir", "@Recycle", "@SynoEAStream", "@SynoThumbs",
  "#recycle", "#snapshot",
  ".Spotlight-V100", ".Trashes", ".fseventsd",
  "lost+found", "__pycache__",
]);

export function isSystemDir(name: string): boolean {
  return name.startsWith(".") || name.startsWith("@") || name.startsWith("#") || SYSTEM_DIR_NAMES.has(name);
}

// ── File entry (result of walking) ────────────────────────────────────────────

export interface FileEntry {
  fullPath:   string;
  name:       string;
  ext:        string;
  sizeBytes:  number;
  modifiedAt: Date;
}

// ── NAS walker ────────────────────────────────────────────────────────────────

export function walkNas(
  dir: string,
  skipDirs: Set<string>,
  results: FileEntry[],
  onDir?: (dir: string) => void,
): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }

  for (const entry of entries) {
    if (isSystemDir(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(path.resolve(fullPath))) continue;
      onDir?.(fullPath);
      walkNas(fullPath, skipDirs, results, onDir);
    } else if (entry.isFile()) {
      try {
        const stat = fs.statSync(fullPath);
        const ext = path.extname(entry.name).replace(/^\./, "").toLowerCase();
        results.push({ fullPath, name: entry.name, ext, sizeBytes: stat.size, modifiedAt: stat.mtime });
      } catch { /* skip unreadable */ }
    }
  }
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
