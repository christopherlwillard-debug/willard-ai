import { Router, type IRouter } from "express";
import * as fs from "fs";
import * as path from "path";
import { db } from "@workspace/db";
import { appSettingsTable, archivesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

const ARCHIVE_EXTS = new Set(["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "cab"]);

function isArchive(filename: string): boolean {
  const ext = path.extname(filename).replace(".", "").toLowerCase();
  return ARCHIVE_EXTS.has(ext);
}

router.get("/explorer", async (req, res) => {
  try {
    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const nasPath = settingsRows[0]?.nasPath ?? "";

    if (!nasPath) {
      res.status(404).json({ error: "NAS path not configured" });
      return;
    }

    const relativePath = (req.query.path as string) ?? "";
    const targetPath = relativePath ? path.join(nasPath, relativePath) : nasPath;

    if (!fs.existsSync(targetPath)) {
      res.status(404).json({ error: "Folder not found" });
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(targetPath, { withFileTypes: true });
    } catch {
      res.status(404).json({ error: "Cannot read folder" });
      return;
    }

    const result = await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(targetPath, entry.name);
      const isDir = entry.isDirectory();
      let sizeBytes: number | null = null;
      let modifiedAt: string | null = null;
      let fileCount: number | null = null;
      let archiveFileCount: number | null = null;
      const archive = isArchive(entry.name);

      try {
        const stat = fs.statSync(fullPath);
        sizeBytes = isDir ? null : stat.size;
        modifiedAt = stat.mtime.toISOString();

        if (isDir) {
          const children = fs.readdirSync(fullPath);
          fileCount = children.length;
        }
      } catch {
        // ignore stat errors
      }

      if (archive) {
        const archiveRow = await db.select({ containedFileCount: archivesTable.containedFileCount })
          .from(archivesTable).where(eq(archivesTable.path, fullPath)).limit(1);
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
    }));

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
