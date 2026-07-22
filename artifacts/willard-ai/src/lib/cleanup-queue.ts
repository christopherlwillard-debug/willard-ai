/**
 * Shared cleanup-queue helpers.
 *
 * Pure functions that operate on a StorageLike surface (browser localStorage
 * in production, a simple in-memory map in unit tests).  Pass the storage
 * explicitly so callers are not coupled to the global `localStorage` object,
 * which makes every function independently testable without a DOM.
 *
 * Usage in the browser:
 *   import { readQueue, writeQueue } from "@/lib/cleanup-queue";
 *   const queue = readQueue(localStorage);
 *   writeQueue(nextQueue, localStorage);
 *
 * Usage in Node.js tests:
 *   const store = new Map<string, string>();
 *   const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
 *   const queue = readQueue(storage);
 */

export const QUEUE_KEY = "willard-cleanup-queue-v1";

/** Minimal interface for a synchronous key-value store (subset of the Web Storage API). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** An entry staged in the cleanup queue — one duplicate group's resolved decision. */
export interface CleanupQueueEntry {
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
}

/**
 * Read the current queue from storage.
 * Returns [] if the storage key is empty or contains invalid JSON.
 */
export function readQueue(storage: StorageLike): CleanupQueueEntry[] {
  try {
    return JSON.parse(storage.getItem(QUEUE_KEY) ?? "[]") as CleanupQueueEntry[];
  } catch {
    return [];
  }
}

/**
 * Persist the queue to storage (full replacement).
 */
export function writeQueue(q: CleanupQueueEntry[], storage: StorageLike): void {
  storage.setItem(QUEUE_KEY, JSON.stringify(q));
}

/**
 * Stage an entry.  If an entry for the same groupHash already exists it is
 * replaced so that re-staging a group does not produce duplicates.
 */
export function stageEntry(entry: CleanupQueueEntry, storage: StorageLike): void {
  const without = readQueue(storage).filter((e) => e.groupHash !== entry.groupHash);
  writeQueue([...without, entry], storage);
}

/**
 * Remove the entry for the given groupHash.  No-op if it doesn't exist.
 */
export function removeEntry(groupHash: string, storage: StorageLike): void {
  writeQueue(readQueue(storage).filter((e) => e.groupHash !== groupHash), storage);
}

/**
 * Clear all staged entries.
 */
export function clearQueue(storage: StorageLike): void {
  writeQueue([], storage);
}
