/**
 * Regression test for switching the configured library while watcher events
 * are waiting for their debounce window.
 *
 * Run with:
 *   node --experimental-test-module-mocks --experimental-strip-types \
 *     src/__tests__/library-watcher-path-switch.test.ts
 */
import { EventEmitter } from "node:events";
import { test, mock } from "node:test";
import assert from "node:assert/strict";

type WatchCallback = (event: string, filename: string) => void;

const oldPath = "/library/old";
const newPath = "/library/new";
let configuredPath = oldPath;
const startedScans: string[] = [];
const watchers: Array<EventEmitter & { close(): void }> = [];

const appSettingsTable = {
  nasPath: Symbol("nasPath"),
  indexingPaused: Symbol("indexingPaused"),
  watcherPollIntervalSeconds: Symbol("watcherPollIntervalSeconds"),
};

const db = {
  select: () => ({
    from: () => ({
      limit: async () => [{
        nasPath: configuredPath,
        indexingPaused: false,
        watcherPollIntervalSeconds: 300,
      }],
    }),
  }),
};

mock.module("fs", {
  namedExports: {
    watch: (_path: string, _options: unknown, callback: WatchCallback) => {
      const watcher = new EventEmitter() as EventEmitter & { close(): void };
      watcher.close = () => {};
      watchers.push(watcher);
      (watcher as EventEmitter & { callback?: WatchCallback }).callback = callback;
      return watcher;
    },
  },
});
mock.module("@workspace/db", { namedExports: { db, appSettingsTable } });
mock.module("../lib/nas-storage.ts", {
  namedExports: {
    checkNasReachableAsync: async (nasPath: string) => ({ online: true, path: nasPath }),
  },
});
mock.module("../lib/library-engine/index.ts", {
  namedExports: {
    getActiveJobId: () => null,
    getActiveJobProfile: () => null,
    invalidateDirMtimeCache: () => {},
    startJob: async ({ nasPath }: { nasPath: string }) => {
      startedScans.push(nasPath);
      return { jobId: startedScans.length, alreadyRunning: false };
    },
    waitForUiConnected: async () => {},
  },
});
mock.module("../lib/library-activity.ts", {
  namedExports: { recordActivity: async () => {} },
});
mock.module("../lib/logger.ts", {
  namedExports: { logger: { info() {}, warn() {} } },
});

const { getWatcherSnapshot, runWatcherHeartbeat } =
  await import("../lib/library-watcher.ts");

function emitWatcherEvent(watcher: EventEmitter): void {
  const callback = (watcher as EventEmitter & { callback?: WatchCallback }).callback;
  assert.ok(callback, "test watcher should retain its callback");
  callback("change", "photo.jpg");
}

test("switching library path cancels queued old-path scans and watches only the new path", async () => {
  startedScans.length = 0;
  watchers.length = 0;
  configuredPath = oldPath;

  await runWatcherHeartbeat();
  assert.equal(watchers.length, 1);
  emitWatcherEvent(watchers[0]);

  // Settings changes before the 2-second debounce callback fires.
  configuredPath = newPath;
  await runWatcherHeartbeat();

  await new Promise((resolve) => setTimeout(resolve, 2_200));
  assert.deepEqual(startedScans, [], "the old path must not be scanned after switching");

  const snapshot = getWatcherSnapshot();
  assert.equal(snapshot.state, "watching");
  assert.equal(snapshot.watchedPath, newPath);
  assert.equal(snapshot.nextSweepAt, null, "events mode must not expose a sweep countdown");

  // Confirm the replacement watcher is live and uses the new path.
  assert.equal(watchers.length, 2);
  emitWatcherEvent(watchers[1]);
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  assert.deepEqual(startedScans, [newPath]);
});