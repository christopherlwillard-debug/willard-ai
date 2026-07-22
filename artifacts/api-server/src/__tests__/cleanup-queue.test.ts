/**
 * Unit tests for cleanup-queue persistence logic.
 *
 * The Cleanup Queue is stored as JSON in the browser's localStorage under
 * the key "willard-cleanup-queue-v1". This test verifies the serialization
 * contract that makes persistence across page reloads safe:
 *
 *   1. Empty store → readQueue returns []
 *   2. Written entry round-trips through JSON correctly
 *   3. Multiple entries accumulate in insertion order
 *   4. Second write for the same groupHash replaces the first entry
 *      (so staging a group twice doesn't create a duplicate)
 *   5. Corrupt JSON in the store falls back to [] without throwing
 *   6. Clearing the queue removes all entries
 *   7. Each required CleanupQueueEntry field is present and correctly typed
 *
 * Run with:
 *   node --experimental-strip-types --test \
 *     artifacts/api-server/src/__tests__/cleanup-queue.test.ts
 */

import { test, describe } from "node:test";
import * as assert from "node:assert/strict";

// ─── Simulate browser localStorage with an in-memory Map ─────────────────────
//
// This mirrors exactly what cleanup.tsx does in the browser.  Any change to the
// readQueue / writeQueue functions in cleanup.tsx must keep this contract.

const QUEUE_KEY = "willard-cleanup-queue-v1";

type CleanupQueueEntry = {
  groupHash: string;
  keepFileId: number;
  deleteFileIds: number[];
  keepFilename: string;
  keepFolder: string;
  deleteFilenames: string[];
  totalSavedBytes: number;
  reason: string;
  evidence: string;
  addedAt: string;
};

function makeStorage(): { getItem(k: string): string | null; setItem(k: string, v: string): void } {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
  };
}

function makeQueue(storage: ReturnType<typeof makeStorage>) {
  function readQueue(): CleanupQueueEntry[] {
    try {
      return JSON.parse(storage.getItem(QUEUE_KEY) ?? "[]") as CleanupQueueEntry[];
    } catch {
      return [];
    }
  }
  function writeQueue(q: CleanupQueueEntry[]): void {
    storage.setItem(QUEUE_KEY, JSON.stringify(q));
  }
  function stageEntry(entry: CleanupQueueEntry): void {
    // Mirrors the frontend handleStage: replace existing entry for same groupHash
    const without = readQueue().filter((e) => e.groupHash !== entry.groupHash);
    writeQueue([...without, entry]);
  }
  function removeEntry(groupHash: string): void {
    writeQueue(readQueue().filter((e) => e.groupHash !== groupHash));
  }
  function clearQueue(): void {
    writeQueue([]);
  }
  return { readQueue, writeQueue, stageEntry, removeEntry, clearQueue };
}

// ─── Fixture factory ──────────────────────────────────────────────────────────

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

