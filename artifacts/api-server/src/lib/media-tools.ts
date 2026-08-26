import { execFile, spawnSync, type SpawnSyncReturns } from "child_process";
import { logger } from "./logger.ts";

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
  return new Promise(resolve => {
    execFile(bin, ["-version"], { timeout: 5000 }, (error) => resolve(!error));
  });
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
