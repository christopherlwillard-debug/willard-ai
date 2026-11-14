import assert from "node:assert/strict";
import test from "node:test";
import {
  createMediaHealthWorkerManager,
  type MediaHealthJobStore,
  type MediaHealthOutcome,
  type MediaHealthProgress,
} from "../lib/media-health-worker.ts";

type Event =
  | { kind: "progress"; progress: MediaHealthProgress }
  | { kind: "complete"; outcome: MediaHealthOutcome }
  | { kind: "fail"; message: string }
  | { kind: "pause" };

function makeStore(overrides: Partial<MediaHealthJobStore> = {}) {
  const events: Event[] = [];
  const store: MediaHealthJobStore = {
    owns: async () => true,
    progress: async (_id, _token, progress) => {
      events.push({ kind: "progress", progress });
      return true;
    },
    complete: async (_id, _token, outcome) => {
      events.push({ kind: "complete", outcome });
      return true;
    },
    fail: async (_id, _token, message) => {
      events.push({ kind: "fail", message });
      return true;
    },
    pause: async () => {
      events.push({ kind: "pause" });
      return true;
    },
    ...overrides,
  };
  return { store, events };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("Timed out waiting for the health worker state.");
}

test("health work runs after scheduling, persists progress, and completes independently", async () => {
  const { store, events } = makeStore();
  const manager = createMediaHealthWorkerManager(store);
  let started = false;
  let followUpRan = false;

  assert.equal(manager.schedule(1, "worker-token", async (context) => {
    started = true;
    await context.reportProgress({
      phase: "index",
      processed: 250,
      total: 1_000,
      message: "Checked one page",
    });
    return { summary: { count: 1_000 } };
  }, async () => {
    followUpRan = true;
  }), true);

  assert.equal(started, false, "scheduling must return before the worker begins");
  await waitFor(() => events.some((event) => event.kind === "complete"));
  assert.equal(manager.activeCount, 0);
  assert.equal(followUpRan, true);
  assert.deepEqual(events.map((event) => event.kind), ["progress", "complete"]);
});

test("health work pauses at an ownership checkpoint during shutdown", async () => {
  const { store, events } = makeStore();
  const manager = createMediaHealthWorkerManager(store);
  let announceStarted!: () => void;
  let releaseWorker!: () => void;
  const started = new Promise<void>((resolve) => { announceStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseWorker = resolve; });

  assert.equal(manager.schedule(2, "worker-token", async (context) => {
    announceStarted();
    await blocked;
    await context.assertOwned();
    return { summary: {} };
  }), true);

  await started;
  const stopping = manager.stopAll();
  releaseWorker();
  await stopping;
  assert.equal(events.some((event) => event.kind === "pause"), true);
  assert.equal(events.some((event) => event.kind === "complete"), false);
  assert.equal(manager.activeCount, 0);
});

test("health work persists runner failures instead of reporting success", async () => {
  const { store, events } = makeStore();
  const manager = createMediaHealthWorkerManager(store);
  manager.schedule(3, "worker-token", async () => {
    throw new Error("NAS read failed");
  });

  await waitFor(() => events.some((event) => event.kind === "fail"));
  const failure = events.find((event): event is Extract<Event, { kind: "fail" }> => event.kind === "fail");
  assert.equal(failure?.message, "NAS read failed");
  assert.equal(events.some((event) => event.kind === "complete"), false);
});

test("health work stops when its durable owner token is replaced", async () => {
  let ownershipChecks = 0;
  const { store, events } = makeStore({
    owns: async () => ++ownershipChecks === 1,
  });
  const manager = createMediaHealthWorkerManager(store);
  manager.schedule(4, "old-token", async (context) => {
    await context.assertOwned();
    return { summary: {} };
  });

  await waitFor(() => manager.activeCount === 0);
  assert.equal(events.some((event) => event.kind === "complete"), false);
  assert.equal(events.some((event) => event.kind === "fail"), false);
});
