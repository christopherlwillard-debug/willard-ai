import * as fs from "node:fs";

export function isMissingFilesystemEntry(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * A health cleanup may remove an index row only when the media path is
 * positively confirmed missing. Permission, I/O, symlink, and special-entry
 * conditions must abort inspection rather than masquerade as missing media.
 */
export function isMissingRegularMediaFile(filePath: string): boolean {
  try {
    const info = fs.lstatSync(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("Media path is not a regular non-symlink file; refusing orphan cleanup.");
    }
    return false;
  } catch (error) {
    if (isMissingFilesystemEntry(error)) return true;
    throw error;
  }
}
