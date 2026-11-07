import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Return directories that are empty now or become empty after their empty
 * descendant directories are removed. Symlinks and special entries count as
 * contents and are never traversed. Enumeration/stat failures are fatal so a
 * partial scan cannot be presented as a complete result.
 *
 * Uses asynchronous filesystem calls so large libraries do not block the API
 * event loop while the directory tree is inspected.
 */
export async function findEmptyDirectories(root: string): Promise<string[]> {
  const rootPath = path.resolve(root);
  const candidates: string[] = [];

  const visit = async (directory: string): Promise<boolean> => {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    let canBecomeEmpty = true;

    for (const entry of entries) {
      const childPath = path.join(directory, entry.name);
      const info = await fs.promises.lstat(childPath);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        canBecomeEmpty = false;
        continue;
      }
      if (!await visit(childPath)) canBecomeEmpty = false;
    }

    if (directory !== rootPath && canBecomeEmpty) candidates.push(directory);
    return canBecomeEmpty;
  };

  await visit(rootPath);
  return candidates;
}
