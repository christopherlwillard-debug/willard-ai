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

// ── Skip reason (camelCase — used as dry-run API response keys) ───────────────

export type SkipReason =
  | "systemFile"
  | "hiddenFile"
  | "tempFile"
  | "sidecarFile"
  | "userIgnoredFolder"
  | "userIgnoredExtension"
  | "systemDirectory"
  | "emptyFolder";

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
//
// "WillardAI" is always excluded (the app's own data directory).
// All other categories are gated on their respective toggles when settings
// are provided.  When settings are omitted (legacy callers) the original
// default behaviour is preserved.

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

  // No settings — preserve original default behaviour (all hidden / @/#/system)
  return (
    name.startsWith(".") ||
    name.startsWith("@") ||
    name.startsWith("#") ||
    SYSTEM_DIR_NAMES.has(name)
  );
}

// ── File filter ───────────────────────────────────────────────────────────────
//
// Each category is gated on its corresponding settings toggle.
// Returns the skip reason if the file should be excluded, or null to include it.

export function checkSystemFile(
  name: string,
  ext: string,
  settings: ScannerSettings,
): SkipReason | null {
  const nameLower = name.toLowerCase();

  // Apple resource-fork sidecars (._filename) — ignoreSidecarFiles
  if (name.startsWith("._")) {
    return settings.ignoreSidecarFiles ? "sidecarFile" : null;
  }

  // Sidecar extensions (.thm, .xmp, .aae) — ignoreSidecarFiles
  if (SIDECAR_EXTS.has(ext)) {
    return settings.ignoreSidecarFiles ? "sidecarFile" : null;
  }

  // Known system metadata file names — ignoreSystemFiles
  if (SYSTEM_FILE_NAMES.has(nameLower)) {
    return settings.ignoreSystemFiles ? "systemFile" : null;
  }

  // Hidden files (dot-prefix, e.g. .gitkeep) — ignoreHiddenFiles
  if (name.startsWith(".")) {
    return settings.ignoreHiddenFiles ? "hiddenFile" : null;
  }

  // Office temp files (~$document.docx) — ignoreTempFiles
  if (name.startsWith("~$")) {
    return settings.ignoreTempFiles ? "tempFile" : null;
  }

  // Temp extensions (.tmp, .temp) — ignoreTempFiles
  if (ext === "tmp" || ext === "temp") {
    return settings.ignoreTempFiles ? "tempFile" : null;
  }

  // User-configured ignored extensions
  if (settings.ignoredExtensions.length > 0) {
    const extNorm = ext.toLowerCase().replace(/^\./, "");
    if (settings.ignoredExtensions.map((e) => e.toLowerCase().replace(/^\./, "")).includes(extNorm)) {
      return "userIgnoredExtension";
    }
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
