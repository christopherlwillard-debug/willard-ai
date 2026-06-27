import { Router, type IRouter } from "express";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { db } from "@workspace/db";
import { appSettingsTable, archivesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

function getFolderSizeBytes(folderPath: string): number | null {
  // Use du with array args (no shell interpolation) for safe folder size computation
  const result = spawnSync("du", ["-sb", folderPath], { timeout: 3000, stdio: ["pipe", "pipe", "pipe"] });
  if (result.status !== 0 || !result.stdout) return null;
  const first = result.stdout.toString().trim().split(/\s+/)[0];
  const bytes = parseInt(first, 10);
  return isNaN(bytes) ? null : bytes;
}

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
  const resolved = path.resolve(nasRoot, userPath);
  const root = path.resolve(nasRoot);
  // Ensure resolved path starts with root + path separator (or equals root)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return null;
  }
  return resolved;
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
      res.status(400).json({ error: "Invalid path: outside NAS root" });
      return;
    }

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
        modifiedAt = stat.mtime.toISOString();

        if (isDir) {
          const children = fs.readdirSync(fullPath);
          fileCount = children.length;
          sizeBytes = getFolderSizeBytes(fullPath);
        } else {
          sizeBytes = stat.size;
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
