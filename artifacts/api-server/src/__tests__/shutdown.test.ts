import assert from "node:assert/strict";
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
    stopLibraryWatcher: step("watcher"),
    stopAiEnrichment: step("ai"),
    stopFaceRecognition: step("face"),
    stopThumbnailReconciliation: step("reconcile"),
    stopLibraryJobs: step("jobs"),
    checkpointExternalJobs: step("checkpoint"),
    closeHttpServer: async () => { events.push("http"); },
    closePool: async () => { events.push("pool"); },
  };
}

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
  assert.ok(events.indexOf("checkpoint:done") < events.indexOf("http"));
  assert.ok(events.indexOf("monitor:done") < events.indexOf("checkpoint:start"));
  assert.ok(events.indexOf("reconcile:done") < events.indexOf("checkpoint:start"));
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