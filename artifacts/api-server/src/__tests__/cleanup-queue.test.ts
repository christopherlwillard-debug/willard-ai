/**
 * Unit tests for cleanup-queue helpers (artifacts/willard-ai/src/lib/cleanup-queue.ts).
 *
 * Imports the ACTUAL shared module rather than re-implementing its logic, so
 * test drift is impossible — any change to readQueue/writeQueue/stageEntry is
 * immediately reflected here.
 *
 * A simple in-memory Map stands in for browser localStorage (StorageLike
 * interface), keeping the tests dependency-free and runnable in Node.js.
 *
 * Tests cover the serialization contract that makes queue persistence across
 * page reloads safe:
 *
 *   1. Empty store → readQueue returns []
 *   2. Written entry round-trips through JSON correctly ("page reload" = new read)
 *   3. Multiple entries accumulate in insertion order
 *   4. stageEntry for the same groupHash replaces, not duplicates, the entry
 *   5. Corrupt JSON in the store falls back to [] without throwing
 *   6. removeEntry removes only the matching groupHash, leaves others intact
 *   7. clearQueue empties the store
 *   8. totalSavedBytes sums correctly across entries
 *   9. All required CleanupQueueEntry fields round-trip with correct types
 *
 * Run with:
 *   node --experimental-strip-types --test \
 *     artifacts/api-server/src/__tests__/cleanup-queue.test.ts
 */

import { test, describe } from "node:test";
import * as assert from "node:assert/strict";

// Import the REAL shared module (not a reimplementation)
import {
  readQueue,
  writeQueue,
  stageEntry,
  removeEntry,
  clearQueue,
  QUEUE_KEY,
  type CleanupQueueEntry,
  type StorageLike,
} from "../../../willard-ai/src/lib/cleanup-queue.ts";

// ─── Test storage factory ──────────────────────────────────────────────────────
//
// Creates a fresh in-memory StorageLike for each test so state doesn't leak.

function makeStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
  };
}

// ─── Entry fixture ─────────────────────────────────────────────────────────────