describe("cleanup queue persistence (simulated localStorage)", { concurrency: false }, () => {
  // ── 1. Empty store ──────────────────────────────────────────────────────────

  test("readQueue returns [] when storage is empty", () => {
    const storage = makeStorage();
    const { readQueue } = makeQueue(storage);
    assert.deepEqual(readQueue(), [], "Empty storage must yield an empty queue");
  });

  // ── 2. Single entry round-trips through JSON ────────────────────────────────

  test("staged entry survives a simulated page reload (JSON round-trip)", () => {
    const storage = makeStorage();
    const { stageEntry, readQueue } = makeQueue(storage);

    const entry = makeEntry("hash-aabbcc");
    stageEntry(entry);

    // Simulate page reload: create a fresh queue bound to the SAME storage
    const { readQueue: readQueue2 } = makeQueue(storage);
    const persisted = readQueue2();

    assert.strictEqual(persisted.length, 1, "Queue must have 1 entry after reload");
    assert.deepEqual(persisted[0], entry, "Persisted entry must be identical to the staged entry");
  });

  // ── 3. Multiple entries accumulate in insertion order ──────────────────────

  test("staging multiple groups accumulates entries in order", () => {
    const storage = makeStorage();
    const { stageEntry, readQueue } = makeQueue(storage);

    const a = makeEntry("hash-aaa", { keepFileId: 10, deleteFileIds: [11] });
    const b = makeEntry("hash-bbb", { keepFileId: 20, deleteFileIds: [21] });
    const c = makeEntry("hash-ccc", { keepFileId: 30, deleteFileIds: [31] });

    stageEntry(a);
    stageEntry(b);
    stageEntry(c);

    const q = readQueue();
    assert.strictEqual(q.length, 3, "Queue should contain 3 entries");
    assert.strictEqual(q[0].groupHash, "hash-aaa");
    assert.strictEqual(q[1].groupHash, "hash-bbb");
    assert.strictEqual(q[2].groupHash, "hash-ccc");
  });

  // ── 4. Staging same groupHash twice replaces the earlier entry ─────────────

  test("staging the same groupHash twice replaces, not duplicates, the entry", () => {
    const storage = makeStorage();
    const { stageEntry, readQueue } = makeQueue(storage);

    const first  = makeEntry("hash-ddd", { keepFileId: 1, deleteFileIds: [2], reason: "Oldest file — likely original camera import" });
    const second = makeEntry("hash-ddd", { keepFileId: 2, deleteFileIds: [1], reason: "Manual selection" });

    stageEntry(first);
    stageEntry(second);

    const q = readQueue();
    assert.strictEqual(q.length, 1, "Staging same group twice must produce exactly 1 entry");
    assert.strictEqual(q[0].keepFileId, 2,              "Updated entry must reflect the second stage decision");
    assert.strictEqual(q[0].reason, "Manual selection", "Reason must be from the second stage");
  });

  // ── 5. Corrupt JSON falls back to [] ──────────────────────────────────────

  test("corrupt JSON in storage falls back to an empty queue without throwing", () => {
    const storage = makeStorage();
    storage.setItem(QUEUE_KEY, "NOT_VALID_JSON{{{{");
    const { readQueue } = makeQueue(storage);

    let result: CleanupQueueEntry[];
    assert.doesNotThrow(() => { result = readQueue(); });
    assert.deepEqual(result!, [], "Corrupt storage must yield an empty queue");
  });

  // ── 6. removeEntry removes only the matching groupHash ────────────────────

  test("removeEntry removes only the specified group and leaves others intact", () => {
    const storage = makeStorage();
    const { stageEntry, removeEntry, readQueue } = makeQueue(storage);

    stageEntry(makeEntry("hash-eee"));
    stageEntry(makeEntry("hash-fff"));
    stageEntry(makeEntry("hash-ggg"));

    removeEntry("hash-fff");

    const q = readQueue();
    assert.strictEqual(q.length, 2, "Should have 2 entries after removing one");
    assert.ok(q.every((e) => e.groupHash !== "hash-fff"), "Removed group must not appear");
    assert.ok(q.some((e) => e.groupHash === "hash-eee"), "hash-eee must still be in queue");
    assert.ok(q.some((e) => e.groupHash === "hash-ggg"), "hash-ggg must still be in queue");
  });

  // ── 7. clearQueue empties the store ───────────────────────────────────────

  test("clearQueue removes all entries", () => {
    const storage = makeStorage();
    const { stageEntry, clearQueue, readQueue } = makeQueue(storage);

    stageEntry(makeEntry("hash-hhh"));
    stageEntry(makeEntry("hash-iii"));
    clearQueue();

    assert.deepEqual(readQueue(), [], "Queue must be empty after clearQueue");
  });

  // ── 8. Total saved bytes accumulate correctly ──────────────────────────────

  test("total saved bytes from multiple entries sum correctly", () => {
    const storage = makeStorage();
    const { stageEntry, readQueue } = makeQueue(storage);

    stageEntry(makeEntry("hash-jjj", { totalSavedBytes: 1_000_000 }));
    stageEntry(makeEntry("hash-kkk", { totalSavedBytes: 2_500_000 }));
    stageEntry(makeEntry("hash-lll", { totalSavedBytes: 500_000 }));

    const q = readQueue();
    const total = q.reduce((sum, e) => sum + e.totalSavedBytes, 0);
    assert.strictEqual(total, 4_000_000, "Sum of totalSavedBytes across entries must be correct");
  });

  // ── 9. All required fields are present and correctly typed ────────────────

  test("CleanupQueueEntry has all required fields with correct types after round-trip", () => {
    const storage = makeStorage();
    const { stageEntry, readQueue } = makeQueue(storage);

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
    stageEntry(entry);

    const [q] = readQueue();
    assert.strictEqual(typeof q.groupHash,       "string",  "groupHash must be string");
    assert.strictEqual(typeof q.keepFileId,       "number",  "keepFileId must be number");
    assert.ok(Array.isArray(q.deleteFileIds),               "deleteFileIds must be array");
    assert.ok(q.deleteFileIds.every((id: unknown) => typeof id === "number"), "deleteFileIds must be number[]");
    assert.strictEqual(typeof q.keepFilename,     "string",  "keepFilename must be string");
    assert.strictEqual(typeof q.keepFolder,       "string",  "keepFolder must be string");
    assert.ok(Array.isArray(q.deleteFilenames),             "deleteFilenames must be array");
    assert.strictEqual(typeof q.totalSavedBytes,  "number",  "totalSavedBytes must be number");
    assert.strictEqual(typeof q.reason,           "string",  "reason must be string");
    assert.strictEqual(typeof q.evidence,         "string",  "evidence must be string");
    assert.strictEqual(typeof q.addedAt,          "string",  "addedAt must be string");

    // addedAt must be a parseable ISO-8601 timestamp
    const parsed = new Date(q.addedAt);
    assert.ok(!isNaN(parsed.getTime()), `addedAt "${q.addedAt}" must be a valid ISO-8601 timestamp`);
  });
});
