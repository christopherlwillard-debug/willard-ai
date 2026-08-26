import { Router, type IRouter } from "express";
import * as fs from "fs";
import * as path from "path";
import { db } from "@workspace/db";
import { appSettingsTable, archivesTable, mediaFilesTable } from "@workspace/db";
import { archiveScope, getActiveNasPath } from "../lib/archive-scope.ts";
import { and, eq, sql } from "drizzle-orm";
import { resolveLibraryPath, resolveWithinRoot } from "../lib/nas-storage";
import { aggregateFolderSizes } from "../lib/explorer-folder-sizes";
import { activeMediaCondition } from "../lib/media-scope.ts";

const router: IRouter = Router();

const ARCHIVE_EXTS = new Set(["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "cab"]);

function isArchive(filename: string): boolean {
  const ext = path.extname(filename).replace(".", "").toLowerCase();
  return ARCHIVE_EXTS.has(ext);
}

/**
 * Resolve and validate that target stays within nasRoot.
 * Returns null if the path attempts to escape the root.
 */
function safeResolve(nasRoot: string, userPath: string): string | null {
  try {
    return resolveLibraryPath(nasRoot, userPath || ".");
  } catch {
    return null;
  }
}

router.get("/explorer", async (req, res) => {
  try {
    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const nasPath = settingsRows[0]?.nasPath ?? "";

    if (!nasPath) {
      res.status(404).json({ error: "NAS path not configured" });
      return;
    }

    const relativePath = ((req.query.path as string) ?? "").replace(/\\/g, "/");
    const targetPath = safeResolve(nasPath, relativePath);

    if (!targetPath) {
      res.status(403).json({ error: "Forbidden: path is outside NAS root" });
      return;
    }

    if (!fs.existsSync(targetPath)) {
      res.status(404).json({ error: "Folder not found" });
      return;
    }

    // Secondary real-path check: targetPath now exists, so realpathSync can resolve
    // any symlinks and confirm the canonical path is still within NAS root.
    try {
      const canonicalRoot = fs.realpathSync(nasPath);
      const canonicalTarget = fs.realpathSync(targetPath);
      if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(canonicalRoot + path.sep)) {
        res.status(403).json({ error: "Forbidden: path resolves outside NAS root" });
        return;
      }
    } catch {
      res.status(403).json({ error: "Forbidden: unable to verify path safety" });
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(targetPath, { withFileTypes: true });
    } catch {
      res.status(404).json({ error: "Cannot read folder" });
      return;
    }

    // The index already contains every file's size. Fetch the aggregated sizes
    // for this folder once, rather than spawning a blocking `du` process for
    // every directory entry.
    const canonicalFolderSizes = await db.select({
      folder: sql<string>`regexp_replace(${mediaFilesTable.relativePath}, '[^/]+$', '')`,
      totalSizeBytes: sql<number>`coalesce(sum(${mediaFilesTable.sizeBytes}), 0)`,
    })
      .from(mediaFilesTable)
      .where(and(
        eq(mediaFilesTable.nasPath, nasPath),
        activeMediaCondition,
      ))
      .groupBy(sql`regexp_replace(${mediaFilesTable.relativePath}, '[^/]+$', '')`);
    const validatedFolderSizes = canonicalFolderSizes.flatMap((row) => {
      try {
        return [{ folder: resolveLibraryPath(nasPath, row.folder || "."), totalSizeBytes: row.totalSizeBytes }];
      } catch {
        // Poisoned or stale canonical rows must not influence filesystem results.
        return [];
      }
    });
    const folderSizes = aggregateFolderSizes(targetPath, validatedFolderSizes);

    const result = await Promise.all(entries.map(async (entry) => {
      let fullPath: string;
      try {
        fullPath = resolveWithinRoot(path.join(targetPath, entry.name), nasPath);
      } catch {
        // Do not stat, archive-look-up, or expose a symlink that escapes NAS.
        return null;
      }
      const isDir = entry.isDirectory();
      let sizeBytes: number | null = null;
      let modifiedAt: string | null = null;
      let fileCount: number | null = null;
      let archiveFileCount: number | null = null;
      const archive = isArchive(entry.name);

      try {
        const stat = fs.statSync(fullPath);
        modifiedAt = stat.mtime.toISOString();

        if (isDir) {
          const children = fs.readdirSync(fullPath);
          fileCount = children.length;
          sizeBytes = folderSizes.get(entry.name) ?? 0;
        } else {
          sizeBytes = stat.size;
        }
      } catch {
        // ignore stat errors
      }

      if (archive) {
        const activeNasPath = await getActiveNasPath();
        const archiveRow = activeNasPath
          ? await db.select({ containedFileCount: archivesTable.containedFileCount })
            .from(archivesTable)
            .where(and(archiveScope(activeNasPath), eq(archivesTable.path, fullPath)))
            .limit(1)
          : [];
        archiveFileCount = archiveRow[0]?.containedFileCount ?? null;
      }

      return {
        name: entry.name,
        path: path.relative(nasPath, fullPath),
        isDirectory: isDir,
        sizeBytes,
        modifiedAt,
        fileCount,
        isArchive: archive,
        archiveFileCount,
      };
    })).then((entries) => entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null));

    result.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    res.json({ path: relativePath, entries: result, totalEntries: result.length });
  } catch {
    res.status(500).json({ error: "Failed to list folder" });
  }
});

export default router;
