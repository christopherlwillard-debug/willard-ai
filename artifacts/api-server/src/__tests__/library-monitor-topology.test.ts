/**
 * Exercises the monitor's real transition policy with a mocked filesystem
 * probe: transient failure, confirmed offline, reconnect, and a second
 * transition with a scan job. A Windows/NAS runner still needs the manual
 * topology probe in scripts/windows/check-nas-topology.ps1 for actual ACL and
 * mapped-drive semantics.
 *
 * Run with:
 *   node --experimental-test-module-mocks --experimental-strip-types \
 *     src/__tests__/library-monitor-topology.test.ts
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const nasPath = "/mnt/nas/photos";
let probeResults: Array<{ online: boolean; path: string; message: string }> = [];
let activeType: "THUMBNAILS" | "SCAN" = "THUMBNAILS";
const cancelled: Array<{ id: number; reason: string }> = [];
const paused: number[] = [];
const started: Array<{ jobType: string; profile: string; nasPath: string }> = [];

const appSettingsTable = {
  nasPath: Symbol("nasPath"),
  indexingPaused: Symbol("indexingPaused"),
  lastScanAt: Symbol("lastScanAt"),
};

const db = {
  select: () => ({
    from: () => ({
      limit: async () => [{
        nasPath,
        indexingPaused: false,
        lastScanAt: null,
      }],
    }),
  }),
};

mock.module("@workspace/db", { namedExports: { db, appSettingsTable } });
mock.module("../lib/nas-storage.ts", {
  namedExports: {
    checkNasReachableAsync: async () =>
      probeResults.shift() ?? { online: true, path: nasPath, message: "Online" },
  },
});
mock.module("../lib/library-engine/index.ts", {
  namedExports: {
    getActiveJobId: () => 42,
    getActiveJobType: () => activeType,
    requestPause: (id: number) => { paused.push(id); return true; },
    requestCancel: (id: number, reason: string) => {
      cancelled.push({ id, reason });
      return true;
    },
    startJob: async (input: { jobType: string; profile: string; nasPath: string }) => {
      started.push(input);
      return { jobId: started.length, alreadyRunning: false };
    },
  },
});
mock.module("../lib/library-activity.ts", {
  namedExports: { recordActivity: async () => {} },
});
mock.module("../lib/logger.ts", {
  namedExports: { logger: { info() {}, warn() {} } },
});

const { getLibraryHealthSnapshot, runLibraryCheck } =
  await import("../lib/library-monitor.ts");

function result(online: boolean): { online: boolean; path: string; message: string } {
  return {
    online,
    path: nasPath,
    message: online ? "Online" : "Drive is not responding",
  };
}

test("debounces NAS loss, cancels unsafe derived work, and recovers with a catch-up scan", async () => {
  probeResults = [result(true), result(false), result(false), result(true)];
  activeType = "THUMBNAILS";
  cancelled.length = 0;
  paused.length = 0;
  started.length = 0;

  let snapshot = await runLibraryCheck();
  assert.equal(snapshot.status, "online");

  snapshot = await runLibraryCheck();
  assert.equal(snapshot.status, "online", "one transient failure is forgiven");
  assert.deepEqual(cancelled, []);

  snapshot = await runLibraryCheck();
  assert.equal(snapshot.status, "offline");
  assert.deepEqual(cancelled, [{ id: 42, reason: "NAS_OFFLINE" }]);
  assert.deepEqual(paused, []);

  snapshot = await runLibraryCheck();
  assert.equal(snapshot.status, "online");
  assert.equal(snapshot.reconnectScanJobId, 1);
  assert.deepEqual(started, [{
    jobType: "SCAN",
    profile: "QUICK",
    nasPath,
  }]);

  activeType = "SCAN";
  probeResults = [result(false), result(false), result(true)];
  await runLibraryCheck();
  await runLibraryCheck();
  assert.deepEqual(paused, [42], "scan work is paused rather than cancelled");
  snapshot = await runLibraryCheck();
  assert.equal(snapshot.status, "online");
  assert.equal(snapshot.reconnectScanJobId, 2);
});