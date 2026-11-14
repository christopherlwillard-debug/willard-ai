import * as fs from "node:fs";
import * as path from "node:path";

export type HealthDirectoryEntry = {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  sizeBytes?: number;
};

export type HealthWalkProgress = {
  phase: string;
  processed: number;
  total: number | null;
  message: string;
};

export type HealthWalkLimits = {
  maxEntriesPerDirectory: number;
  maxEntriesPerTree: number;
  reportEveryDirectories: number;
};

export const DEFAULT_HEALTH_WALK_LIMITS: HealthWalkLimits = {
  maxEntriesPerDirectory: 10_000,
  maxEntriesPerTree: 250_000,
  reportEveryDirectories: 100,
};

export type HealthWalkProgressReporter = (progress: HealthWalkProgress) => Promise<void>;

export async function readHealthDirectory(
  root: string,
  directory: string,
  budget: { visitedEntries: number },
  limits: HealthWalkLimits = DEFAULT_HEALTH_WALK_LIMITS,
): Promise<HealthDirectoryEntry[]> {
  const rootPath = path.resolve(root);
  const directoryPath = path.resolve(directory);
  if (directoryPath !== rootPath && !directoryPath.startsWith(rootPath + path.sep)) {
    throw new Error("Health scan refused to walk outside the configured library.");
  }
  const directoryStat = await fs.promises.lstat(directoryPath);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error("Health scan refused a symlink or non-directory path.");
  }

  const entries: HealthDirectoryEntry[] = [];
  const handle = await fs.promises.opendir(directoryPath);
  for await (const entry of handle) {
    if (entry.name === ".DS_Store" || entry.isSymbolicLink()) continue;
    budget.visitedEntries++;
    if (budget.visitedEntries > limits.maxEntriesPerTree) {
      throw new Error(`Health scan is limited to ${limits.maxEntriesPerTree.toLocaleString()} filesystem entries per tree.`);
    }
    if (entries.length >= limits.maxEntriesPerDirectory) {
      throw new Error(`Health scan is limited to ${limits.maxEntriesPerDirectory.toLocaleString()} entries in one directory.`);
    }
    if (entry.isDirectory()) {
      entries.push({ name: entry.name, isDirectory: true, isFile: false });
    } else if (entry.isFile()) {
      const fullPath = path.join(directoryPath, entry.name);
      const fileStat = await fs.promises.lstat(fullPath);
      if (!fileStat.isSymbolicLink() && fileStat.isFile()) {
        entries.push({ name: entry.name, isDirectory: false, isFile: true, sizeBytes: fileStat.size });
      }
    }
  }
  return entries;
}

export async function walkHealthDirectories(
  root: string,
  skip: string,
  reportProgress?: HealthWalkProgressReporter,
  limits: HealthWalkLimits = DEFAULT_HEALTH_WALK_LIMITS,
): Promise<{ empty: string[]; visitedDirectories: number; visitedEntries: number }> {
  const empty: string[] = [];
  const pending = [root];
  const budget = { visitedEntries: 0 };
  let visitedDirectories = 0;
  while (pending.length > 0) {
    const dir = pending.pop()!;
    const visible = await readHealthDirectory(root, dir, budget, limits);
    if (visible.length === 0) empty.push(dir);
    for (const entry of visible) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory && path.resolve(full) !== path.resolve(skip)) pending.push(full);
    }
    visitedDirectories++;
    if (reportProgress && visitedDirectories % limits.reportEveryDirectories === 0) {
      await reportProgress({
        phase: "folders",
        processed: visitedDirectories,
        total: null,
        message: `Checked ${visitedDirectories.toLocaleString()} folders…`,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return { empty, visitedDirectories, visitedEntries: budget.visitedEntries };
}
