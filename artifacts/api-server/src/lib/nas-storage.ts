import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Writable } from "stream";
import { Worker } from "worker_threads";

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

export interface NasReachability {
  online: boolean;
  path: string;
  exists: boolean;
  isDirectory: boolean;
  readable: boolean;
  message: string;
}

/**
 * Single source of truth for "is the configured library path usable right now".
 * Performs live filesystem checks in order: exists → is-directory → readable →
 * enumerable. Returns a structured result so every surface (dashboard, health,
 * scanner, Settings test) can report a consistent online/offline state.
 */
export function checkNasReachable(nasPath: string | null | undefined): NasReachability {
  if (!nasPath || typeof nasPath !== "string" || nasPath.trim() === "") {
    return { online: false, path: nasPath ?? "", exists: false, isDirectory: false, readable: false, message: "No library location configured" };
  }
  if (nasPath.includes("\0") || nasPath.length > 4096) {
    return { online: false, path: nasPath, exists: false, isDirectory: false, readable: false, message: "Invalid library location" };
  }
  const trimmed = nasPath.trim();
  // On a non-Windows host (this server runs on Linux), Windows-style locations
  // can never be reached. Reject them explicitly instead of letting
  // path.resolve() turn e.g. "Z:" into a local relative folder that may exist
  // and falsely report online.
  if (process.platform !== "win32") {
    if (/^[A-Za-z]:/.test(trimmed)) {
      return { online: false, path: trimmed, exists: false, isDirectory: false, readable: false, message: "Windows drive letters (e.g. Z:) are not reachable from this server" };
    }
    if (trimmed.startsWith("\\\\")) {
      return { online: false, path: trimmed, exists: false, isDirectory: false, readable: false, message: "Windows network shares (\\\\server\\share) are not reachable from this server" };
    }
    if (!trimmed.startsWith("/")) {
      return { online: false, path: trimmed, exists: false, isDirectory: false, readable: false, message: "Library location must be an absolute path" };
    }
  }
  const resolved = path.resolve(trimmed);
  try {
    if (!fs.existsSync(resolved)) {
      return { online: false, path: resolved, exists: false, isDirectory: false, readable: false, message: `Library not found: ${resolved}` };
    }
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return { online: false, path: resolved, exists: true, isDirectory: false, readable: false, message: "Library location is not a directory" };
    }
    try {
      fs.accessSync(resolved, fs.constants.R_OK);
    } catch {
      return { online: false, path: resolved, exists: true, isDirectory: true, readable: false, message: "Library exists but is not readable (permission denied)" };
    }
    const entries = fs.readdirSync(resolved);
    return {
      online: true,
      path: resolved,
      exists: true,
      isDirectory: true,
      readable: true,
      message: `Online — ${entries.length} item${entries.length !== 1 ? "s" : ""} at root`,
    };
  } catch (err) {
    return { online: false, path: resolved, exists: false, isDirectory: false, readable: false, message: `Library unreachable: ${err instanceof Error ? err.message : "unknown error"}` };
  }
}

const NAS_CHECK_WORKER = `
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const p = workerData.resolved;
try {
  if (!fs.existsSync(p)) {
    parentPort.postMessage({ online: false, path: p, exists: false, isDirectory: false, readable: false, message: 'Library not found: ' + p });
    return;
  }
  const stat = fs.statSync(p);
  if (!stat.isDirectory()) {
    parentPort.postMessage({ online: false, path: p, exists: true, isDirectory: false, readable: false, message: 'Library location is not a directory' });
    return;
  }
  try { fs.accessSync(p, 4); } catch {
    parentPort.postMessage({ online: false, path: p, exists: true, isDirectory: true, readable: false, message: 'Library exists but is not readable (permission denied)' });
    return;
  }
  const entries = fs.readdirSync(p);
  parentPort.postMessage({ online: true, path: p, exists: true, isDirectory: true, readable: true, message: 'Online \u2014 ' + entries.length + ' item' + (entries.length !== 1 ? 's' : '') + ' at root' });
} catch (err) {
  parentPort.postMessage({ online: false, path: p, exists: false, isDirectory: false, readable: false, message: 'Library unreachable: ' + (err instanceof Error ? err.message : String(err)) });
}
`;

/**
 * Async version of checkNasReachable.
 * On Windows, network-drive access (e.g. Z:\) can block the event loop for 30+
 * seconds. This variant runs the blocking fs calls in a Worker thread and kills
 * it after `timeoutMs` so the HTTP request always completes promptly.
 */
export function checkNasReachableAsync(
  nasPath: string | null | undefined,
  timeoutMs = 8000,
): Promise<NasReachability> {
  if (!nasPath || typeof nasPath !== "string" || nasPath.trim() === "") {
    return Promise.resolve({ online: false, path: nasPath ?? "", exists: false, isDirectory: false, readable: false, message: "No library location configured" });
  }
  if (nasPath.includes("\0") || nasPath.length > 4096) {
    return Promise.resolve({ online: false, path: nasPath, exists: false, isDirectory: false, readable: false, message: "Invalid library location" });
  }
  const trimmed = nasPath.trim();
  if (process.platform !== "win32") {
    if (/^[A-Za-z]:/.test(trimmed)) {
      return Promise.resolve({ online: false, path: trimmed, exists: false, isDirectory: false, readable: false, message: "Windows drive letters (e.g. Z:) are not reachable from this server" });
    }
    if (trimmed.startsWith("\\\\")) {
      return Promise.resolve({ online: false, path: trimmed, exists: false, isDirectory: false, readable: false, message: "Windows network shares (\\\\server\\share) are not reachable from this server" });
    }
    if (!trimmed.startsWith("/")) {
      return Promise.resolve({ online: false, path: trimmed, exists: false, isDirectory: false, readable: false, message: "Library location must be an absolute path" });
    }
  }
  const resolved = path.resolve(trimmed);
  return new Promise((resolve) => {
    const worker = new Worker(NAS_CHECK_WORKER, { eval: true, workerData: { resolved } });
    const timer = setTimeout(() => {
      worker.terminate();
      resolve({ online: false, path: resolved, exists: false, isDirectory: false, readable: false, message: "Drive is not responding — check that the drive is connected and accessible." });
    }, timeoutMs);
    worker.on("message", (result: NasReachability) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(result);
    });
    worker.on("error", (err) => {
      clearTimeout(timer);
      worker.terminate();
      resolve({ online: false, path: resolved, exists: false, isDirectory: false, readable: false, message: "Check failed: " + err.message });
    });
  });
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
      // Fall through to the OS temp dir
    }
  }
  // Cross-platform local fallback. os.tmpdir() is the OS temp directory on every
  // platform (e.g. /tmp on Linux/macOS, %TEMP% on Windows) so this works when the
  // server runs locally on a user's machine, not just on Replit's Linux host.
  const localDir = path.join(os.tmpdir(), "willard-ai", suffix);
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
