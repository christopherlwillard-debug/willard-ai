import { classifyMediaType } from "./media-classification.ts";

export type ArchiveEntryFileType = "image" | "video" | "audio" | "document" | "archive" | "software" | "other";

const ARCHIVE_EXTS = new Set([
  "zip", "rar", "7z", "cab", "iso", "tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz",
]);
const SOFTWARE_EXTS = new Set([
  "exe", "msi", "dmg", "pkg", "deb", "rpm", "sh", "bat", "app",
]);

/** Keep archive previews aligned with the canonical media catalog classifier. */
export function getFileTypeFromName(filename: string): ArchiveEntryFileType {
  const basename = filename.split(/[\\/]/).pop() ?? filename;
  const dot = basename.lastIndexOf(".");
  const ext = dot > 0 ? basename.slice(dot + 1).toLowerCase() : "";

  if (ARCHIVE_EXTS.has(ext)) return "archive";
  if (SOFTWARE_EXTS.has(ext)) return "software";

  switch (classifyMediaType(ext)) {
    case "photo": return "image";
    case "video": return "video";
    case "audio": return "audio";
    case "document": return "document";
    default: return "other";
  }
}

export function computeCategoryFromContent(
  entries: readonly { isDirectory?: boolean; fileType?: unknown }[],
  isPasswordProtected: boolean,
): string {
  if (isPasswordProtected) return "Password Protected";
  const files = entries.filter((entry) => !entry.isDirectory);
  if (files.length === 0) return "Unknown";

  const counts: Record<ArchiveEntryFileType, number> = {
    image: 0,
    video: 0,
    audio: 0,
    document: 0,
    archive: 0,
    software: 0,
    other: 0,
  };

  for (const entry of files) {
    const candidate = typeof entry.fileType === "string" ? entry.fileType : "";
    const type: ArchiveEntryFileType = Object.prototype.hasOwnProperty.call(counts, candidate)
      ? candidate as ArchiveEntryFileType
      : "other";
    counts[type]++;
  }

  const total = files.length;
  if (counts.archive / total > 0.25) return "Nested Archives";
  if (counts.image / total > 0.55) return "Photo Archive";
  if (counts.video / total > 0.45) return "Video Archive";
  if (counts.audio / total > 0.45) return "Audio Archive";
  if (counts.document / total > 0.45) return "Document Backup";
  if (counts.software / total > 0.35) return "Software";

  const topType = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] as ArchiveEntryFileType;
  if (counts[topType] / total < 0.4) return "Mixed";
  return "General";
}
