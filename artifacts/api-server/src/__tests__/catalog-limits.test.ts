import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  ARCHIVE_ENTRY_PAGE_LIMIT,
  ARCHIVE_PEEK_STORAGE_LIMIT,
  SAVED_SEARCH_LIMIT,
  pageEntries,
  responsePeekEntries,
  storedPeekEntries,
} from "../lib/catalog-limits.ts";

test("archive responses expose only the first bounded entry page", () => {
  const entries = Array.from({ length: ARCHIVE_ENTRY_PAGE_LIMIT + 37 }, (_, i) => ({ name: `file-${i}` }));
  const page = responsePeekEntries(entries);

  assert.equal(page.entries.length, ARCHIVE_ENTRY_PAGE_LIMIT);
  assert.equal(page.totalEntries, entries.length);
  assert.equal(page.entriesTruncated, true);
  assert.deepEqual(page.entries[0], entries[0]);
  assert.deepEqual(page.entries.at(-1), entries[ARCHIVE_ENTRY_PAGE_LIMIT - 1]);
});

test("archive metadata persistence has a finite cap", () => {
  const entries = Array.from({ length: ARCHIVE_PEEK_STORAGE_LIMIT + 1 }, (_, i) => i);
  const stored = storedPeekEntries(entries);

  assert.equal(stored.length, ARCHIVE_PEEK_STORAGE_LIMIT);
  assert.equal(stored.at(-1), ARCHIVE_PEEK_STORAGE_LIMIT - 1);
});

test("archive detail pages report when persisted metadata cannot cover the full archive", () => {
  const stored = Array.from({ length: ARCHIVE_PEEK_STORAGE_LIMIT }, (_, i) => i);
  const page = pageEntries(stored, ARCHIVE_PEEK_STORAGE_LIMIT + 2, ARCHIVE_PEEK_STORAGE_LIMIT - 2, 200);

  assert.equal(page.entries.length, 2);
  assert.equal(page.totalEntries, ARCHIVE_PEEK_STORAGE_LIMIT + 2);
  assert.equal(page.entriesTruncated, true);
});

test("saved-search retention has a finite hard ceiling", () => {
  assert.equal(SAVED_SEARCH_LIMIT, 100);
  assert.ok(SAVED_SEARCH_LIMIT > 0);
});