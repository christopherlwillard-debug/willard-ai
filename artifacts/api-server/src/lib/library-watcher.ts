import * as fs from "fs";
import { db, appSettingsTable } from "@workspace/db";
import { checkNasReachable } from "./nas-storage";
import { getActiveJobId, getActiveJobProfile, startJob, waitForUiConnected } from "./library-engine";
import { recordActivity } from "./library-activity";
import { logger } from "./logger";

/**
 * Continuous Library Watcher — the live "brains" that keeps the index in sync
 * with the NAS without manual rescans.
 *
 * Hybrid architecture:
 *  - Native filesystem events (fs.watch, recursive) when the platform and the
 *    underlying filesystem support them → near real-time updates.
 *  - Automatic fallback to configurable periodic sweeps (default 60 s, min 10 s)
 *    when native watching is unavailable or unreliable (typical for SMB / network
 *    shares). Interval is set via Settings → watcher_poll_interval_seconds.
 *  - Even in events mode a low-frequency safety sweep catches anything the event
 *    stream missed. The user sees one seamless "live library" either way.
 *
 * Conflict guard (M7):
 *  When a FULL rescan is active and watcher events arrive we don't race against
 *  it — we mark needsCatchUp and let the heartbeat start a QUICK scan the moment
 *  the full scan finishes. This avoids a second full walk and lets the deletion
 *  sweep complete cleanly before applying incremental changes.
 *
 * All indexing goes through the existing scan engine (startJob QUICK), which
 * guarantees identity preservation on rename/move (fingerprint match updates
 * the canonical record in place), graceful deletion marking, and single-
 * source-of-truth records. The watcher only decides WHEN to run it, and
 * batches bursts of thousands of events into one indexing session.
 */

export type WatchMechanism = "events" | "sweep";
export type WatcherPublicState = "watching" | "watching_paused" | "offline" | "unconfigured";

const HEARTBEAT_MS       = 10_000;      // watcher self-check / auto-recovery loop
const DEBOUNCE_MS        = 2_000;       // quiet window after last event before indexing
const MAX_WAIT_MS        = 15_000;      // never delay indexing longer than this during a sustained burst
const BURST_THRESHOLD    = 200;         // pending changes that count as a "large import burst"
const SAFETY_SWEEP_MS    = 30 * 60_000; // safety sweep cadence while events are active (events mode only)
const DEFAULT_SWEEP_INTERVAL_S = 60;    // default SMB polling interval in seconds
const MIN_SWEEP_INTERVAL_S     = 10;    // lower bound so users can't accidentally set < 10 s

interface WatcherInternalState {
  watchedPath:      string | null;
  fsWatcher:        fs.FSWatcher | null;
  mechanism:        WatchMechanism;
  eventsUnsupported:boolean;         // fs.watch failed → permanent sweep mode until path changes
  paused:           boolean;
  online:           boolean;
  configured:       boolean;
  pendingChanges:   number;
  firstPendingAt:   number | null;   // epoch ms — enforces MAX_WAIT_MS
  lastChangeAt:     Date | null;
  lastScanTriggerAt:Date | null;
  lastSweepAt:      number;
  restarts:         number;
  burstAnnounced:   boolean;
  needsCatchUp:     boolean;         // set after watcher restart or FULL scan completes
  sweepIntervalMs:  number;          // configurable; updated each heartbeat from DB settings
}

const state: WatcherInternalState = {
  watchedPath: null,
  fsWatcher: null,
  mechanism: "sweep",
  eventsUnsupported: false,
  paused: false,
  online: false,
  configured: false,
  pendingChanges: 0,
  firstPendingAt: null,
  lastChangeAt: null,
  lastScanTriggerAt: null,
  lastSweepAt: Date.now(),
  restarts: 0,
  burstAnnounced: false,
  needsCatchUp: false,
  sweepIntervalMs: DEFAULT_SWEEP_INTERVAL_S * 1000,
};

let heartbeatTimer: NodeJS.Timeout | null = null;
let debounceTimer: NodeJS.Timeout | null = null;


// ── Public snapshot (for /api/library/health) ────────────────────────────────

export interface WatcherSnapshot {
  state:             WatcherPublicState;
  mechanism:         WatchMechanism;
  lastChangeAt:      string | null;
  lastScanTriggerAt: string | null;
  pendingChanges:    number;
  restarts:          number;
  sweepIntervalSeconds: number;
}

export function getWatcherSnapshot(): WatcherSnapshot {
  let publicState: WatcherPublicState;
  if (!state.configured) publicState = "unconfigured";
  else if (!state.online) publicState = "offline";
  else if (state.paused) publicState = "watching_paused";
  else publicState = "watching";
  return {
    state: publicState,
    mechanism: state.mechanism,
    lastChangeAt: state.lastChangeAt?.toISOString() ?? null,
    lastScanTriggerAt: state.lastScanTriggerAt?.toISOString() ?? null,
    pendingChanges: state.pendingChanges,
    restarts: state.restarts,
    sweepIntervalSeconds: Math.round(state.sweepIntervalMs / 1000),
  };
}

