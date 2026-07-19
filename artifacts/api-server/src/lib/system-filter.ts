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

// ── Canonical skip reason codes ───────────────────────────────────────────────
// These five codes are used in skipped-files logging and the dry-run API.
// Temp files, sidecar files, and empty dirs are folded into system_file /
// system_directory to keep the external API surface stable and minimal.

export type SkipReason =
  | "system_file"         // metadata/temp/sidecar files excluded by system rules
  | "hidden_file"         // dot-prefix files when ignoreHiddenFiles is on
  | "user_ignored_folder" // user-configured folder exclusion
  | "user_ignored_extension" // user-configured extension exclusion
  | "system_directory";   // system/hidden directories (including empty dirs)

// ── File-name / extension sets ────────────────────────────────────────────────

// System metadata files — skipped when ignoreSystemFiles is enabled
const SYSTEM_FILE_NAMES = new Set([
  "thumbs.db", "thumbs.db:encryptable", "ehthumbs.db", "ehthumbs_vista.db",
  "desktop.ini", "autorun.inf",
  ".ds_store", ".localized", ".appledouble", ".appledesktop",
]);

// Sidecar extensions — skipped when ignoreSidecarFiles is enabled
const SIDECAR_EXTS = new Set([
  "thm",  // Canon video thumbnail sidecar
  "xmp",  // Adobe metadata sidecar
  "aae",  // Apple photo edit sidecar
]);

// ── Directory filter ──────────────────────────────────────────────────────────
// "WillardAI" is always excluded (the app's own data directory).
// All other categories are gated on their respective toggles when settings
// are provided.  When settings are omitted (legacy callers) original default
// behaviour is preserved: all hidden/@/# dirs and SYSTEM_DIR_NAMES are skipped.

const ALWAYS_SKIP_DIR_NAMES = new Set(["WillardAI"]);

const SYSTEM_DIR_NAMES = new Set([
  "$RECYCLE.BIN", "System Volume Information", "RECYCLER", "Recycle Bin",
  "@eaDir", "@Recycle", "@SynoEAStream", "@SynoThumbs",
  "#recycle", "#snapshot",
  ".Spotlight-V100", ".Trashes", ".fseventsd",
  "lost+found", "__pycache__",
]);

export function isSystemDir(name: string, settings?: ScannerSettings): boolean {
  if (ALWAYS_SKIP_DIR_NAMES.has(name)) return true;

  if (settings) {
    if (settings.ignoreHiddenFiles && name.startsWith(".")) return true;
    if (settings.ignoreSystemFiles && (
      name.startsWith("@") || name.startsWith("#") || SYSTEM_DIR_NAMES.has(name)
    )) return true;
    return false;
  }

  // No settings — preserve original default behaviour
  return (
    name.startsWith(".") ||
    name.startsWith("@") ||
    name.startsWith("#") ||
    SYSTEM_DIR_NAMES.has(name)
  );
}

// ── File filter ───────────────────────────────────────────────────────────────
// Returns the canonical skip reason if the file should be excluded, or null.
// Each category is gated on its corresponding settings toggle.

export function checkSystemFile(
  name: string,
  ext: string,
  settings: ScannerSettings,
): SkipReason | null {
  const nameLower = name.toLowerCase();

  // Apple resource-fork sidecars (._filename) — ignoreSidecarFiles → system_file
  if (name.startsWith("._")) {
    return settings.ignoreSidecarFiles ? "system_file" : null;
  }

  // Sidecar extensions (.thm, .xmp, .aae) — ignoreSidecarFiles → system_file
  if (SIDECAR_EXTS.has(ext)) {
    return settings.ignoreSidecarFiles ? "system_file" : null;
  }

  // Known system metadata file names — ignoreSystemFiles → system_file
  if (SYSTEM_FILE_NAMES.has(nameLower)) {
    return settings.ignoreSystemFiles ? "system_file" : null;
  }

  // Hidden files (dot-prefix) — ignoreHiddenFiles → hidden_file
  if (name.startsWith(".")) {
    return settings.ignoreHiddenFiles ? "hidden_file" : null;
  }

  // Office temp files (~$document.docx) — ignoreTempFiles → system_file
  if (name.startsWith("~$")) {
    return settings.ignoreTempFiles ? "system_file" : null;
  }

  // Temp extensions (.tmp, .temp) — ignoreTempFiles → system_file
  if (ext === "tmp" || ext === "temp") {
    return settings.ignoreTempFiles ? "system_file" : null;
  }

  // User-configured ignored extensions
  if (settings.ignoredExtensions.length > 0) {
    const extNorm = ext.toLowerCase().replace(/^\./, "");
    const userExts = settings.ignoredExtensions.map((e) => e.toLowerCase().replace(/^\./, ""));
    if (userExts.includes(extNorm)) return "user_ignored_extension";
  }

  return null;
}

export function isSystemFile(name: string, ext: string, settings: ScannerSettings): boolean {
  return checkSystemFile(name, ext, settings) !== null;
}

// ── Relative-path folder check ────────────────────────────────────────────────

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