function makeEntry(groupHash: string, overrides: Partial<CleanupQueueEntry> = {}): CleanupQueueEntry {
  return {
    groupHash,
    keepFileId:      1,
    deleteFileIds:   [2],
    keepFilename:    "IMG_001.jpg",
    keepFolder:      "/NAS/Photos/Camera",
    deleteFilenames: ["IMG_001_copy.jpg"],
    totalSavedBytes: 1_048_576,
    reason:          "Oldest file — likely original camera import",
    evidence:        "Created 2018-06-02",
    addedAt:         new Date().toISOString(),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("cleanup queue persistence (real shared module with mock localStorage)", { concurrency: false }, () => {

  // ── 1. Empty store ──────────────────────────────────────────────────────────

  test("readQueue returns [] when storage is empty", () => {
    assert.deepEqual(readQueue(makeStorage()), []);
  });

  // ── 2. Single entry round-trips through JSON ("page reload") ───────────────

  test("staged entry survives a simulated page reload (JSON round-trip)", () => {
    const storage = makeStorage();
    const entry = makeEntry("hash-aabbcc");
    writeQueue([entry], storage);

    // Simulate reload: new call to readQueue on the same storage
    const persisted = readQueue(storage);
    assert.strictEqual(persisted.length, 1, "Queue must have 1 entry after reload");
    assert.deepEqual(persisted[0], entry, "Persisted entry must be identical to the written entry");
  });

  // ── 3. Multiple entries accumulate in insertion order ──────────────────────

  test("staging multiple groups accumulates entries in order", () => {
    const storage = makeStorage();
    const a = makeEntry("hash-aaa", { keepFileId: 10, deleteFileIds: [11] });
    const b = makeEntry("hash-bbb", { keepFileId: 20, deleteFileIds: [21] });
    const c = makeEntry("hash-ccc", { keepFileId: 30, deleteFileIds: [31] });
    stageEntry(a, storage);
    stageEntry(b, storage);
    stageEntry(c, storage);

    const q = readQueue(storage);
    assert.strictEqual(q.length, 3);
    assert.strictEqual(q[0].groupHash, "hash-aaa");
    assert.strictEqual(q[1].groupHash, "hash-bbb");
    assert.strictEqual(q[2].groupHash, "hash-ccc");
  });

  // ── 4. stageEntry for same groupHash replaces, not duplicates, entry ───────

  test("staging the same groupHash twice replaces the earlier entry", () => {
    const storage = makeStorage();
    const first  = makeEntry("hash-ddd", { keepFileId: 1, reason: "Oldest file — likely original camera import" });
    const second = makeEntry("hash-ddd", { keepFileId: 2, reason: "Manual selection" });
    stageEntry(first,  storage);
    stageEntry(second, storage);

    const q = readQueue(storage);
    assert.strictEqual(q.length, 1, "Must have exactly 1 entry");
    assert.strictEqual(q[0].keepFileId, 2);
    assert.strictEqual(q[0].reason, "Manual selection");
  });

  // ── 5. Corrupt JSON falls back to [] without throwing ────────────────────

  test("corrupt JSON in storage falls back to an empty queue", () => {
    const storage = makeStorage();
    storage.setItem(QUEUE_KEY, "NOT_VALID_JSON{{{{");

    let result: CleanupQueueEntry[];
    assert.doesNotThrow(() => { result = readQueue(storage); });
    assert.deepEqual(result!, []);
  });

  // ── 6. removeEntry removes only the specified groupHash ───────────────────

  test("removeEntry removes only the specified group and leaves others intact", () => {
    const storage = makeStorage();
    stageEntry(makeEntry("hash-eee"), storage);
    stageEntry(makeEntry("hash-fff"), storage);
    stageEntry(makeEntry("hash-ggg"), storage);
    removeEntry("hash-fff", storage);

    const q = readQueue(storage);
    assert.strictEqual(q.length, 2);
    assert.ok(q.every((e) => e.groupHash !== "hash-fff"), "Removed group must not appear");
    assert.ok(q.some((e) => e.groupHash === "hash-eee"));
    assert.ok(q.some((e) => e.groupHash === "hash-ggg"));
  });

  // ── 7. clearQueue empties the store ───────────────────────────────────────

  test("clearQueue removes all entries", () => {
    const storage = makeStorage();
    stageEntry(makeEntry("hash-hhh"), storage);
    stageEntry(makeEntry("hash-iii"), storage);
    clearQueue(storage);
    assert.deepEqual(readQueue(storage), []);
  });

  // ── 8. Total saved bytes sum correctly ────────────────────────────────────

  test("total saved bytes from multiple entries sum correctly", () => {
    const storage = makeStorage();
    stageEntry(makeEntry("hash-jjj", { totalSavedBytes: 1_000_000 }), storage);
    stageEntry(makeEntry("hash-kkk", { totalSavedBytes: 2_500_000 }), storage);
    stageEntry(makeEntry("hash-lll", { totalSavedBytes: 500_000 }),   storage);

    const total = readQueue(storage).reduce((sum, e) => sum + e.totalSavedBytes, 0);
    assert.strictEqual(total, 4_000_000);
  });

  // ── 9. All required fields round-trip with correct types ──────────────────

  test("CleanupQueueEntry has all required fields with correct types after round-trip", () => {
    const storage = makeStorage();
    const entry = makeEntry("hash-mmm", {
      keepFileId:      99,
      deleteFileIds:   [100, 101],
      keepFilename:    "holiday.cr2",
      keepFolder:      "/NAS/Camera/2024",
      deleteFilenames: ["holiday_copy.cr2", "holiday_backup.cr2"],
      totalSavedBytes: 52_428_800,
      reason:          "Highest resolution — maximum detail preserved",
      evidence:        "6000 × 4000",
    });
    writeQueue([entry], storage);

    const [q] = readQueue(storage);
    assert.strictEqual(typeof q.groupHash,       "string");
    assert.strictEqual(typeof q.keepFileId,       "number");
    assert.ok(Array.isArray(q.deleteFileIds));
    assert.ok(q.deleteFileIds.every((id: unknown) => typeof id === "number"));
    assert.strictEqual(typeof q.keepFilename,     "string");
    assert.strictEqual(typeof q.keepFolder,       "string");
    assert.ok(Array.isArray(q.deleteFilenames));
    assert.strictEqual(typeof q.totalSavedBytes,  "number");
    assert.strictEqual(typeof q.reason,           "string");
    assert.strictEqual(typeof q.evidence,         "string");
    assert.strictEqual(typeof q.addedAt,          "string");

    // addedAt must parse as a valid ISO-8601 timestamp
    assert.ok(!isNaN(new Date(q.addedAt).getTime()), `addedAt "${q.addedAt}" must be valid ISO-8601`);
  });
});
