import * as fs from "fs";
import * as path from "path";
import { db } from "@workspace/db";
import { mediaFilesTable, mediaScanJobsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getWillardAIDir } from "./nas-storage";

// ── Media type classification ─────────────────────────────────────────────────

const PHOTO_EXTS = new Set([
  "jpg", "jpeg", "png", "webp", "heic", "heif", "avif", "tiff", "tif",
  "bmp", "gif", "raw", "arw", "cr2", "cr3", "nef", "orf", "rw2", "dng",
  "psd", "svg", "ico",
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
    if (entry.name.startsWith(".")) continue;
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

          // Check if already indexed with same size + modifiedAt (incremental)
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
            await db.insert(mediaFilesTable).values({
              nasPath,
              relativePath,
              name:      f.name,
              extension: f.ext,
              mimeType,
              mediaType,
              sizeBytes:  f.sizeBytes,
              modifiedAt: f.modifiedAt,
            }).onConflictDoUpdate({
              target: [mediaFilesTable.nasPath, mediaFilesTable.relativePath],
              set: {
                name:       f.name,
                extension:  f.ext,
                mimeType,
                mediaType,
                sizeBytes:  f.sizeBytes,
                modifiedAt: f.modifiedAt,
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
