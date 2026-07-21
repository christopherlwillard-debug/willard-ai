/**
 * Unit tests for library-monitor debounce logic.
 *
 * Tests the pure `shouldPauseScan()` helper which encapsulates the rule:
 *   "require 2 consecutive failed checks before pausing an active scan".
 *
 * These tests have zero external dependencies (no DB, no NAS, no mocks).
 *
 * Run with:
 *   node --experimental-strip-types --test src/__tests__/library-monitor-debounce.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldPauseScan } from "../lib/monitor-helpers.ts";

// ── Debounce: single failure is silently forgiven ─────────────────────────────

test("1 failed check (consecutiveFailures=1): does NOT pause an active scan", () => {
  assert.equal(
    shouldPauseScan("online", 1, 42),
    false,
    "A single failed check must not pause the scan (debounce threshold is 2)",
  );
});

test("1 failed check when already offline: does NOT re-pause (already handled)", () => {
  assert.equal(
    shouldPauseScan("offline", 1, 42),
    false,
    "Already-offline state must not trigger a second pause",
  );
});

test("1 failed check when unconfigured: does NOT pause", () => {
  assert.equal(
    shouldPauseScan("unconfigured", 1, 42),
    false,
  );
});

// ── Debounce: 2 consecutive failures trigger the pause ────────────────────────

test("2 consecutive failed checks (consecutiveFailures=2): pauses active scan", () => {
  assert.equal(
    shouldPauseScan("online", 2, 42),
    true,
    "Two consecutive failures must pause the scan",
  );
});

test("3+ consecutive failures (consecutiveFailures=3): also pauses (debounce already fired)", () => {
  assert.equal(
    shouldPauseScan("online", 3, 99),
    true,
  );
});

// ── No active job → never pauses ─────────────────────────────────────────────

test("2 failures but no active job: does NOT call requestPause (nothing to pause)", () => {
  assert.equal(
    shouldPauseScan("online", 2, null),
    false,
    "Without an active job there is nothing to pause — must return false",
  );
});

test("1 failure and no active job: does NOT pause", () => {
  assert.equal(shouldPauseScan("online", 1, null), false);
});

// ── Counter reset semantics ───────────────────────────────────────────────────
// The counter is reset to 0 on any successful check. After a reset, the next
// single failure is forgiven again (consecutiveFailures becomes 1, < 2 → no pause).

test("after counter reset: a single failure (consecutiveFailures=1) is forgiven again", () => {
  // Simulate: success resets to 0, then one more failure → count is now 1
  assert.equal(
    shouldPauseScan("online", 1, 42),
    false,
    "After a reset the first new failure must not pause — debounce restarts",
  );
});

test("after counter reset: two new failures (consecutiveFailures=2) pause again", () => {
  assert.equal(
    shouldPauseScan("online", 2, 42),
    true,
    "After a reset, two consecutive new failures must pause again",
  );
});

// ── Already-offline branch ────────────────────────────────────────────────────
// Once offline, further failures keep incrementing the counter, but the pause
// transition has already happened — no second pause should be issued.

test("already offline + 2 failures: does NOT re-pause (state machine already transitioned)", () => {
  assert.equal(
    shouldPauseScan("offline", 2, 42),
    false,
  );
});

test("already offline + 10 failures: still no re-pause", () => {
  assert.equal(
    shouldPauseScan("offline", 10, 42),
    false,
  );
});
