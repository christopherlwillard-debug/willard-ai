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


export type MissingMediaSoftDeleteResult = "marked_deleted" | "reappeared" | "record_changed";

/**
 * Recheck a previously missing path immediately before the catalog transition.
 * Only ENOENT/ENOTDIR may authorize a reversible DELETED marker; any present,
 * symlinked, non-regular, or unreadable path is left untouched.
 *
 * The callback must perform a conditional database update (id + library +
 * relative path + active-row predicate). Keeping this transition reversible
 * lets the normal scanner's unique-path upsert reactivate the same row if the
 * source returns, without discarding its derived metadata.
 */
export async function softDeleteMissingMediaRecord(
  filePath: string,
  markDeleted: () => Promise<boolean>,
): Promise<MissingMediaSoftDeleteResult> {
  if (!isMissingRegularMediaFile(filePath)) return "reappeared";
  return (await markDeleted()) ? "marked_deleted" : "record_changed";
}
