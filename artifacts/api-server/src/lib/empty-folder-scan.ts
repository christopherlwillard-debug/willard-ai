import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Return directories that are empty now or become empty after their empty
 * descendant directories are removed. Symlinks and special entries count as
 * contents and are never traversed. Enumeration/stat failures are fatal so a
 * partial scan cannot be presented as a complete result.
 */
export function findEmptyDirectories(root: string): string[] {
  const rootPath = path.resolve(root);
  const candidates: string[] = [];

  const visit = (directory: string): boolean => {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    let canBecomeEmpty = true;

    for (const entry of entries) {
      const childPath = path.join(directory, entry.name);
      const info = fs.lstatSync(childPath);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        canBecomeEmpty = false;
        continue;
      }
      if (!visit(childPath)) canBecomeEmpty = false;
    }

    if (directory !== rootPath && canBecomeEmpty) candidates.push(directory);
    return canBecomeEmpty;
  };

  visit(rootPath);
  return candidates;
}
