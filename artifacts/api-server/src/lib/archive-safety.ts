import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { assertWithinRoot } from "./nas-storage.ts";

/**
 * These limits are deliberately finite even though the NAS may be large.
 * Archive extraction is an interactive operation and must not turn a small
 * downloaded archive into an unbounded memory, disk, or metadata workload.
 */
export const ARCHIVE_LIMITS = Object.freeze({
  maxEntries: 100_000,
  maxEntryBytes: 8 * 1024 ** 3,
  maxTotalBytes: 64 * 1024 ** 3,
  maxPathLength: 4_096,
  maxPathDepth: 64,
  maxArchiveBytes: 128 * 1024 ** 3,
  maxBufferedZipBytes: 1 * 1024 ** 3,
  maxBufferedZipEntryBytes: 512 * 1024 ** 2,
});

export class ArchiveSafetyError extends Error {
  readonly code = "ARCHIVE_SAFETY_LIMIT";

  constructor(message: string) {
    super(message);
    this.name = "ArchiveSafetyError";
  }
}

export interface ArchiveBudget {
  entryCount: number;
  totalBytes: number;
  paths: Set<string>;
}

export interface ArchiveEntryMetadata {
  path: string;
  sizeBytes?: number | string | null;
  isDirectory?: boolean;
}

export function createArchiveBudget(): ArchiveBudget {
  return { entryCount: 0, totalBytes: 0, paths: new Set<string>() };
}

function entrySize(sizeBytes: ArchiveEntryMetadata["sizeBytes"]): number {
  if (sizeBytes === undefined || sizeBytes === null || sizeBytes === "") return 0;
  const size = typeof sizeBytes === "number" ? sizeBytes : Number(sizeBytes);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new ArchiveSafetyError(`Archive entry has an invalid size: ${String(sizeBytes)}`);
  }
  return size;
}

/**
 * Validate raw archive names before any archive library is allowed to
 * normalize them. In particular, path.isAbsolute alone is insufficient on
 * Linux because it does not recognize Windows drive and UNC paths.
 */
export function validateArchiveEntry(
  entry: ArchiveEntryMetadata,
  budget: ArchiveBudget,
): { normalizedPath: string; sizeBytes: number; isDirectory: boolean } {
  const rawPath = entry.path;
  if (typeof rawPath !== "string" || rawPath.includes("\0")) {
    throw new ArchiveSafetyError(`Archive traversal rejected: invalid entry path`);
  }

  const normalizedPath = rawPath.replace(/\\/g, "/");
  const canonicalPath = path.posix.normalize(normalizedPath)
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "") || ".";
  const isDirectory = entry.isDirectory === true;
  if (normalizedPath.length > ARCHIVE_LIMITS.maxPathLength) {
    throw new ArchiveSafetyError(
      `Archive entry path exceeds the ${ARCHIVE_LIMITS.maxPathLength}-character limit`,
    );
  }
  if (
    path.isAbsolute(rawPath) ||
    path.isAbsolute(normalizedPath) ||
    /^[A-Za-z]:[\\/]/.test(rawPath) ||
    normalizedPath.startsWith("//")
  ) {
    throw new ArchiveSafetyError(`Archive traversal rejected: absolute path in entry "${rawPath}"`);
  }

  const components = normalizedPath.split("/");
  if (components.some(component => component === "..")) {
    throw new ArchiveSafetyError(
      `Archive traversal rejected: ".." traversal component in entry "${rawPath}"`,
    );
  }
  const depth = components.filter(component => component !== "" && component !== ".").length;
  if (depth > ARCHIVE_LIMITS.maxPathDepth) {
    throw new ArchiveSafetyError(
      `Archive entry path exceeds the ${ARCHIVE_LIMITS.maxPathDepth}-level depth limit`,
    );
  }

  const sizeBytes = entrySize(entry.sizeBytes);
  if (budget.paths.has(canonicalPath)) {
    throw new ArchiveSafetyError(`Archive contains duplicate entry path "${rawPath}"`);
  }
  budget.paths.add(canonicalPath);
  budget.entryCount++;
  if (budget.entryCount > ARCHIVE_LIMITS.maxEntries) {
    throw new ArchiveSafetyError(
      `Archive contains more than ${ARCHIVE_LIMITS.maxEntries.toLocaleString()} entries`,
    );
  }
  if (!isDirectory) {
    if (sizeBytes > ARCHIVE_LIMITS.maxEntryBytes) {
      throw new ArchiveSafetyError(
        `Archive entry "${rawPath}" exceeds the ${formatBytes(ARCHIVE_LIMITS.maxEntryBytes)} per-file limit`,
      );
    }
    budget.totalBytes += sizeBytes;
    if (budget.totalBytes > ARCHIVE_LIMITS.maxTotalBytes) {
      throw new ArchiveSafetyError(
        `Archive expansion exceeds the ${formatBytes(ARCHIVE_LIMITS.maxTotalBytes)} total limit`,
      );
    }
  }

  return { normalizedPath: canonicalPath, sizeBytes, isDirectory };
}

export function assertArchiveFileWithinLimit(archivePath: string): fs.Stats {
  const stat = fs.lstatSync(archivePath);
  if (!stat.isFile()) throw new ArchiveSafetyError("Archive source is not a regular file");
  if (stat.size > ARCHIVE_LIMITS.maxArchiveBytes) {
    throw new ArchiveSafetyError(
      `Archive source exceeds the ${formatBytes(ARCHIVE_LIMITS.maxArchiveBytes)} input limit`,
    );
  }
  return stat;
}

