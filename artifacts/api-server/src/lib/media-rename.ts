import { existsSync } from "node:fs";

/** Find a sibling that would collide on common case-insensitive, Unicode-normalizing filesystems. */
export function findPortableNameCollision(
  existingNames: readonly string[],
  requestedName: string,
  currentName?: string,
): string | null {
  const key = (value: string) => value.normalize("NFC").toLowerCase();
  const requestedKey = key(requestedName);
  return existingNames.find((name) => name !== currentName && key(name) === requestedKey) ?? null;
}

export class MediaRenameConflictError extends Error {
  constructor() {
    super("Media record changed before the rename could be committed");
    this.name = "MediaRenameConflictError";
  }
}

/**
 * Keep the filesystem and catalog in sync when a rename cannot be committed.
 * The filesystem move is reversed if persistence fails; if reversal also
 * fails, preserve both errors so the caller can surface the recovery problem.
 */
export async function renameFileWithPersistence<T>(
  sourcePath: string,
  destinationPath: string,
  persist: () => Promise<T | undefined>,
  renameFile: (from: string, to: string) => void,
): Promise<T> {
  renameFile(sourcePath, destinationPath);
  try {
    const result = await persist();
    if (result === undefined) throw new MediaRenameConflictError();
    return result;
  } catch (error) {
    // Never overwrite a new file that another process may have created at
    // the original path while the catalog update was in flight.
    if (existsSync(sourcePath)) {
      throw new AggregateError(
        [error, new Error("The original media path is occupied; rollback was not allowed to overwrite it.")],
        "Media rename persistence failed and the original path is now occupied",
      );
    }
    try {
      renameFile(destinationPath, sourcePath);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Media rename persistence failed and the original filename could not be restored",
      );
    }
    throw error;
  }
}


/**
 * Validate a single filename for libraries that may be moved between
 * Windows, macOS, and Linux. Windows reserves device names even when an
 * extension is present, and silently normalizes trailing dots/spaces.
 */
export function isPortableMediaFileName(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) return false;
  if (value === "." || value === "..") return false;
  if (/[\u0000-\u001f<>:"/\\|?*]/u.test(value) || /[. ]$/u.test(value)) return false;

  const deviceBaseName = value.split(".", 1)[0]!.replace(/[. ]+$/u, "");
  return !/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/iu.test(deviceBaseName);
}
