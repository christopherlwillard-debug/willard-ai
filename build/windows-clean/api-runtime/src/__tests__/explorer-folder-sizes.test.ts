import { test } from "node:test";
import * as assert from "node:assert/strict";
import { aggregateFolderSizes } from "../lib/explorer-folder-sizes.ts";

const ROOT = "/library";

test("folder totals include indexed files in nested descendants", () => {
  const totals = aggregateFolderSizes(ROOT, [
    { folder: "/library/Photos", totalSizeBytes: 100 },
    { folder: "/library/Photos/2024", totalSizeBytes: 250 },
    { folder: "/library/Photos/2024/Trips", totalSizeBytes: 75 },
    { folder: "/library/Documents", totalSizeBytes: 40 },
  ]);

  assert.equal(totals.get("Photos"), 425);
  assert.equal(totals.get("Documents"), 40);
});

test("refreshing with removed or moved indexed rows updates totals", () => {
  const before = aggregateFolderSizes(ROOT, [
    { folder: "/library/Photos/old", totalSizeBytes: 100 },
    { folder: "/library/Photos/new", totalSizeBytes: 200 },
  ]);
  assert.equal(before.get("Photos"), 300);

  const after = aggregateFolderSizes(ROOT, [
    { folder: "/library/Photos/new", totalSizeBytes: 200 },
    { folder: "/library/Archive", totalSizeBytes: 100 },
  ]);
  assert.equal(after.get("Photos"), 200);
  assert.equal(after.get("Archive"), 100);
});

test("unindexed and empty folders have a predictable zero total", () => {
  const totals = aggregateFolderSizes(ROOT, [
    { folder: "/library/Photos", totalSizeBytes: 0 },
  ]);

  assert.equal(totals.get("Photos"), 0);
  assert.equal(totals.get("Empty"), undefined);
  assert.equal(totals.get("NeverIndexed"), undefined);
});

test("rows outside the requested folder cannot poison a folder total", () => {
  const totals = aggregateFolderSizes(ROOT, [
    { folder: "/library/Photos", totalSizeBytes: 10 },
    { folder: "/library-other/Photos", totalSizeBytes: 999 },
    { folder: "/other", totalSizeBytes: 999 },
  ]);

  assert.equal(totals.get("Photos"), 10);
});