import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import {
  assertMediaProcessStartAllowed,
  runMediaToolAsync,
  stopMediaProcess,
  trackActiveMediaProcess,
} from "./media-tools.ts";


type SevenZipProcessStream = {
  _childProcess?: ChildProcess;
  destroy?: (error?: Error) => unknown;
};

/**
 * node-7z 3.x exposes the spawned ChildProcess on its returned stream. Register
 * that process with the same owner used by FFmpeg so shutdown and request
 * cancellation cannot leave archive work running after its caller is gone.
 */
export function createTrackedSevenZipStream<T>(
  create: () => T,
  signal?: AbortSignal,
): T {
  assertMediaProcessStartAllowed();
  if (signal?.aborted) throw new Error("7-Zip operation was cancelled before it started.");

  const stream = create();
  const child = (stream as T & SevenZipProcessStream)._childProcess;
  if (!child) {
    const error = new Error("node-7z did not expose its spawned child process.");
    (stream as T & SevenZipProcessStream).destroy?.(error);
    throw error;
  }

  trackActiveMediaProcess(child);
  if (signal) {
    const stop = () => { void stopMediaProcess(child).catch(() => {}); };
    const detach = () => signal.removeEventListener("abort", stop);
    child.once("close", detach);
    child.once("error", detach);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  }
  return stream;
}

/** Stop a 7-Zip stream after archive validation rejects its metadata. */
export function stopTrackedSevenZipStream(stream: unknown): Promise<void> {
  const child = (stream as SevenZipProcessStream | null | undefined)?._childProcess;
  return child ? stopMediaProcess(child) : Promise.resolve();
}

export interface SevenZipResolutionOptions {
  platform?: NodeJS.Platform;
  pathEnv?: string;
  configuredPath?: string;
  packagedPath?: string;
  exists?: (candidate: string) => boolean;
  getVersion?: (candidate: string) => string | undefined | Promise<string | undefined>;
  moduleUrl?: string;
}

const MINIMUM_SUPPORTED_VERSION = { major: 26, minor: 1 };

async function readSevenZipVersion(candidate: string): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await runMediaToolAsync(candidate, ["i"], {
      timeoutMs: 10_000,
      maxBufferBytes: 64 * 1024,
    });
    const output = `${stdout}\n${stderr}`;
    return output.match(/7-Zip(?: \(z\))? (\d+\.\d+)/)?.[1];
  } catch {
    return undefined;
  }
}

function isSupportedOfficialVersion(version: string | undefined): boolean {
  if (!version) return false;
  const match = version.match(/^(\d+)\.(\d+)$/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > MINIMUM_SUPPORTED_VERSION.major ||
    (major === MINIMUM_SUPPORTED_VERSION.major && minor >= MINIMUM_SUPPORTED_VERSION.minor);
}

async function resolveSevenZipPathUncached(
  options: SevenZipResolutionOptions = {},
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const configuredPath = options.configuredPath ?? process.env.WILLARD_7ZIP_PATH;
  const exists = options.exists ?? fs.existsSync;
  const getVersion = options.getVersion ?? readSevenZipVersion;
  const candidates: string[] = [];

  if (configuredPath) candidates.push(configuredPath);

  const packagedName = platform === "win32" ? "7z.exe" : platform === "darwin" ? "7zz" : "7zzs";
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const packagedPath = options.packagedPath ??
    path.resolve(path.dirname(fileURLToPath(moduleUrl)), "../vendor/7zip", packagedName);
  candidates.push(packagedPath);

  const delimiter = platform === "win32" ? ";" : ":";
  const directories = pathEnv.split(delimiter).filter(Boolean);
  const binaries = platform === "win32" ? ["7z.exe"] : ["7zzs", "7zz"];
  for (const binary of binaries) {
    for (const directory of directories) candidates.push(path.join(directory, binary));
  }

  const checked = new Set<string>();
  for (const candidate of candidates) {
    if (checked.has(candidate)) continue;
    checked.add(candidate);
    if (!exists(candidate)) continue;
    let version: string | undefined;
    try {
      version = await getVersion(candidate);
    } catch {
      // A broken or incompatible candidate must not prevent checking the next
      // configured/packaged/PATH candidate.
      version = undefined;
    }
    if (isSupportedOfficialVersion(version)) return candidate;
  }
  return undefined;
}

/**
 * Build a resolver that coalesces concurrent version probes and retains a
 * verified binary for this process lifetime. Negative results are not cached:
 * installing 7-Zip while the app is running can restore archive functionality.
 */
export function createSevenZipPathResolver(
  options: SevenZipResolutionOptions = {},
): () => Promise<string | undefined> {
  let cachedPath: string | undefined;
  let pending: Promise<string | undefined> | null = null;

  return async () => {
    if (cachedPath) return cachedPath;
    if (!pending) {
      pending = resolveSevenZipPathUncached(options)
        .then((resolved) => {
          if (resolved) cachedPath = resolved;
          return resolved;
        })
        .finally(() => { pending = null; });
    }
    return pending;
  };
}

const defaultSevenZipPathResolver = createSevenZipPathResolver();

/** Resolve an official supported binary without blocking the API event loop. */
export function resolveSevenZipPath(
  options?: SevenZipResolutionOptions,
): Promise<string | undefined> {
  return options
    ? resolveSevenZipPathUncached(options)
    : defaultSevenZipPathResolver();
}

export async function getSevenZipPath(options?: SevenZipResolutionOptions): Promise<string> {
  const resolved = await resolveSevenZipPath(options);
  if (resolved) return resolved;
  throw new Error(
    "Archive operations require official 7-Zip 26.01 or newer. Install it on PATH or set WILLARD_7ZIP_PATH; the bundled legacy p7zip fallback is intentionally disabled.",
  );
}
