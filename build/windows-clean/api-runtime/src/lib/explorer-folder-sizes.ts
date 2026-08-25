import * as path from "path";

/**
 * Collapse indexed folder totals into the immediate children of targetPath.
 * Each indexed row represents one physical folder and already contains the
 * sum of its files, so descendants are added once while walking upward.
 */
export function aggregateFolderSizes(
  targetPath: string,
  rows: Array<{ folder: string; totalSizeBytes: number | string | null }>,
): Map<string, number> {
  const folderSizes = new Map<string, number>();
  for (const row of rows) {
    const relativeFolder = path.relative(targetPath, row.folder);
    if (!relativeFolder || relativeFolder.startsWith("..") || path.isAbsolute(relativeFolder)) continue;
    const topLevelFolder = relativeFolder.split(/[\\/]/, 1)[0];
    if (!topLevelFolder) continue;
    const size = Number(row.totalSizeBytes ?? 0);
    if (!Number.isFinite(size)) continue;
    folderSizes.set(topLevelFolder, (folderSizes.get(topLevelFolder) ?? 0) + size);
  }
  return folderSizes;
}