// ── Event handling ────────────────────────────────────────────────────────────

function onFsEvent(nasPath: string, filename: string | Buffer | null): void {
  // Ignore Willard AI's own working directory (logs, thumbnails, temp…) —
  // otherwise our own writes would trigger endless rescans.
  if (filename) {
    const rel = filename.toString().replace(/\\/g, "/");
    if (rel === "WillardAI" || rel.startsWith("WillardAI/")) return;
  }
  state.lastChangeAt = new Date();
  state.pendingChanges++;
  if (state.firstPendingAt === null) state.firstPendingAt = Date.now();

  // Burst announcement — once per batch.
  if (!state.burstAnnounced && state.pendingChanges >= BURST_THRESHOLD) {
    state.burstAnnounced = true;
    void recordActivity(nasPath, "burst",
      `${state.pendingChanges.toLocaleString()}+ file changes detected. Preparing updates…`,
      { pendingChanges: state.pendingChanges });
  }

  // M7 conflict guard: if a FULL rescan is running, don't start another scan on
  // top of it. Mark needsCatchUp so the heartbeat triggers a QUICK scan the
  // moment the full scan finishes and the deletion sweep completes cleanly.
  const activeProfile = getActiveJobProfile();
  if (activeProfile === "FULL") {
    state.needsCatchUp = true;
    return;
  }

  scheduleDebouncedScan(nasPath);
}

function scheduleDebouncedScan(nasPath: string): void {
  const elapsed = state.firstPendingAt !== null ? Date.now() - state.firstPendingAt : 0;
  if (elapsed >= MAX_WAIT_MS) {
    // Sustained burst — don't wait for quiet, index what we have now.
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    void triggerScan(nasPath, "events");
    return;
  }
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void triggerScan(nasPath, "events");
  }, DEBOUNCE_MS);
  debounceTimer.unref?.();
}

async function triggerScan(nasPath: string, source: "events" | "sweep" | "recovery"): Promise<void> {
  if (state.paused || !state.online) return; // will retry when unpaused/online (heartbeat)

  const activeProfile = getActiveJobProfile();
  if (activeProfile !== null) {
    // A scan is already running.
    if (activeProfile === "FULL") {
      // FULL rescan in progress — buffer watcher events and replay as a QUICK
      // scan once the full scan finishes (detected in the heartbeat loop).
      state.needsCatchUp = true;
      return;
    }
    // QUICK or other scan already running — re-check shortly; it will pick up changes.
    if (source === "events") {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void triggerScan(nasPath, source);
      }, DEBOUNCE_MS * 2);
      debounceTimer.unref?.();
    }
    return;
  }

  const hadPending = state.pendingChanges;
  state.pendingChanges = 0;
  state.firstPendingAt = null;
  state.burstAnnounced = false;
  try {
    await startJob({ jobType: "SCAN", profile: "QUICK", nasPath });
    state.lastScanTriggerAt = new Date();
    state.lastSweepAt = Date.now();
    logger.info({ nasPath, source, pendingChanges: hadPending }, "Watcher triggered incremental scan");
  } catch (err) {
    logger.warn({ err, source }, "Watcher failed to start incremental scan");
    state.pendingChanges = hadPending; // keep them for the next attempt
  }
}

// ── Native watcher lifecycle ──────────────────────────────────────────────────

function closeWatcher(): void {
  if (state.fsWatcher) {
    try { state.fsWatcher.close(); } catch { /* already closed */ }
    state.fsWatcher = null;
  }
}

function clearPendingScan(): void {
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  state.pendingChanges = 0;
  state.firstPendingAt = null;
  state.burstAnnounced = false;
}

function openWatcher(nasPath: string): void {
  if (state.eventsUnsupported) {
    state.mechanism = "sweep";
    return;
  }
  try {
    const watcher = fs.watch(nasPath, { recursive: true, persistent: false }, (_event, filename) => {
      onFsEvent(nasPath, filename);
    });
    watcher.on("error", (err) => {
      logger.warn({ err }, "Library watcher errored — will restart automatically");
      handleWatcherFailure(nasPath, err);
    });
    watcher.on("close", () => {
      // Unexpected close (we null the reference before intentional closes).
      if (state.fsWatcher === watcher) handleWatcherFailure(nasPath);
    });
    state.fsWatcher = watcher;
    state.mechanism = "events";
    logger.info({ nasPath }, "Library watcher active (native filesystem events)");
  } catch (err) {
    // Recursive fs.watch unavailable (e.g. some network filesystems) → sweep mode.
    state.eventsUnsupported = true;
    state.mechanism = "sweep";
    logger.info({ err, nasPath }, "Native file watching unavailable — using periodic verification sweeps");
  }
}

