/**
 * Pure, dependency-free helpers for library-monitor logic.
 * Kept in a separate module so unit tests can import them without pulling
 * in @workspace/db or any other heavy dependency.
 */

export type LibraryMonitorStatus = "unconfigured" | "online" | "offline";

/**
 * Determines whether an active scan should be paused after a failed NAS check.
 *
 * Rules:
 *  - Already offline → no re-pause (the transition already happened).
 *  - failuresAfterIncrement < 2 → debounce: first blip is silently forgiven.
 *  - failuresAfterIncrement >= 2 AND there is an active job → pause.
 */
export function shouldPauseScan(
  previousStatus: LibraryMonitorStatus,
  failuresAfterIncrement: number,
  activeJobId: number | null,
): boolean {
  if (previousStatus === "offline") return false;
  if (failuresAfterIncrement < 2) return false;
  return activeJobId !== null;
}
