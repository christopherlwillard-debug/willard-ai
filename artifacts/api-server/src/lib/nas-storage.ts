import * as fs from "fs";
import * as path from "path";
import { Writable } from "stream";

export const WILLARD_SUBDIRS = [
  "config",
  "database",
  "logs",
  "cache",
  "temp",
  "archive-index",
  "reports",
  "backups",
  "scan-history",
] as const;

export type WillardSubdir = (typeof WILLARD_SUBDIRS)[number];

export function getWillardAIDir(nasPath: string): string {
  return path.join(nasPath, "WillardAI");
}

/**
 * Walk up a path to find the nearest existing ancestor, resolve it via realpathSync
 * (dereferencing all symlinks), then reattach the remaining suffix.
 * This prevents symlink-escape via non-existent child paths:
 *   /nas/symlink-to-outside/newdir  → resolves parent /nas/symlink-to-outside → /outside → fail
 */
function canonicalizePath(p: string): string {
  let current = path.resolve(p);
  const parts: string[] = [];
  // Walk upward until we find an existing ancestor
  while (current !== path.dirname(current)) {
    try {
      const real = fs.realpathSync(current);
      // Reattach any suffix parts that didn't exist on disk
      return parts.length === 0 ? real : path.join(real, ...parts);
    } catch {
      parts.unshift(path.basename(current));
      current = path.dirname(current);
    }
  }
  return path.resolve(p);
}

export function assertWithinRoot(targetPath: string, root: string): void {
  const canonicalRoot   = canonicalizePath(root);
  const canonicalTarget = canonicalizePath(targetPath);

  if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(canonicalRoot + path.sep)) {
    throw new Error("Path traversal rejected: path is outside the allowed root");
  }
}

export interface NasSubdirStatus {
  name: string;
  path: string;
  exists: boolean;
}

export interface NasDirStatusResult {
  nasPath: string;
  willardAiPath: string;
  exists: boolean;
  allPresent: boolean;
  subdirs: NasSubdirStatus[];
}

export function getNasDirStatus(nasPath: string): NasDirStatusResult {
  const willardAiPath = getWillardAIDir(nasPath);
  let exists = false;
  try { exists = fs.existsSync(willardAiPath); } catch { /* NAS unreachable */ }
  const subdirs: NasSubdirStatus[] = WILLARD_SUBDIRS.map((name) => {
    const subdirPath = path.join(willardAiPath, name);
    let subdirExists = false;
    try { subdirExists = fs.existsSync(subdirPath); } catch { /* ignore */ }
    return { name, path: subdirPath, exists: subdirExists };
  });
  const allPresent = exists && subdirs.every((s) => s.exists);
  return { nasPath, willardAiPath, exists, allPresent, subdirs };
}

export function bootstrapWillardAIDir(nasPath: string): NasDirStatusResult {
  const willardAiPath = getWillardAIDir(nasPath);
  // Root dir creation is critical — let errors propagate so callers can surface them
  fs.mkdirSync(willardAiPath, { recursive: true });
  // All 9 subdirs are required — collect failures and throw a structured error
  const failures: string[] = [];
  for (const subdir of WILLARD_SUBDIRS) {
    try {
      fs.mkdirSync(path.join(willardAiPath, subdir), { recursive: true });
    } catch (err) {
      failures.push(`${subdir} (${err instanceof Error ? err.message : "unknown"})`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Could not create required subdirectories: ${failures.join(", ")}`);
  }
  return getNasDirStatus(nasPath);
}

export function getTempDir(nasPath: string | null | undefined, jobId?: string): string {
  const suffix = jobId ?? "default";
  if (nasPath) {
    try {
      const tempDir = path.join(getWillardAIDir(nasPath), "temp", suffix);
      fs.mkdirSync(tempDir, { recursive: true });
      return tempDir;
    } catch {
      // Fall through to local /tmp
    }
  }
  const localDir = path.join("/tmp", "willard-ai", suffix);
  try { fs.mkdirSync(localDir, { recursive: true }); } catch { /* ignore */ }
  return localDir;
}

export function cleanTempDir(tempDir: string): void {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch { /* non-fatal */ }
}

export function writeScanHistory(
  nasPath: string | null | undefined,
  summary: Record<string, unknown>,
): void {
  if (!nasPath) return;
  try {
    const histDir = path.join(getWillardAIDir(nasPath), "scan-history");
    if (!fs.existsSync(histDir)) return;
    const ts = new Date().toISOString().replace(/:/g, "-").replace(/\./g, "-");
    const jobId = summary["jobId"] ?? "unknown";
    const filename = `${ts}-${jobId}.json`;
    fs.writeFileSync(
      path.join(histDir, filename),
      JSON.stringify(summary, null, 2),
      "utf-8",
    );
  } catch {
    // Non-fatal — scan history write is best-effort
  }
}

// ── Lazy NAS log stream ────────────────────────────────────────────────────
// A no-op Writable until setNasPath() is called; then routes log lines to a
// daily-rotating file inside WillardAI/logs/.

export class LazyNasLogStream extends Writable {
  private rfsStream: NodeJS.WritableStream | null = null;

  async setNasPath(nasPath: string): Promise<void> {
    try {
      const logDir = path.join(getWillardAIDir(nasPath), "logs");
      if (!fs.existsSync(logDir)) return;
      const { createStream } = await import("rotating-file-stream");
      const newStream = createStream("willard-ai.log", {
        interval: "1d",
        path: logDir,
        maxFiles: 30,
      });
      const old = this.rfsStream;
      this.rfsStream = newStream as unknown as NodeJS.WritableStream;
      if (old && "destroy" in old && typeof (old as any).destroy === "function") {
        (old as any).destroy();
      }
    } catch {
      // NAS not accessible — silently continue with stdout only
    }
  }

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (err?: Error | null) => void,
  ): void {
    if (this.rfsStream) {
      (this.rfsStream as NodeJS.WritableStream).write(chunk as Buffer | string, (err?: Error | null) =>
        callback(err ?? null),
      );
    } else {
      callback();
    }
  }

  override _destroy(err: Error | null, callback: (err?: Error | null) => void): void {
    if (this.rfsStream && "destroy" in this.rfsStream) {
      (this.rfsStream as any).destroy(err ?? undefined);
    }
    callback(err);
  }
}

export const nasLogStream = new LazyNasLogStream();
