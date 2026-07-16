import { db, appSettingsTable } from "@workspace/db";
import { checkNasReachable } from "./nas-storage";
import { getActiveJobId, requestPause, startJob } from "./library-engine";
import { logger } from "./logger";

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

export type LibraryMonitorStatus = "unconfigured" | "online" | "offline";

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

    const reach = checkNasReachable(nasPath);
    const previous = state.status;
    state.path = reach.path;
    state.message = reach.message;

    if (reach.online) {
      state.status = "online";
      state.lastOnlineAt = new Date();
      if (previous === "offline") {
        // ── Automatic recovery ─────────────────────────────────────────────
        state.reconnectedAt = new Date();
        state.offlineSince = null;
        logger.info({ nasPath }, "Library reconnected — checking for new media");
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
      if (state.status !== "offline") {
        state.offlineSince = new Date();
        // Seed a sensible "last successful connection" for a fresh process.
        if (!state.lastOnlineAt && lastScanAt) state.lastOnlineAt = lastScanAt;
        // Pause any running indexing job so it can resume cleanly later.
        const activeId = getActiveJobId();
        if (activeId !== null) {
          requestPause(activeId);
          logger.warn({ activeId, nasPath }, "Library went offline — paused active indexing job");
        } else {
          logger.warn({ nasPath, reason: reach.message }, "Library went offline");
        }
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
  // First check shortly after boot (give the DB bootstrap a moment).
  setTimeout(() => { runLibraryCheck().catch(() => {}); }, 3_000);
  timer = setInterval(() => { runLibraryCheck().catch(() => {}); }, MONITOR_INTERVAL_MS);
  timer.unref?.();
}
