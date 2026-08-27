import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const LIBRARY_IDENTITY_FORMAT = "willard-library-identity";
export const LIBRARY_IDENTITY_VERSION = 1;
export const LIBRARY_IDENTITY_RELATIVE_PATH = path.join("WillardAI", "config", "library-identity.json");

export function normalizeLibraryRoot(value) {
  const raw = String(value);
  if (/^[A-Za-z]:[\\/]/.test(raw) || /^\\\\[^\\]+\\[^\\]+/.test(raw)) {
    return path.win32.resolve(raw);
  }
  return path.resolve(raw);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function identityPath(libraryRoot) {
  return path.join(normalizeLibraryRoot(libraryRoot), LIBRARY_IDENTITY_RELATIVE_PATH);
}

function validateIdentity(identity) {
  if (
    !identity ||
    identity.format !== LIBRARY_IDENTITY_FORMAT ||
    identity.version !== LIBRARY_IDENTITY_VERSION ||
    typeof identity.libraryId !== "string" ||
    !/^[0-9a-f-]{16,80}$/i.test(identity.libraryId) ||
    typeof identity.createdAt !== "string" ||
    Number.isNaN(Date.parse(identity.createdAt))
  ) {
    throw new Error("The NAS library identity marker is missing or invalid.");
  }
  return identity;
}

export async function readLibraryIdentity(libraryRoot) {
  const markerPath = identityPath(libraryRoot);
  const bytes = await readFile(markerPath);
  const identity = validateIdentity(JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")));
  return {
    ...identity,
    root: normalizeLibraryRoot(libraryRoot),
    markerPath,
    markerSha256: sha256(bytes),
  };
}

export async function ensureLibraryIdentity(libraryRoot) {
  const root = normalizeLibraryRoot(libraryRoot);
  try {
    return await readLibraryIdentity(root);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const markerPath = identityPath(root);
  const identity = {
    format: LIBRARY_IDENTITY_FORMAT,
    version: LIBRARY_IDENTITY_VERSION,
    libraryId: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const temporary = `${markerPath}.${process.pid}.${randomUUID()}.partial`;
  await mkdir(path.dirname(markerPath), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await rename(temporary, markerPath);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return readLibraryIdentity(root);
}

export function validateRecoveryAttachment(backupLibrary, targetLibrary) {
  if (!backupLibrary) return null;
  if (!targetLibrary) {
    throw new Error(
      "Recovery requires --library-root so the restored database can be matched to a NAS library identity.",
    );
  }
  if (backupLibrary.libraryId !== targetLibrary.libraryId) {
    throw new Error(
      `Recovery refused: NAS library identity ${targetLibrary.libraryId} does not match the backup identity ${backupLibrary.libraryId}.`,
    );
  }
  if (backupLibrary.markerSha256 && backupLibrary.markerSha256 !== targetLibrary.markerSha256) {
    throw new Error("Recovery refused: the NAS library identity marker does not match the authenticated backup.");
  }
  return targetLibrary;
}

export function buildPathRemapPlan(sourceRoot, targetRoot) {
  const source = normalizeLibraryRoot(sourceRoot);
  const target = normalizeLibraryRoot(targetRoot);
  if (!source || !target) throw new Error("Recovery path remapping requires both source and target roots.");
  return { source, target, changed: source !== target };
}

export const DURABLE_PATH_COLUMNS = Object.freeze([
  ["app_settings", "nas_path", "exact"],
  ["app_settings", "photos_destination", "prefix"],
  ["app_settings", "videos_destination", "prefix"],
  ["app_settings", "documents_destination", "prefix"],
  ["app_settings", "other_files_destination", "prefix"],
  ["archives", "nas_path", "exact"],
  ["archives", "path", "prefix"],
  ["archives", "folder", "prefix"],
  ["collections", "nas_path", "exact"],
  ["conversion_jobs", "nas_path", "exact"],
  ["conversion_jobs", "backup_dir", "prefix"],
  ["indexed_files", "path", "prefix"],
  ["indexed_files", "folder", "prefix"],
  ["library_activity", "nas_path", "exact"],
  ["library_jobs", "nas_path", "exact"],
  ["library_jobs", "root_path", "prefix"],
  ["media_files", "nas_path", "exact"],
  ["media_files", "thumbnail_path", "prefix"],
  ["organization_jobs", "nas_path", "exact"],
  ["organization_jobs", "source_path", "prefix"],
  ["organization_jobs", "report_path", "prefix"],
  ["people", "nas_path", "exact"],
  ["media_tags", "nas_path", "exact"],
  ["cleanup_operations", "nas_path", "exact"],
  ["cleanup_operations", "source_path", "prefix"],
  ["cleanup_operations", "trash_path", "prefix"],
]);

export const DURABLE_JSON_COLUMNS = Object.freeze([
  ["conversion_jobs", "result_json"],
  ["library_jobs", "summary"],
  ["library_jobs", "diagnostics"],
  ["organization_jobs", "plan_json"],
  ["organization_jobs", "preflight_json"],
  ["organization_jobs", "file_moves"],
  ["organization_jobs", "report_json"],
]);

export { identityPath, sha256, validateIdentity };