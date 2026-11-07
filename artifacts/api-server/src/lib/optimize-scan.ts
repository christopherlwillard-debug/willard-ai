import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDirectoryWithinRoot } from "./nas-storage.ts";

export interface OptimizeScanCounter {
  total: number;
  limitReached: boolean;
}

export interface OptimizeSampleFile {
  path: string;
  sizeBytes: number;
}

export interface OptimizeExtGroup {
  count: number;
  bytes: number;
  samples: OptimizeSampleFile[];
  paths: string[];
}

export interface OptimizeConversionFile {
  fullPath: string;
  ext: string;
  sizeBytes: number;
}

function filesystemError(error: unknown): string {
  const detail = error as NodeJS.ErrnoException;
  return detail.code ?? detail.message ?? String(error);
}

type OptimizeScanCacheOptions = {
  expectedVersion: number;
  ttlMs: number;
  profile?: string;
  rawConversionEnabled?: boolean;
  now?: number;
};

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.isFile() && right.isFile() &&
    (left.dev === 0 || right.dev === 0 || left.dev === right.dev) &&
    (left.ino === 0 || right.ino === 0 || left.ino === right.ino) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

/**
 * Read the best-effort scan cache only from a regular file below the active
 * library. O_NOFOLLOW prevents the final path component from being followed
 * where the platform supports it; descriptor/path identity checks cover the
 * open and read boundaries on all supported platforms.
 */
export async function readOptimizeScanCache(
  cachePath: string,
  libraryRoot: string,
  options: OptimizeScanCacheOptions,
): Promise<(Record<string, unknown> & { scannedAt: string }) | null> {
  let handle: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
  try {
    const cacheDir = ensureDirectoryWithinRoot(path.dirname(cachePath), libraryRoot);
    const safeCachePath = path.join(cacheDir, path.basename(cachePath));
    const beforeOpen = await fs.promises.lstat(safeCachePath);
    if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink()) return null;

    const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    handle = await fs.promises.open(safeCachePath, fs.constants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    const afterOpen = await fs.promises.lstat(safeCachePath);
    if (!sameFileIdentity(beforeOpen, opened) || !sameFileIdentity(opened, afterOpen)) return null;

    const raw = await handle.readFile({ encoding: "utf8" });
    const afterRead = await fs.promises.lstat(safeCachePath);
    if (!sameFileIdentity(opened, afterRead)) return null;

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const data = parsed as Record<string, unknown> & { scannedAt?: unknown; cacheVersion?: unknown };
    if (data.cacheVersion !== options.expectedVersion || typeof data.scannedAt !== "string") return null;
    if (!Number.isSafeInteger(options.expectedVersion) || options.expectedVersion <= 0) return null;
    if (!Number.isFinite(options.ttlMs) || options.ttlMs < 0) return null;

    const scannedAt = Date.parse(data.scannedAt);
    const now = options.now ?? Date.now();
    if (!Number.isFinite(scannedAt) || scannedAt > now || now - scannedAt > options.ttlMs) return null;
    if (options.profile !== undefined && data.profile !== options.profile) return null;
    if (options.rawConversionEnabled !== undefined && data.rawConversionEnabled !== options.rawConversionEnabled) return null;
    return data as Record<string, unknown> & { scannedAt: string };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Publish cache data through an exclusive private temporary file in the same
 * directory. Rename replaces a final symlink itself rather than opening or
 * truncating its target. Cache failures remain non-fatal to the scan workflow.
 */
export async function writeOptimizeScanCache(
  cachePath: string,
  libraryRoot: string,
  data: Record<string, unknown>,
  cacheVersion: number,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
  let temporaryPath: string | undefined;
  try {
    const cacheDir = ensureDirectoryWithinRoot(path.dirname(cachePath), libraryRoot);
    const safeCachePath = path.join(cacheDir, path.basename(cachePath));
    temporaryPath = path.join(cacheDir, `.${path.basename(cachePath)}.${randomUUID()}.tmp`);
    handle = await fs.promises.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ ...data, cacheVersion }), { encoding: "utf8" });
    await handle.close();
    handle = undefined;

    // Revalidate every directory component immediately before publishing.
    const revalidatedCacheDir = ensureDirectoryWithinRoot(path.dirname(cachePath), libraryRoot);
    if (path.resolve(revalidatedCacheDir) !== path.resolve(cacheDir)) {
      throw new Error("Optimize scan cache directory changed during publication");
    }
    await fs.promises.rename(temporaryPath, safeCachePath);
    temporaryPath = undefined;

    const published = await fs.promises.lstat(safeCachePath);
    if (!published.isFile() || published.isSymbolicLink()) {
      throw new Error("Optimize scan cache publication did not produce a regular file");
    }
  } catch {
    // Non-fatal — cache write is best-effort.
  } finally {
    await handle?.close().catch(() => undefined);
    if (temporaryPath) await fs.promises.unlink(temporaryPath).catch(() => undefined);
  }
}

function insertSample(samples: OptimizeSampleFile[], filePath: string, size: number): void {
  samples.push({ path: filePath, sizeBytes: size });
  samples.sort((a, b) => b.sizeBytes - a.sizeBytes);
  if (samples.length > 3) samples.pop();
}

