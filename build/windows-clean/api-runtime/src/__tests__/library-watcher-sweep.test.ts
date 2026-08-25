/**
 * Verifies the fallback used by SMB/NAS paths where recursive fs.watch is not
 * available. The real NAS integration test is represented here by the same
 * platform signal Node exposes: fs.watch throws while reachability succeeds.
 *
 * Run with:
 *   node --experimental-test-module-mocks --experimental-strip-types \
 *     src/__tests__/library-watcher-sweep.test.ts
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const configuredPath = "/mnt/nas/photos";
let now = 1_000_000;
const startedScans: Array<{ nasPath: string; profile: string }> = [];

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
        watcherPollIntervalSeconds: 10,
      }],
    }),
  }),
};

mock.method(Date, "now", () => now);
mock.module("fs", {
  namedExports: {
    watch: () => {
      const error = new Error("recursive watching is unavailable on this network filesystem");
      (error as Error & { code?: string }).code = "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM";
      throw error;
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
    startJob: async (input: { nasPath: string; profile: string }) => {
      startedScans.push(input);
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

test("falls back to sweep mode and scans at the configured NAS interval", async () => {
  await runWatcherHeartbeat();

  let snapshot = getWatcherSnapshot();
  assert.equal(snapshot.state, "watching");
  assert.equal(snapshot.mechanism, "sweep");
  assert.equal(snapshot.sweepIntervalSeconds, 10);
  assert.equal(snapshot.watchedPath, configuredPath);
  assert.deepEqual(startedScans, []);

  now += 10_000;
  await runWatcherHeartbeat();
  await new Promise((resolve) => setImmediate(resolve));

  snapshot = getWatcherSnapshot();
  assert.deepEqual(startedScans, [{ jobType: "SCAN", nasPath: configuredPath, profile: "QUICK" }]);
  assert.ok(snapshot.lastScanTriggerAt, "sweep should record when its scan was triggered");
});