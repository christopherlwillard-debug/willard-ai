import { execFile, spawnSync, type ChildProcess, type SpawnSyncReturns } from "child_process";
import { logger } from "./logger.ts";
import { isShuttingDown } from "./shutdown-state.ts";

/**
 * Shared helpers for the external media binaries (ffmpeg / ffprobe).
 *
 * On Replit these are preinstalled in the system image. When running locally
 * (e.g. on Windows) they must be installed by the user and present on PATH —
 * so we detect a missing binary and surface a clear, actionable message instead
 * of a cryptic "ffmpeg exited null".
 */

export const FFMPEG_INSTALL_HINT =
  "Install FFmpeg and make sure 'ffmpeg' and 'ffprobe' are on your PATH. " +
  "Windows: `winget install Gyan.FFmpeg` (or download from https://www.gyan.dev/ffmpeg/builds/) then restart your terminal. " +
  "macOS: `brew install ffmpeg`. Linux: install the 'ffmpeg' package.";

/** True when spawnSync failed because the binary itself could not be found. */
export function isMissingBinaryError(result: SpawnSyncReturns<unknown>): boolean {
  const err = result.error as NodeJS.ErrnoException | undefined;
  return !!err && err.code === "ENOENT";
}

/** Build a human-readable error string for a failed media-tool invocation. */
export function formatMediaToolError(
  bin: "ffmpeg" | "ffprobe",
  result: SpawnSyncReturns<unknown>,
  detail?: string,
): string {
  if (isMissingBinaryError(result)) {
    return `${bin} is not installed or not on PATH. ${FFMPEG_INSTALL_HINT}`;
  }
  if (result.error) {
    return `${bin} failed to start: ${result.error.message}`;
  }
  const suffix = detail ? `: ${detail}` : "";
  return `${bin} exited with code ${result.status}${suffix}`;
}

export interface MediaToolExecutionOptions {
  timeoutMs: number;
  maxBufferBytes?: number;
  signal?: AbortSignal;
}

export interface MediaToolExecutionResult {
  stdout: string;
  stderr: string;
}

type MediaToolExecutionError = Error & {
  code?: string | number;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
};

const activeMediaProcesses = new Set<ChildProcess>();

const MEDIA_TOOL_TIMEOUT_KILL_GRACE_MS = 2_000;

export function assertMediaProcessStartAllowed(): void {
  if (!isShuttingDown()) return;
  const failure = new Error("Cannot start an external media/archive subprocess while the API server is shutting down.") as MediaToolExecutionError;
  failure.code = "ERR_SERVER_SHUTTING_DOWN";
  throw failure;
}

/** Register a directly spawned archive/media child with the shared shutdown owner. */
export function trackActiveMediaProcess(child: ChildProcess): () => void {
  activeMediaProcesses.add(child);
  const removeChild = () => activeMediaProcesses.delete(child);
  child.once("close", removeChild);
  child.once("error", removeChild);
  return removeChild;
}

function isMediaProcessRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function waitForMediaProcess(child: ChildProcess): Promise<void> {
  if (!isMediaProcessRunning(child)) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      child.off("close", finish);
      child.off("error", finish);
      resolve();
    };
    child.once("close", finish);
    child.once("error", finish);
    if (!isMediaProcessRunning(child)) finish();
  });
}

/**
 * Stop tracked media and archive subprocesses before the server closes its
 * database and exits. These children write only staged/cache/scratch outputs,
 * so terminating them preserves originals and leaves incomplete work available
 * for recovery.
 */
async function waitForMediaProcessWithin(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!isMediaProcessRunning(child)) return true;
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      waitForMediaProcess(child).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Stop one owned media/archive child with the same bounded TERM-to-KILL policy used at shutdown. */
export async function stopMediaProcess(
  child: ChildProcess,
  graceMs = MEDIA_TOOL_TIMEOUT_KILL_GRACE_MS,
): Promise<void> {
  if (!isMediaProcessRunning(child)) return;
  try {
    child.kill("SIGTERM");
  } catch (error) {
    logger.warn({ err: error, pid: child.pid }, "Unable to request graceful media subprocess shutdown");
  }
  if (await waitForMediaProcessWithin(child, graceMs)) return;
  if (!isMediaProcessRunning(child)) return;

  try {
    child.kill("SIGKILL");
  } catch (error) {
    logger.warn({ err: error, pid: child.pid }, "Unable to force-stop a media subprocess");
  }
  if (!await waitForMediaProcessWithin(child, 1_000) && isMediaProcessRunning(child)) {
    logger.error({ pid: child.pid }, "Media subprocess remained active after forced shutdown");
  }
}

