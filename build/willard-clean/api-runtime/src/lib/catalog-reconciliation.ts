import * as path from "path";
import * as fs from "fs";
import { db } from "@workspace/db";
import { appSettingsTable, indexedFilesTable, mediaFilesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { resolveLibraryPath } from "./nas-storage";

export type CatalogReconciliationReport = {
  scanned: number;
  inserted: number;
  alreadyCanonical: number;
  rejected: number;
  conflicts: Array<{ legacyId: number; path: string; reason: string }>;
};

const MEDIA_TYPE: Record<string, string> = {
  image: "photo",
  video: "video",
  document: "document",
  audio: "audio",
  archive: "archive",
  code: "other",
  other: "other",
};

/**
 * Copy safe legacy rows into media_files without changing or moving user files.
 * Invalid, stale, and ambiguous rows remain in indexed_files and are reported.
 */
export async function reconcileLegacyCatalog(): Promise<CatalogReconciliationReport> {
  const [settings] = await db.select({ nasPath: appSettingsTable.nasPath })
    .from(appSettingsTable).limit(1);
  const nasPath = settings?.nasPath?.trim();
  if (!nasPath) throw new Error("No library location configured");

  const legacyRows = await db.select().from(indexedFilesTable);
  const report: CatalogReconciliationReport = {
    scanned: legacyRows.length,
    inserted: 0,
    alreadyCanonical: 0,
    rejected: 0,
    conflicts: [],
  };

  for (const legacy of legacyRows) {
    let relativePath: string;
    try {
      const safePath = resolveLibraryPath(nasPath, path.relative(nasPath, legacy.path));
      relativePath = path.relative(resolveLibraryPath(nasPath, "."), safePath).split(path.sep).join("/");
      if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        throw new Error("path is outside the active library");
      }
    } catch (error) {
      report.rejected++;
      report.conflicts.push({ legacyId: legacy.id, path: legacy.path, reason: error instanceof Error ? error.message : "unsafe path" });
      continue;
    }

    const [existing] = await db.select({
      id: mediaFilesTable.id,
      contentHash: mediaFilesTable.contentHash,
      sizeBytes: mediaFilesTable.sizeBytes,
    }).from(mediaFilesTable).where(and(
      eq(mediaFilesTable.nasPath, nasPath),
      eq(mediaFilesTable.relativePath, relativePath),
    )).limit(1);

    if (existing) {
      if ((legacy.contentHash && existing.contentHash && legacy.contentHash !== existing.contentHash)
        || Number(existing.sizeBytes) !== Number(legacy.sizeBytes)) {
        report.conflicts.push({ legacyId: legacy.id, path: legacy.path, reason: "canonical row differs in hash or size" });
      } else {
        report.alreadyCanonical++;
      }
      continue;
    }

    // Existence is informational only; stale rows are reported and never
    // rewritten into the canonical catalog because they cannot be trusted.
    if (!fs.existsSync(resolveLibraryPath(nasPath, relativePath))) {
      report.rejected++;
      report.conflicts.push({ legacyId: legacy.id, path: legacy.path, reason: "file is stale or missing on disk" });
      continue;
    }

    await db.insert(mediaFilesTable).values({
      nasPath,
      relativePath,
      name: legacy.filename,
      extension: legacy.extension,
      mimeType: "",
      mediaType: MEDIA_TYPE[legacy.fileType] ?? "other",
      sizeBytes: legacy.sizeBytes,
      modifiedAt: legacy.modifiedAt,
      contentHash: legacy.contentHash,
      indexedAt: legacy.indexedAt,
    });
    report.inserted++;
  }

  return report;
}