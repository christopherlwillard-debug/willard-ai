import * as fs from "fs";
import * as path from "path";

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

function filesystemError(error: unknown): string {
  const detail = error as NodeJS.ErrnoException;
  return detail.code ?? detail.message ?? String(error);
}

function insertSample(samples: OptimizeSampleFile[], filePath: string, size: number): void {
  samples.push({ path: filePath, sizeBytes: size });
  samples.sort((a, b) => b.sizeBytes - a.sizeBytes);
  if (samples.length > 3) samples.pop();
}

/**
 * Build the optimization scan summary without treating unreadable or vanished
 * entries as if they were absent. A partial scan can understate the library
 * and produce misleading savings estimates, so directory and file inspection
 * failures abort the scan with the affected path.
 */
export function walkForOptimize(
  dir: string,
  groups: Map<string, OptimizeExtGroup>,
  maxFiles: number,
  counter: OptimizeScanCounter,
  skipDirs: ReadonlySet<string>,
): void {
  if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0) {
    throw new Error("Optimization scan file limit must be a positive safe integer");
  }
  if (counter.total >= maxFiles) {
    counter.limitReached = true;
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `Unable to scan optimization directory "${dir}": ${filesystemError(error)}`,
      { cause: error },
    );
  }

  for (const entry of entries) {
    if (counter.total >= maxFiles) {
    counter.limitReached = true;
    return;
  }

    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name) && !entry.name.startsWith(".")) {
        walkForOptimize(path.join(dir, entry.name), groups, maxFiles, counter, skipDirs);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      if (!ext || ext.length > 10) continue;

      const fullPath = path.join(dir, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(fullPath);
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
        return;
      }
    }
  }
}
