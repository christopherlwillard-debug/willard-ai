import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://shutdown-test.invalid/willard";

const { createShutdownCoordinator } = await import("../lib/shutdown.ts");

function dependencies(events: string[], options: { hangingStep?: string } = {}) {
  const step = (name: string) => async () => {
    events.push(`${name}:start`);
    if (options.hangingStep === name) await new Promise<void>(() => {});
    events.push(`${name}:done`);
  };
  return {
    stopLibraryMonitor: step("monitor"),
    stopLibraryBackupCoordinator: step("backup"),
    stopLibraryWatcher: step("watcher"),
    stopAiEnrichment: step("ai"),
    stopFaceRecognition: step("face"),
    stopThumbnailReconciliation: step("reconcile"),
    stopLibraryJobs: step("jobs"),
    stopActiveConversionJobs: step("conversions"),
    closeHttpServer: async () => { events.push("http"); },
    closePool: async () => { events.push("pool"); },
  };
}

test("shutdown drains only this instance's conversion requests and never cancels remote jobs", async () => {
  const source = readFileSync(new URL("../lib/shutdown.ts", import.meta.url), "utf8");
  const optimize = readFileSync(new URL("../routes/optimize.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /db\.update\(organizationJobsTable\)/);
  assert.doesNotMatch(source, /db\.update\(conversionJobsTable\)/);
  assert.match(source, /dependencies\.stopActiveConversionJobs\(\)/);
  assert.match(optimize, /const activeConversionJobIds = new Map<number, number>\(\)/);
  assert.match(optimize, /activeConversionJobIds\.set\(id, \(activeConversionJobIds\.get\(id\) \?\? 0\) \+ 1\)/);
  assert.match(optimize, /activeConversionJobIds\.delete\(id\)/);
  assert.match(optimize, /isShuttingDown\(\)/);
  assert.match(optimize, /export async function stopActiveConversionJobs/);
});

test("shutdown is idempotent and closes resources in dependency order", async () => {
  const events: string[] = [];
  const shutdown = createShutdownCoordinator(dependencies(events), 100);
  const first = shutdown(null);
  const second = shutdown(null);

  assert.strictEqual(first, second);
  await first;

  assert.strictEqual(events.at(-2), "http");
  assert.strictEqual(events.at(-1), "pool");
  assert.ok(events.indexOf("jobs:done") < events.indexOf("http"));
  assert.ok(events.indexOf("conversions:done") < events.indexOf("http"));
  assert.ok(events.indexOf("monitor:done") < events.indexOf("jobs:start"));
  assert.ok(events.indexOf("reconcile:done") < events.indexOf("jobs:start"));
});

test("a stuck shutdown step is bounded and later resources still close", async () => {
  const events: string[] = [];
  const shutdown = createShutdownCoordinator(
    dependencies(events, { hangingStep: "watcher" }),
    5,
  );

  await shutdown(null);
  assert.deepEqual(events.slice(-3), ["jobs:done", "http", "pool"]);
});