export function assertBufferedZipFile(archivePath: string): fs.Stats {
  const stat = assertArchiveFileWithinLimit(archivePath);
  if (stat.size > ARCHIVE_LIMITS.maxBufferedZipBytes) {
    throw new ArchiveSafetyError(
      `ZIP source exceeds the ${formatBytes(ARCHIVE_LIMITS.maxBufferedZipBytes)} buffered-input limit`,
    );
  }
  return stat;
}

export interface ArchiveFileSnapshot {
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

export function snapshotArchiveFile(archivePath: string): ArchiveFileSnapshot {
  const stat = assertArchiveFileWithinLimit(archivePath);
  return { size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino };
}

/**
 * A TOC check and an extraction are separate operations in all supported
 * archive libraries. Refuse to use the result if the source was replaced or
 * changed between those operations.
 */
export function assertArchiveFileUnchanged(
  archivePath: string,
  snapshot: ArchiveFileSnapshot,
): void {
  const current = assertArchiveFileWithinLimit(archivePath);
  if (
    current.size !== snapshot.size ||
    current.mtimeMs !== snapshot.mtimeMs ||
    (snapshot.dev !== 0 && current.dev !== snapshot.dev) ||
    (snapshot.ino !== 0 && current.ino !== snapshot.ino)
  ) {
    throw new ArchiveSafetyError("Archive changed while it was being inspected; retry the operation");
  }
}

function assertDirectoryComponent(current: string): void {
  const stat = fs.lstatSync(current);
  if (stat.isSymbolicLink()) {
    throw new ArchiveSafetyError(`Archive output path contains a symlink: "${current}"`);
  }
  if (!stat.isDirectory()) {
    throw new ArchiveSafetyError(`Archive output path is not a directory: "${current}"`);
  }
}

/**
 * Create output directories one component at a time and reject symlinks.
 * Recursive mkdir by itself follows a symlinked parent.
 */
export function ensureSafeDirectory(root: string, directory: string): void {
  try {
    assertWithinRoot(directory, root);
  } catch (error) {
    throw new ArchiveSafetyError(error instanceof Error ? error.message : String(error));
  }
  const resolvedRoot = path.resolve(root);
  const resolvedDirectory = path.resolve(directory);
  let relative = path.relative(resolvedRoot, resolvedDirectory);
  assertDirectoryComponent(resolvedRoot);
  if (!relative || relative === ".") return;

  let current = resolvedRoot;
  for (const component of relative.split(path.sep)) {
    if (!component || component === ".") continue;
    current = path.join(current, component);
    try {
      assertDirectoryComponent(current);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      fs.mkdirSync(current, { mode: 0o700 });
      assertDirectoryComponent(current);
    }
  }
}

export function assertSafeOutputFile(root: string, outputPath: string): void {
  // Inspect the final component before canonicalizing the path. A symlink
  // here should be reported as an output race, not merely as a generic
  // outside-root traversal.
  try {
    const stat = fs.lstatSync(outputPath);
    if (stat.isSymbolicLink()) {
      throw new ArchiveSafetyError(`Archive output path is a symlink: "${outputPath}"`);
    }
    if (!stat.isFile()) {
      throw new ArchiveSafetyError(`Archive output path is not a regular file: "${outputPath}"`);
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    assertWithinRoot(outputPath, root);
  } catch (error) {
    throw new ArchiveSafetyError(error instanceof Error ? error.message : String(error));
  }
  const parent = path.dirname(outputPath);
  ensureSafeDirectory(root, parent);
}

/**
 * Publish an extracted ZIP entry without writing through an existing
 * symlink. The temporary file is unique and atomically renamed into place.
 */
export function writeArchiveFileAtomically(
  root: string,
  outputPath: string,
  data: Uint8Array,
): void {
  assertSafeOutputFile(root, outputPath);
  const directory = path.dirname(outputPath);
  const temporaryPath = path.join(
    directory,
    `.willard-extract-${crypto.randomUUID()}.tmp`,
  );
  const noFollow = (fs.constants as any).O_NOFOLLOW ?? 0;
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    assertSafeOutputFile(root, outputPath);
    fs.renameSync(temporaryPath, outputPath);
    assertSafeOutputFile(root, outputPath);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* best effort */ }
  }
}

export interface ExtractedTreeSummary {
  files: Array<{ relativePath: string; sizeBytes: number; fullPath: string }>;
  totalBytes: number;
}

/**
 * Validate every path actually created by a third-party extractor. This
 * catches unexpected files, symlinked directories, and extractor races before
 * the organize pipeline reads or moves anything.
 */
export function inspectExtractedTree(root: string): ExtractedTreeSummary {
  assertDirectoryComponent(path.resolve(root));
  const budget = createArchiveBudget();
  const files: ExtractedTreeSummary["files"] = [];

  function visit(directory: string): void {
    for (const name of fs.readdirSync(directory)) {
      const fullPath = path.join(directory, name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        throw new ArchiveSafetyError(`Archive extraction produced a symlink: "${fullPath}"`);
      }
      if (stat.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!stat.isFile()) {
        throw new ArchiveSafetyError(`Archive extraction produced a non-regular file: "${fullPath}"`);
      }
      const relativePath = path.relative(root, fullPath);
      validateArchiveEntry({ path: relativePath, sizeBytes: stat.size }, budget);
      files.push({ relativePath, sizeBytes: stat.size, fullPath });
    }
  }

  visit(path.resolve(root));
  return { files, totalBytes: budget.totalBytes };
}

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  return `${gib >= 1 ? gib.toFixed(gib % 1 === 0 ? 0 : 1) : Math.round(bytes / 1024 ** 2)} ${gib >= 1 ? "GiB" : "MiB"}`;
}