type FileVisitor = (fullPath: string) => Promise<boolean> | boolean;

/**
 * Walk a media tree without blocking the API event loop. Directory entries are
 * revalidated with lstat immediately before recursion to reject entries that
 * have already become symlinks. A false visitor result stops the whole walk.
 */
async function walkMediaDirectories(
  directory: string,
  skipDirNames: ReadonlySet<string>,
  skipPaths: ReadonlySet<string>,
  onFile: FileVisitor,
  operation: string,
): Promise<boolean> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `Unable to scan ${operation} directory "${directory}": ${filesystemError(error)}`,
      { cause: error },
    );
  }

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (skipDirNames.has(entry.name) || entry.name.startsWith(".") || skipPaths.has(path.resolve(fullPath))) {
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = await fs.promises.lstat(fullPath);
      } catch (error) {
        throw new Error(
          `Unable to inspect ${operation} directory "${fullPath}": ${filesystemError(error)}`,
          { cause: error },
        );
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`${operation} directory changed into a symlink or non-directory: "${fullPath}"`);
      }

      if (!await walkMediaDirectories(fullPath, skipDirNames, skipPaths, onFile, operation)) {
        return false;
      }
    } else if (entry.isFile()) {
      if (!await onFile(fullPath)) return false;
    }
  }

  return true;
}

/**
 * Build the optimization scan summary without treating unreadable or vanished
 * entries as if they were absent. A partial scan can understate the library
 * and produce misleading savings estimates, so directory and file inspection
 * failures abort the scan with the affected path.
 */
export async function walkForOptimize(
  dir: string,
  groups: Map<string, OptimizeExtGroup>,
  maxFiles: number,
  counter: OptimizeScanCounter,
  skipDirs: ReadonlySet<string>,
): Promise<void> {
  if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0) {
    throw new Error("Optimization scan file limit must be a positive safe integer");
  }
  if (counter.total >= maxFiles) {
    counter.limitReached = true;
    return;
  }

  await walkMediaDirectories(dir, skipDirs, new Set(), async (fullPath) => {
    const ext = path.extname(fullPath).slice(1).toLowerCase();
    if (!ext || ext.length > 10) return true;

    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(fullPath);
    } catch (error) {
      throw new Error(
        `Unable to inspect optimization file "${fullPath}": ${filesystemError(error)}`,
        { cause: error },
      );
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Optimization scan entry is no longer a regular file: "${fullPath}"`);
    }

    const current = groups.get(ext) ?? { count: 0, bytes: 0, samples: [], paths: [] };
    insertSample(current.samples, fullPath, stat.size);
    if (["jpg", "jpeg", "png", "mp4", "m4v", "mov", "mkv"].includes(ext) && current.paths.length < 5_000) {
      current.paths.push(fullPath);
    }
    groups.set(ext, {
      count: current.count + 1,
      bytes: current.bytes + stat.size,
      samples: current.samples,
      paths: current.paths,
    });
    counter.total++;
    if (counter.total >= maxFiles) {
      // Conservative by design: reaching the cap means additional entries may be omitted.
      counter.limitReached = true;
      return false;
    }
    return true;
  }, "optimization");
}

/** Collect approved conversion inputs with the same non-blocking, symlink-aware tree walk. */
export async function walkForConversion(
  dir: string,
  approvedExtSet: ReadonlySet<string>,
  results: OptimizeConversionFile[],
  skipDirNames: ReadonlySet<string>,
  skipPaths: ReadonlySet<string> = new Set(),
): Promise<void> {
  await walkMediaDirectories(dir, skipDirNames, skipPaths, async (fullPath) => {
    const ext = path.extname(fullPath).slice(1).toLowerCase();
    if (!approvedExtSet.has(ext)) return true;

    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(fullPath);
    } catch (error) {
      throw new Error(
        `Unable to inspect conversion file "${fullPath}": ${filesystemError(error)}`,
        { cause: error },
      );
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Conversion scan entry is no longer a regular file: "${fullPath}"`);
    }

    results.push({ fullPath, ext, sizeBytes: stat.size });
    return true;
  }, "conversion");
}

/** Map a collection with bounded workers while preserving input order and allSettled semantics. */
export async function mapSettledWithConcurrency<T, R>(
  items: readonly T[],
  maxConcurrent: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new Error("Concurrency limit must be a positive safe integer");
  }

  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, maxConcurrent);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await mapper(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }));
  return results;
}

/** Process-wide FIFO limiter for expensive external probes shared by concurrent scans. */
export function createConcurrencyLimiter(maxConcurrent: number): <T>(operation: () => Promise<T>) => Promise<T> {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new Error("Concurrency limit must be a positive safe integer");
  }

  let active = 0;
  const waiters: Array<() => void> = [];

  return async <T>(operation: () => Promise<T>): Promise<T> => {
    if (active >= maxConcurrent) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    } else {
      active++;
    }

    try {
      return await operation();
    } finally {
      const next = waiters.shift();
      if (next) next();
      else active--;
    }
  };
}
