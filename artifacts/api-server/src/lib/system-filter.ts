import * as path from "path";

export interface ScannerSettings {
  ignoredFolders:    string[];
  ignoredExtensions: string[];
  ignoreHiddenFiles:  boolean;
  ignoreSystemFiles:  boolean;
  ignoreTempFiles:    boolean;
  ignoreSidecarFiles: boolean;
  ignoreEmptyFolders: boolean;
  followSymlinks:     boolean;
}

export const DEFAULT_SCANNER_SETTINGS: ScannerSettings = {
  ignoredFolders:    [],
  ignoredExtensions: [],
  ignoreHiddenFiles:  true,
  ignoreSystemFiles:  true,
  ignoreTempFiles:    true,
  ignoreSidecarFiles: true,
  ignoreEmptyFolders: false,
  followSymlinks:     false,
};

const BUILT_IN_SKIP_NAMES = new Set([
  "thumbs.db", "thumbs.db:encryptable", "ehthumbs.db", "ehthumbs_vista.db",
  "desktop.ini", "autorun.inf",
  ".ds_store", ".localized", ".appledouble", ".appledesktop",
]);

const BUILT_IN_SKIP_EXTS = new Set([
  "thm",
]);

const SYSTEM_DIR_NAMES = new Set([
  "WillardAI",
  "$RECYCLE.BIN", "System Volume Information", "RECYCLER", "Recycle Bin",
  "@eaDir", "@Recycle", "@SynoEAStream", "@SynoThumbs",
  "#recycle", "#snapshot",
  ".Spotlight-V100", ".Trashes", ".fseventsd",
  "lost+found", "__pycache__",
]);

export function isSystemDir(name: string): boolean {
  return (
    name.startsWith(".") ||
    name.startsWith("@") ||
    name.startsWith("#") ||
    SYSTEM_DIR_NAMES.has(name)
  );
}

export type SkipReason =
  | "system_file"
  | "hidden_file"
  | "temp_file"
  | "sidecar_file"
  | "user_ignored_folder"
  | "user_ignored_extension"
  | "system_directory";

export function checkSystemFile(
  name: string,
  ext: string,
  settings: ScannerSettings,
): SkipReason | null {
  const nameLower = name.toLowerCase();

  if (BUILT_IN_SKIP_NAMES.has(nameLower)) return "system_file";

  if (name.startsWith("._")) return "system_file";

  if (BUILT_IN_SKIP_EXTS.has(ext)) return "sidecar_file";

  if (settings.ignoreHiddenFiles && name.startsWith(".")) return "hidden_file";

  if (settings.ignoreSystemFiles && name.startsWith("~$")) return "system_file";

  if (settings.ignoreTempFiles && (ext === "tmp" || ext === "temp")) return "temp_file";

  if (settings.ignoredExtensions.length > 0 && settings.ignoredExtensions.includes(ext)) {
    return "user_ignored_extension";
  }

  return null;
}

export function isSystemFile(name: string, ext: string, settings: ScannerSettings): boolean {
  return checkSystemFile(name, ext, settings) !== null;
}

export function isInIgnoredFolder(
  relPath: string,
  ignoredFolders: string[],
): boolean {
  if (ignoredFolders.length === 0) return false;
  const normalRel = relPath.replace(/\\/g, "/");
  for (const folder of ignoredFolders) {
    const normalFolder = folder.replace(/\\/g, "/").replace(/\/$/, "");
    if (normalRel === normalFolder || normalRel.startsWith(normalFolder + "/")) return true;
  }
  return false;
}

export function getRelativeFolder(fullPath: string, nasRoot: string): string {
  return path.relative(nasRoot, path.dirname(fullPath)).replace(/\\/g, "/");
}
