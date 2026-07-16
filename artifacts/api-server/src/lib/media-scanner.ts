import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { db } from "@workspace/db";
import { mediaFilesTable, mediaScanJobsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getWillardAIDir } from "./nas-storage";
import { getThumbnailDir, thumbnailFilename } from "./thumbnail-engine";

// ── Media type classification ─────────────────────────────────────────────────

const PHOTO_EXTS = new Set([
  "jpg", "jpeg", "png", "webp", "heic", "heif", "avif", "tiff", "tif",
  "bmp", "gif", "raw", "arw", "cr2", "cr3", "nef", "orf", "rw2", "dng",
  "raf", "psd", "svg", "ico",
]);
const VIDEO_EXTS = new Set([
  "mp4", "mov", "avi", "mkv", "webm", "m4v", "wmv", "flv", "3gp",
  "ts", "mts", "m2ts", "mpeg", "mpg", "mxf", "vob",
]);
const AUDIO_EXTS = new Set([
  "mp3", "flac", "wav", "aac", "ogg", "m4a", "wma", "opus", "aiff",
]);
const DOCUMENT_EXTS = new Set([
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

// ── Metadata extraction ────────────────────────────────────────────────────────

const SHARP_EXTS = new Set([
  "jpg", "jpeg", "png", "webp", "heic", "heif", "avif", "tiff", "tif", "gif", "bmp",
]);

// EXIF-capable photo extensions (exifr handles these natively)
const EXIF_EXTS = new Set([
  "jpg", "jpeg", "heic", "heif", "tiff", "tif",
  "arw", "cr2", "cr3", "nef", "orf", "rw2", "dng", "raf", "raw",
  "png", "webp",
]);

interface PhotoMeta {
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

async function extractPhotoMeta(fullPath: string, ext: string): Promise<PhotoMeta> {
  const result: PhotoMeta = {
    width: null, height: null, orientation: null,
    dateTaken: null, cameraMake: null, cameraModel: null,
    lens: null, iso: null, aperture: null, exposure: null,
    focalLength: null, flash: null, colorProfile: null,
    gpsLatitude: null, gpsLongitude: null, exifJson: null,
  };

  // Get dimensions via sharp for supported formats
  if (SHARP_EXTS.has(ext)) {
    try {
      const sharp = (await import("sharp")).default;
      const meta = await sharp(fullPath, { failOn: "none" }).metadata();
      result.width  = meta.width  ?? null;
      result.height = meta.height ?? null;
    } catch {
      // ignore
    }
  }

  // Get EXIF via exifr for supported formats
  if (EXIF_EXTS.has(ext)) {
    try {
      const exifr = (await import("exifr")).default;
      const exif = await exifr.parse(fullPath, {
        tiff: true, xmp: true, icc: true, iptc: false,
        gps: true, sanitize: true, reviveValues: true,
      });

      if (exif) {
        result.exifJson = exif as Record<string, unknown>;

        // Date taken — try multiple EXIF fields
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

        // Exposure time as fraction string e.g. "1/250"
        const exp = exif.ExposureTime;
        if (typeof exp === "number" && exp > 0) {
          result.exposure = exp >= 1 ? `${exp}s` : `1/${Math.round(1 / exp)}s`;
        }

        // Flash
        if (exif.Flash !== undefined && exif.Flash !== null) {
          result.flash = String(exif.Flash);
        }

        // GPS
        if (typeof exif.latitude === "number" && typeof exif.longitude === "number") {
          result.gpsLatitude  = exif.latitude;
          result.gpsLongitude = exif.longitude;
        }

        // Dimensions from EXIF if sharp didn't get them
        if (result.width === null)  result.width  = numOrNull(exif.ExifImageWidth  ?? exif.ImageWidth);
        if (result.height === null) result.height = numOrNull(exif.ExifImageHeight ?? exif.ImageHeight);
      }
    } catch {
      // Non-fatal — partial metadata is fine
    }
  }

  return result;
}

function strOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function numOrNull(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

// ── Video metadata ─────────────────────────────────────────────────────────────

const VIDEO_META_EXTS = new Set([
  "mp4", "mov", "avi", "mkv", "webm", "m4v", "wmv", "flv", "3gp",
  "ts", "mts", "m2ts", "mpeg", "mpg",
]);

interface VideoMeta {
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  videoCodec: string | null;
  videoBitrate: number | null;
  fps: number | null;
  audioCodec: string | null;
  dateCreated: Date | null;
}

function extractVideoMeta(fullPath: string): VideoMeta {
  const result = spawnSync("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_streams",
    "-show_format",
    fullPath,
  ], { encoding: "utf8", timeout: 15000 });

  if (result.status !== 0 || !result.stdout) {
    return { width: null, height: null, durationSeconds: null, videoCodec: null, videoBitrate: null, fps: null, audioCodec: null, dateCreated: null };
  }
  try {
    const json = JSON.parse(result.stdout);
    const videoStream = (json.streams ?? []).find((s: any) => s.codec_type === "video");
    const audioStream = (json.streams ?? []).find((s: any) => s.codec_type === "audio");
    const duration = parseFloat(json.format?.duration ?? "0") || null;

    // FPS from avg_frame_rate e.g. "30000/1001"
    let fps: number | null = null;
    const fpsRaw: string = videoStream?.avg_frame_rate ?? "";
    if (fpsRaw && fpsRaw !== "0/0") {
      const [num, den] = fpsRaw.split("/").map(Number);
      if (den && den !== 0) fps = Math.round((num / den) * 100) / 100;
    }

    // Date created from format tags
    const creationRaw = json.format?.tags?.creation_time;
    let dateCreated: Date | null = null;
    if (creationRaw) {
      const d = new Date(creationRaw);
      if (!isNaN(d.getTime())) dateCreated = d;
    }

    return {
      width:           videoStream?.width  ?? null,
      height:          videoStream?.height ?? null,
      durationSeconds: duration,
      videoCodec:      videoStream?.codec_name ?? null,
      videoBitrate:    json.format?.bit_rate ? Math.round(Number(json.format.bit_rate) / 1000) : null,
      fps,
      audioCodec:      audioStream?.codec_name ?? null,
      dateCreated,
    };
  } catch {
    return { width: null, height: null, durationSeconds: null, videoCodec: null, videoBitrate: null, fps: null, audioCodec: null, dateCreated: null };
  }
}

// ── PDF metadata ───────────────────────────────────────────────────────────────

interface PdfMeta {
  pageCount: number | null;
  pdfAuthor: string | null;
  pdfTitle: string | null;
  pdfSubject: string | null;
  pdfKeywords: string | null;
}

async function extractPdfMeta(fullPath: string): Promise<PdfMeta> {
  try {
    // Use pdfjs-dist (already available as a transitive dep of pdf-parse)
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
      pageCount:   numPages || null,
      pdfAuthor:   strOrNull(info.Author),
      pdfTitle:    strOrNull(info.Title),
      pdfSubject:  strOrNull(info.Subject),
      pdfKeywords: strOrNull(info.Keywords),
    };
  } catch {
    return { pageCount: null, pdfAuthor: null, pdfTitle: null, pdfSubject: null, pdfKeywords: null };
  }
}

// ── System/NAS directories to skip ────────────────────────────────────────────

const SYSTEM_DIR_NAMES = new Set([
  // Windows
  "$RECYCLE.BIN", "System Volume Information", "RECYCLER", "Recycle Bin",
  // Synology
  "@eaDir", "@Recycle", "@SynoEAStream", "@SynoThumbs",
  // QNAP
  "#recycle", "#snapshot",
  // macOS
  ".Spotlight-V100", ".Trashes", ".fseventsd",
  // Other common system dirs
  "lost+found", "__pycache__",
]);

function isSystemDir(name: string): boolean {
  return name.startsWith(".") || name.startsWith("@") || name.startsWith("#") || SYSTEM_DIR_NAMES.has(name);
}

// ── Directory walker ───────────────────────────────────────────────────────────

function walkNas(
  dir: string,
  skipDirs: Set<string>,
  results: Array<{ fullPath: string; name: string; ext: string; sizeBytes: number; modifiedAt: Date }>,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (isSystemDir(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(path.resolve(fullPath))) continue;
      walkNas(fullPath, skipDirs, results);
    } else if (entry.isFile()) {
      try {
        const stat = fs.statSync(fullPath);
        const ext = path.extname(entry.name).replace(/^\./, "").toLowerCase();
        results.push({
          fullPath,
          name: entry.name,
          ext,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime,
        });
      } catch {
        // Skip unreadable files
      }
    }
  }
}

// ── Running job guard ──────────────────────────────────────────────────────────

let activeScanJobId: number | null = null;

export function getActiveScanJobId(): number | null {
  return activeScanJobId;
}

// ── Main scan function (runs in background) ───────────────────────────────────

export async function runMediaScan(nasPath: string): Promise<number> {
  if (activeScanJobId !== null) {
    return activeScanJobId;
  }

  const [job] = await db.insert(mediaScanJobsTable).values({
    nasPath,
    status: "running",
  }).returning();
  activeScanJobId = job.id;

  // Run async without blocking
  void (async () => {
    try {
      const willardDir = path.resolve(getWillardAIDir(nasPath));
      const skipDirs = new Set([willardDir]);

      // Collect all files
      const files: Array<{ fullPath: string; name: string; ext: string; sizeBytes: number; modifiedAt: Date }> = [];
      walkNas(path.resolve(nasPath), skipDirs, files);

      await db.update(mediaScanJobsTable)
        .set({ totalFiles: files.length })
        .where(eq(mediaScanJobsTable.id, job.id));

      let indexed = 0;
      let skipped = 0;
      const BATCH = 50;

      for (let i = 0; i < files.length; i += BATCH) {
        const batch = files.slice(i, i + BATCH);

        for (const f of batch) {
          const relativePath = path.relative(nasPath, f.fullPath).replace(/\\/g, "/");
          const mediaType    = classifyMediaType(f.ext);
          const mimeType     = guessMimeType(f.ext);

          // Check if already indexed with same size + modifiedAt (skip if unchanged)
          const [existing] = await db
            .select({ id: mediaFilesTable.id, sizeBytes: mediaFilesTable.sizeBytes, modifiedAt: mediaFilesTable.modifiedAt })
            .from(mediaFilesTable)
            .where(and(
              eq(mediaFilesTable.nasPath, nasPath),
              eq(mediaFilesTable.relativePath, relativePath),
            ))
            .limit(1);

          if (
            existing &&
            existing.sizeBytes === f.sizeBytes &&
            existing.modifiedAt?.getTime() === f.modifiedAt.getTime()
          ) {
            skipped++;
          } else {
            // File is new or changed — delete stale thumbnail so it regenerates
            if (existing) {
              const thumbDir = getThumbnailDir(nasPath);
              const oldThumb = path.join(thumbDir, thumbnailFilename(existing.id));
              try { fs.unlinkSync(oldThumb); } catch { /* already gone */ }
            }

            // ── Extract metadata based on media type ──────────────────────────

            let width:           number | null = null;
            let height:          number | null = null;
            let orientation:     number | null = null;
            let durationSeconds: number | null = null;
            let dateTaken:       Date   | null = null;
            let cameraMake:      string | null = null;
            let cameraModel:     string | null = null;
            let lens:            string | null = null;
            let iso:             number | null = null;
            let aperture:        number | null = null;
            let exposure:        string | null = null;
            let focalLength:     number | null = null;
            let flash:           string | null = null;
            let colorProfile:    string | null = null;
            let gpsLatitude:     number | null = null;
            let gpsLongitude:    number | null = null;
            let exifJson:        Record<string, unknown> | null = null;
            let videoCodec:      string | null = null;
            let videoBitrate:    number | null = null;
            let fps:             number | null = null;
            let audioCodec:      string | null = null;
            let dateCreated:     Date   | null = null;
            let pageCount:       number | null = null;
            let pdfAuthor:       string | null = null;
            let pdfTitle:        string | null = null;
            let pdfSubject:      string | null = null;
            let pdfKeywords:     string | null = null;

            if (mediaType === "photo") {
              const meta = await extractPhotoMeta(f.fullPath, f.ext);
              width        = meta.width;
              height       = meta.height;
              orientation  = meta.orientation;
              dateTaken    = meta.dateTaken;
              cameraMake   = meta.cameraMake;
              cameraModel  = meta.cameraModel;
              lens         = meta.lens;
              iso          = meta.iso;
              aperture     = meta.aperture;
              exposure     = meta.exposure;
              focalLength  = meta.focalLength;
              flash        = meta.flash;
              colorProfile = meta.colorProfile;
              gpsLatitude  = meta.gpsLatitude;
              gpsLongitude = meta.gpsLongitude;
              exifJson     = meta.exifJson;
            } else if (VIDEO_META_EXTS.has(f.ext)) {
              const meta = extractVideoMeta(f.fullPath);
              width           = meta.width;
              height          = meta.height;
              durationSeconds = meta.durationSeconds;
              videoCodec      = meta.videoCodec;
              videoBitrate    = meta.videoBitrate;
              fps             = meta.fps;
              audioCodec      = meta.audioCodec;
              dateCreated     = meta.dateCreated;
            } else if (f.ext === "pdf") {
              const meta = await extractPdfMeta(f.fullPath);
              pageCount   = meta.pageCount;
              pdfAuthor   = meta.pdfAuthor;
              pdfTitle    = meta.pdfTitle;
              pdfSubject  = meta.pdfSubject;
              pdfKeywords = meta.pdfKeywords;
            }

            await db.insert(mediaFilesTable).values({
              nasPath,
              relativePath,
              name:      f.name,
              extension: f.ext,
              mimeType,
              mediaType,
              sizeBytes:  f.sizeBytes,
              modifiedAt: f.modifiedAt,
              width,
              height,
              orientation,
              durationSeconds,
              dateTaken,
              cameraMake,
              cameraModel,
              lens,
              iso,
              aperture,
              exposure,
              focalLength,
              flash,
              colorProfile,
              gpsLatitude,
              gpsLongitude,
              exifJson,
              videoCodec,
              videoBitrate,
              fps,
              audioCodec,
              dateCreated,
              pageCount,
              pdfAuthor,
              pdfTitle,
              pdfSubject,
              pdfKeywords,
            }).onConflictDoUpdate({
              target: [mediaFilesTable.nasPath, mediaFilesTable.relativePath],
              set: {
                name:       f.name,
                extension:  f.ext,
                mimeType,
                mediaType,
                sizeBytes:  f.sizeBytes,
                modifiedAt: f.modifiedAt,
                width,
                height,
                orientation,
                durationSeconds,
                dateTaken,
                cameraMake,
                cameraModel,
                lens,
                iso,
                aperture,
                exposure,
                focalLength,
                flash,
                colorProfile,
                gpsLatitude,
                gpsLongitude,
                exifJson,
                videoCodec,
                videoBitrate,
                fps,
                audioCodec,
                dateCreated,
                pageCount,
                pdfAuthor,
                pdfTitle,
                pdfSubject,
                pdfKeywords,
                thumbnailPath:        null,
                thumbnailGeneratedAt: null,
                indexedAt:  new Date(),
              },
            });
            indexed++;
          }
        }

        // Update progress every batch
        await db.update(mediaScanJobsTable)
          .set({ indexedFiles: indexed, skippedFiles: skipped })
          .where(eq(mediaScanJobsTable.id, job.id));
      }

      await db.update(mediaScanJobsTable)
        .set({ status: "done", indexedFiles: indexed, skippedFiles: skipped, finishedAt: new Date() })
        .where(eq(mediaScanJobsTable.id, job.id));

      // Keep collections in sync with the freshly indexed library — newly
      // indexed files flow into matching auto albums without user action.
      const { rebuildAutoCollections } = await import("./collections-engine");
      rebuildAutoCollections(nasPath).catch(() => {});
    } catch (err: any) {
      await db.update(mediaScanJobsTable)
        .set({ status: "failed", error: err?.message ?? "Unknown error", finishedAt: new Date() })
        .where(eq(mediaScanJobsTable.id, job.id))
        .catch(() => {});
    } finally {
      activeScanJobId = null;
    }
  })();

  return job.id;
}
