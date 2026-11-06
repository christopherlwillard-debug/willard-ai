export type MediaType = "photo" | "video" | "audio" | "document" | "other";

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

/** Classify a file extension using the same catalog rules for every workflow. */
export function classifyMediaType(ext: string): MediaType {
  const lower = ext.toLowerCase().replace(/^\\./, "");
  if (PHOTO_EXTS.has(lower)) return "photo";
  if (VIDEO_EXTS.has(lower)) return "video";
  if (AUDIO_EXTS.has(lower)) return "audio";
  if (DOCUMENT_EXTS.has(lower)) return "document";
  return "other";
}
