import { db, appSettingsTable } from "@workspace/db";
import { checkNasReachableAsync } from "./nas-storage";
import { getActiveJobId, getActiveJobType, requestPause, requestCancel, startJob } from "./library-engine";
import { recordActivity } from "./library-activity";
import { logger } from "./logger";
import { shouldPauseScan } from "./monitor-helpers";

/**
 * Smart Library Health monitor.
 *
 * Periodically checks whether the configured library location is reachable
 * (using the single source of truth, checkNasReachable). Tracks transitions:
 *  - online → offline: pauses any running library job so indexing stops cleanly.
 *  - offline → online: automatically starts an incremental (QUICK) scan so only
 *    new/changed files are indexed — never a full rebuild — unless the user has
 *    paused indexing.
 *
 * State is in-memory (rebuilt after a restart from the first check).
 */

import type { LibraryMonitorStatus } from "./monitor-helpers";
export type { LibraryMonitorStatus };

export interface LibraryHealthSnapshot {
  status: LibraryMonitorStatus;
  path: string;
  message: string;
  lastCheckAt: string | null;
  lastOnlineAt: string | null;
  offlineSince: string | null;
  reconnectedAt: string | null;
  reconnectScanJobId: number | null;
  indexingPaused: boolean;
  watching: boolean;
}

interface MonitorState {
  status: LibraryMonitorStatus;
  path: string;
  message: string;
  lastCheckAt: Date | null;
  lastOnlineAt: Date | null;
  offlineSince: Date | null;
  reconnectedAt: Date | null;
  reconnectScanJobId: number | null;
  indexingPaused: boolean;
}

const state: MonitorState = {
  status: "unconfigured",
  path: "",
  message: "No library location configured",
  lastCheckAt: null,
  lastOnlineAt: null,
  offlineSince: null,
  reconnectedAt: null,
  reconnectScanJobId: null,
  indexingPaused: false,
};

let timer: NodeJS.Timeout | null = null;
let checking = false;
let consecutiveFailures = 0;

export const MONITOR_INTERVAL_MS = 20_000;

export async function runLibraryCheck(): Promise<LibraryHealthSnapshot> {
  if (checking) return getLibraryHealthSnapshot();
  checking = true;
  try {
    let nasPath: string | null = null;
    let indexingPaused = false;
    let lastScanAt: Date | null = null;
    try {
      const [row] = await db.select({
        nasPath: appSettingsTable.nasPath,
        indexingPaused: appSettingsTable.indexingPaused,
        lastScanAt: appSettingsTable.lastScanAt,
      }).from(appSettingsTable).limit(1);
      nasPath = row?.nasPath ?? null;
      indexingPaused = row?.indexingPaused ?? false;
      lastScanAt = row?.lastScanAt ?? null;
    } catch {
      // DB not ready — keep previous state
      return getLibraryHealthSnapshot();
    }

    state.lastCheckAt = new Date();
    state.indexingPaused = indexingPaused;

    if (!nasPath || nasPath.trim() === "") {
      state.status = "unconfigured";
      state.path = "";
      state.message = "No library location configured";
      return getLibraryHealthSnapshot();
    }

    // Run the reachability check in a Worker thread (never blocks the event loop).
    // The `checking` flag is set before this await so a concurrent heartbeat that
    // fires while the Worker is still in flight is dropped immediately (line above).
    const reach = await checkNasReachableAsync(nasPath);
    const previous = state.status;
    state.path = reach.path;
    state.message = reach.message;

    if (reach.online) {
      // Reset the failure streak on any successful check.
      consecutiveFailures = 0;
      state.status = "online";
      state.lastOnlineAt = new Date();
      if (previous === "offline") {
        // ── Automatic recovery ─────────────────────────────────────────────
        state.reconnectedAt = new Date();
        state.offlineSince = null;
        logger.info({ nasPath }, "Library reconnected — checking for new media");
        void recordActivity(nasPath, "reconnected", "Library reconnected. Checking for changes…");
        if (!indexingPaused) {
          try {
            const result = await startJob({ jobType: "SCAN", profile: "QUICK", nasPath });
            state.reconnectScanJobId = result.jobId;
          } catch (err) {
            logger.warn({ err }, "Failed to start reconnect scan");
          }
        }
      }
    } else {
      consecutiveFailures++;
      if (state.status !== "offline") {
        // Debounce: require 2 consecutive failed checks before declaring offline
        // and pausing the scan. A single transient SMB blip is silently forgiven.
        if (consecutiveFailures < 2) {
          logger.warn({ nasPath, consecutiveFailures, reason: reach.message },
            "Library check failed (will pause if next check also fails)");
          return getLibraryHealthSnapshot();
        }
        state.offlineSince = new Date();
        // Seed a sensible "last successful connection" for a fresh process.
        if (!state.lastOnlineAt && lastScanAt) state.lastOnlineAt = lastScanAt;
        // Pause scan jobs so they can resume cleanly later.
        // Thumbnail/metadata jobs handle per-file errors gracefully — cancel
        // them so the reconnect scan can auto-restart them with cursor=0.
        const activeId = getActiveJobId();
        if (activeId !== null) {
          const activeType = getActiveJobType();
          if (activeType === "THUMBNAILS" || activeType === "METADATA") {
            requestCancel(activeId, "NAS_OFFLINE");
            logger.warn({
              pauseSource: "library_monitor",
              consecutiveFailures,
              activeId,
              activeType,
              nasPath,
              reason: reach.message,
            }, "Library went offline — cancelled thumbnail/metadata job (will restart after reconnect scan)");
          } else {
            requestPause(activeId);
            logger.warn({
              pauseSource: "library_monitor",
              consecutiveFailures,
              activeId,
              nasPath,
              reason: reach.message,
            }, "Library went offline — paused active indexing job");
          }
        } else {
          logger.warn({ nasPath, reason: reach.message }, "Library went offline");
        }
        void recordActivity(nasPath, "offline",
          "Library went offline. Watching paused — Willard AI will reconnect automatically.");
      }
      state.status = "offline";
    }
    return getLibraryHealthSnapshot();
  } finally {
    checking = false;
  }
}

export function getLibraryHealthSnapshot(): LibraryHealthSnapshot {
  return {
    status: state.status,
    path: state.path,
    message: state.message,
    lastCheckAt: state.lastCheckAt?.toISOString() ?? null,
    lastOnlineAt: state.lastOnlineAt?.toISOString() ?? null,
    offlineSince: state.offlineSince?.toISOString() ?? null,
    reconnectedAt: state.reconnectedAt?.toISOString() ?? null,
    reconnectScanJobId: state.reconnectScanJobId,
    indexingPaused: state.indexingPaused,
    watching: state.status === "online" && !state.indexingPaused,
  };
}

/** Clear the one-time "reconnected" announcement once the UI has shown it. */
export function acknowledgeReconnect(): void {
  state.reconnectedAt = null;
  state.reconnectScanJobId = null;
}

export function startLibraryMonitor(): void {
  if (timer) return;
  // First check after a 15-second grace period. This prevents a false
  // offline→online trigger during the brief SMB mount delay that occurs on
  // nearly every restart, which would otherwise queue an immediate QUICK scan.
  setTimeout(() => { runLibraryCheck().catch(() => {}); }, 15_000);
  timer = setInterval(() => { runLibraryCheck().catch(() => {}); }, MONITOR_INTERVAL_MS);
  timer.unref?.();
}
