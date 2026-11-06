import * as fs from "node:fs";
import * as path from "node:path";

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
}

function filesystemError(error: unknown): string {
  const detail = error as NodeJS.ErrnoException;
  return detail.code ?? detail.message ?? String(error);
}

function insertSample(samples: OptimizeSampleFile[], filePath: string, size: number): void {
  samples.push({ path: filePath, sizeBytes: size });
  samples.sort((a, b) => b.sizeBytes - a.sizeBytes);
  if (samples.length > 3) samples.pop();
}

type FileVisitor = (fullPath: string) => Promise<boolean> | boolean;

/**
 * Walk a media tree without blocking the API event loop. Directory entries are
 * revalidated with lstat before recursion so a directory replaced by a symlink
 * after readdir is never followed. A false visitor result stops the whole walk.
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

    results.push({ fullPath, ext });
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
