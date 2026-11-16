import assert from "node:assert/strict";
import test from "node:test";
import { forEachBounded } from "../lib/library-engine/bounded-work.ts";
import { ActiveFileProgressTracker } from "../lib/library-engine/file-progress.ts";

test("bounded work overlaps I/O but never exceeds its concurrency limit", async () => {
  let active = 0;
  let peak = 0;
  const completed: number[] = [];

  await forEachBounded(Array.from({ length: 12 }, (_, index) => index), 4, async (item) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    completed.push(item);
    active--;
  });

  assert.equal(peak, 4);
  assert.equal(completed.length, 12);
  assert.equal(new Set(completed).size, 12);
});

test("bounded work rejects after already-started operations settle", async () => {
  let active = 0;
  let peak = 0;

  await assert.rejects(
    () => forEachBounded([0, 1, 2, 3], 2, async (item) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (item === 0) throw new Error("expected worker failure");
      } finally {
        active--;
      }
    }),
    /expected worker failure/,
  );

  assert.equal(active, 0);
  assert.ok(peak <= 2);
});

test("active file progress reports the oldest live item and clears finished items", () => {
  let now = 100;
  let current: { path: string; startedAt: number } | null = null;
  const tracker = new ActiveFileProgressTracker((next) => { current = next; }, () => now);

  tracker.start("worker-1", "first.jpg");
  now = 200;
  tracker.start("worker-2", "second.jpg");
  assert.deepEqual(current, { path: "first.jpg", startedAt: 100 });

  tracker.finish("worker-1");
  assert.deepEqual(current, { path: "second.jpg", startedAt: 200 });
  tracker.finish("worker-2");
  assert.equal(current, null);
});
