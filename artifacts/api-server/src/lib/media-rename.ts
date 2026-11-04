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