function handleWatcherFailure(nasPath: string, err?: Error): void {
  const wasOurs = state.fsWatcher !== null;
  closeWatcher();
  if (!wasOurs) return;
  state.restarts++;
  state.needsCatchUp = true;

  // Network/SMB drives on Windows raise UNKNOWN errors that recur immediately.
  // After a few failures switch permanently to sweep mode instead of looping.
  const code = (err as any)?.code;
  const isNetworkError = code === "UNKNOWN" || code === "ENOSYS";
  if (isNetworkError || state.restarts >= 3) {
    state.eventsUnsupported = true;
    logger.info({ nasPath, code, restarts: state.restarts },
      "Native file watching unavailable on this path — falling back to periodic sweeps");
    return;
  }

  void recordActivity(nasPath, "watcher_restart",
    "Live watching restarted automatically — checking for missed changes…",
    { restarts: state.restarts });
  // Heartbeat will reopen the watcher and run the catch-up scan.
}

// ── Heartbeat: self-healing + pause/offline integration + sweeps ─────────────

let beating = false;

export async function runWatcherHeartbeat(): Promise<void> {
  if (beating) return;
  beating = true;
  try {
    let nasPath: string | null = null;
    let indexingPaused = false;
    let watcherPollIntervalSeconds = DEFAULT_SWEEP_INTERVAL_S;
    try {
      const [row] = await db.select({
        nasPath: appSettingsTable.nasPath,
        indexingPaused: appSettingsTable.indexingPaused,
        watcherPollIntervalSeconds: appSettingsTable.watcherPollIntervalSeconds,
      }).from(appSettingsTable).limit(1);
      nasPath = row?.nasPath ?? null;
      indexingPaused = row?.indexingPaused ?? false;
      watcherPollIntervalSeconds = Math.max(
        MIN_SWEEP_INTERVAL_S,
        row?.watcherPollIntervalSeconds ?? DEFAULT_SWEEP_INTERVAL_S,
      );
    } catch {
      return; // DB not ready yet
    }

    // Update the configurable sweep interval from settings.
    state.sweepIntervalMs = watcherPollIntervalSeconds * 1000;

    state.configured = !!nasPath && nasPath.trim() !== "";
    const wasPaused = state.paused;
    state.paused = indexingPaused;

    if (!state.configured) {
      state.online = false;
      closeWatcher();
      clearPendingScan();
      state.watchedPath = null;
      return;
    }

    const reach = checkNasReachable(nasPath);
    const wasOnline = state.online;
    state.online = reach.online;

    if (!reach.online) {
      // Library offline — stop watching; the library monitor announces the
      // transition and auto-starts the catch-up scan on reconnect.
      closeWatcher();
      return;
    }

    // Library path changed in Settings → watch the new location. Clear any
    // pending debounce so a stale timer can't scan the old path.
    if (state.watchedPath !== reach.path) {
      closeWatcher();
      clearPendingScan();
      state.watchedPath = reach.path;
      state.eventsUnsupported = false;
    }

    if (indexingPaused) {
      // Paused: keep collecting events (cheap) but never trigger scans.
      if (!state.fsWatcher && !state.eventsUnsupported) openWatcher(reach.path);
      return;
    }

    // Just resumed / just came online with pending changes → index them now.
    if ((wasPaused || !wasOnline) && state.pendingChanges > 0) {
      void triggerScan(reach.path, "recovery");
    }

    // M7 conflict guard — on every heartbeat, if needsCatchUp is set and no
    // FULL scan is currently active, fire an immediate QUICK catch-up scan.
    // This is unconditional (not transition-based) so we never miss the replay
    // even when a FULL scan starts and finishes between two heartbeat ticks.
    const activeProfile = getActiveJobProfile();
    if (state.needsCatchUp && activeProfile !== "FULL") {
      state.needsCatchUp = false;
      void triggerScan(reach.path, "recovery");
    }

    // Self-healing: reopen the native watcher if it died.
    if (!state.fsWatcher && !state.eventsUnsupported) {
      openWatcher(reach.path);
      if (state.needsCatchUp) {
        state.needsCatchUp = false;
        void triggerScan(reach.path, "recovery");
      }
    }

    // Periodic sweeps: frequent in sweep mode (configurable, default 60 s),
    // low-frequency safety net in events mode (30 min). A sweep is just a QUICK
    // scan — unchanged files are cheap cache hits and produce no activity noise.
    const sweepInterval = state.mechanism === "events" ? SAFETY_SWEEP_MS : state.sweepIntervalMs;
    if (getActiveJobId() === null && Date.now() - state.lastSweepAt >= sweepInterval) {
      state.lastSweepAt = Date.now();
      void triggerScan(reach.path, "sweep");
    }
  } finally {
    beating = false;
  }
}

export function startLibraryWatcher(): void {
  if (heartbeatTimer) return;
  // Defer the first heartbeat until the UI connects (first authenticated request)
  // or the 30-second fallback fires.  Prevents the initial sweep from competing
  // with the UI for NAS bandwidth before the user sees the first page.
  waitForUiConnected().then(() => {
    if (heartbeatTimer) return; // guard against duplicate calls
    runWatcherHeartbeat().catch(() => {});
    heartbeatTimer = setInterval(() => { runWatcherHeartbeat().catch(() => {}); }, HEARTBEAT_MS);
    heartbeatTimer.unref?.();
  }).catch(() => {});
}