/**
 * Stop tracked media and archive subprocesses before the server closes its
 * database and exits. These children write only staged/cache/scratch outputs,
 * so terminating them preserves originals and leaves incomplete work available
 * for recovery.
 */
export async function stopActiveMediaTools(graceMs = 2_000): Promise<void> {
  const active = [...activeMediaProcesses].filter(isMediaProcessRunning);
  if (active.length === 0) return;
  await Promise.all(active.map((child) => stopMediaProcess(child, graceMs)));
  const stillRunning = active.filter(isMediaProcessRunning);
  if (stillRunning.length > 0) {
    logger.error({ count: stillRunning.length }, "Media subprocesses remained active after forced shutdown");
  }
}

/**
 * Run a media binary without blocking the API event loop. Conversion requests
 * can take minutes, so they must remain asynchronous for cancellation, health,
 * and unrelated API traffic to be serviced while the child process runs.
 */
export function runMediaToolAsync(
  bin: string,
  args: string[],
  options: MediaToolExecutionOptions,
): Promise<MediaToolExecutionResult> {
  if (options.signal?.aborted) {
    return Promise.reject(options.signal.reason instanceof Error
      ? options.signal.reason
      : Object.assign(new Error("Media tool execution was aborted"), { name: "AbortError", code: "ABORT_ERR" }));
  }
  try {
    assertMediaProcessStartAllowed();
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    let child: ChildProcess | null = null;
    let timeoutEscalationTimer: NodeJS.Timeout | null = null;
    let forceKillTimer: NodeJS.Timeout | null = null;
    let abortKillTimer: NodeJS.Timeout | null = null;
    const cleanup = () => {
      if (timeoutEscalationTimer) clearTimeout(timeoutEscalationTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (abortKillTimer) clearTimeout(abortKillTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (child) activeMediaProcesses.delete(child);
    };
    const onAbort = () => {
      abortKillTimer = setTimeout(() => {
        if (!child?.pid || !isMediaProcessRunning(child)) return;
        try {
          child.kill("SIGKILL");
        } catch (error) {
          logger.warn({ err: error }, "Unable to force-stop an aborted media subprocess");
        }
      }, MEDIA_TOOL_TIMEOUT_KILL_GRACE_MS);
      abortKillTimer.unref?.();
    };
    child = execFile(bin, args, {
      encoding: "utf8",
      timeout: options.timeoutMs,
      killSignal: "SIGTERM",
      maxBuffer: options.maxBufferBytes ?? 1024 * 1024,
      windowsHide: true,
      signal: options.signal,
    }, (error, stdout, stderr) => {
      // Abort can invoke the execFile callback before the child closes. Keep
      // the escalation timer and shutdown registration until close/error so a
      // child that ignores SIGTERM is still force-stopped.
      if (error) {
        const failure = error as MediaToolExecutionError;
        failure.stdout = String(stdout ?? "");
        failure.stderr = String(stderr ?? "");
        reject(failure);
        return;
      }
      resolve({
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
    activeMediaProcesses.add(child);
    child.once("close", cleanup);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    // execFile sends SIGTERM at timeoutMs but waits for the child to close.
    // Escalate if a tool ignores that signal so a hung encoder cannot retain
    // the request and its process indefinitely.
    if (options.timeoutMs > 0) {
      timeoutEscalationTimer = setTimeout(() => {
        if (!child?.pid || !isMediaProcessRunning(child)) return;
        forceKillTimer = setTimeout(() => {
          if (!child?.pid || !isMediaProcessRunning(child)) return;
          try {
            child.kill("SIGKILL");
          } catch (error) {
            logger.warn({ err: error }, "Unable to force-stop a timed-out media subprocess");
          }
        }, MEDIA_TOOL_TIMEOUT_KILL_GRACE_MS);
        forceKillTimer.unref?.();
      }, options.timeoutMs + 100);
      timeoutEscalationTimer.unref?.();
    }
  });
}

/** Format an asynchronous child-process failure with bounded diagnostics. */
export function formatMediaToolExecutionError(
  bin: "ffmpeg" | "ffprobe",
  error: unknown,
  timeoutMs: number,
): string {
  const failure = error instanceof Error
    ? error as MediaToolExecutionError
    : new Error(String(error)) as MediaToolExecutionError;
  if (failure.code === "ERR_SERVER_SHUTTING_DOWN") {
    return `${bin} was not started because the API server is shutting down`;
  }
  if (failure.code === "ENOENT") {
    return `${bin} is not installed or not on PATH. ${FFMPEG_INSTALL_HINT}`;
  }

  const detail = String(failure.stderr ?? "").trim().slice(-500);
  if (failure.code === "ETIMEDOUT") {
    return `${bin} timed out after ${Math.ceil(timeoutMs / 1000)} seconds${detail ? `: ${detail}` : ""}`;
  }
  if (failure.killed || failure.signal) {
    return `${bin} was stopped before completion${detail ? `: ${detail}` : ""}`;
  }
  if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return `${bin} output exceeded the configured diagnostic limit`;
  }

  const suffix = detail || failure.message;
  return `${bin} exited with code ${failure.code ?? "unknown"}${suffix ? `: ${suffix}` : ""}`;
}

let alreadyChecked = false;

export interface MediaToolsHealth {
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  thumbnailGenerationAvailable: boolean;
  message: string | null;
}

let healthCache: MediaToolsHealth | null = null;
let healthCacheAt = 0;
let healthProbe: Promise<MediaToolsHealth> | null = null;
const HEALTH_CACHE_MS = 30_000;

function probeTool(bin: "ffmpeg" | "ffprobe"): Promise<boolean> {
  return runMediaToolAsync(bin, ["-version"], {
    timeoutMs: 5_000,
    maxBufferBytes: 64 * 1024,
  }).then(
    () => true,
    () => false,
  );
}

/**
 * Probe external media capabilities without blocking health requests. The
 * result is short-lived because an operator may install FFmpeg while the app
 * is running and should not need to restart just to clear a degraded status.
 */
export async function getMediaToolsHealth(): Promise<MediaToolsHealth> {
  const now = Date.now();
  if (healthCache && now - healthCacheAt < HEALTH_CACHE_MS) return healthCache;
  if (!healthProbe) {
    healthProbe = Promise.all([probeTool("ffmpeg"), probeTool("ffprobe")])
      .then(([ffmpegAvailable, ffprobeAvailable]) => {
        const unavailable: string[] = [];
        if (!ffmpegAvailable) unavailable.push("ffmpeg");
        if (!ffprobeAvailable) unavailable.push("ffprobe");
        const message = unavailable.length > 0
          ? `${unavailable.join(" and ")} unavailable. ${FFMPEG_INSTALL_HINT}`
          : null;
        const result = {
          ffmpegAvailable,
          ffprobeAvailable,
          thumbnailGenerationAvailable: ffmpegAvailable,
          message,
        };
        healthCache = result;
        healthCacheAt = Date.now();
        return result;
      })
      .finally(() => { healthProbe = null; });
  }
  return healthProbe;
}

/**
 * One-time startup probe. Logs a clear warning (not a crash) when ffmpeg/ffprobe
 * are unavailable so a local operator knows thumbnails, video metadata, and
 * media conversion will be degraded until they install FFmpeg.
 */
export function checkMediaToolsOnStartup(): void {
  if (alreadyChecked) return;
  alreadyChecked = true;
  for (const bin of ["ffmpeg", "ffprobe"] as const) {
    const r = spawnSync(bin, ["-version"], { encoding: "utf8", timeout: 5000 });
    if (isMissingBinaryError(r)) {
      logger.warn(
        { bin },
        `${bin} not found — thumbnails, video metadata, and media conversion are unavailable until it is installed. ${FFMPEG_INSTALL_HINT}`,
      );
    } else if (r.status !== 0) {
      logger.warn(
        { bin, status: r.status },
        `${bin} is on PATH but exited with a non-zero status during the startup check — media features may not work correctly.`,
      );
    }
  }
}
