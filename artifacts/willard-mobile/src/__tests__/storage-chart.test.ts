import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  folderBarWidth,
  getStorageChartState,
  topFolders,
  typeBarWidth,
} from "../../lib/storage-chart.ts";

test("storage charts show loading while either response is pending", () => {
  assert.equal(getStorageChartState({ isLoading: true, isError: false }, () => false), "loading");
});

test("empty storage responses produce an explicit empty state", () => {
  assert.equal(
    getStorageChartState({ isLoading: false, isError: false, data: { rows: [] } }, (data) => (data?.rows.length ?? 0) > 0),
    "empty",
  );
});

test("populated storage responses keep the top ten folders and valid bar widths", () => {
  const folders = Array.from({ length: 12 }, (_, index) => ({
    folder: `folder-${index}`,
    totalSizeBytes: index === 0 ? 1_000 : 100 - index,
  }));
  assert.equal(getStorageChartState({ isLoading: false, isError: false, data: folders }, (data) => (data?.length ?? 0) > 0), "ready");
  assert.equal(topFolders(folders).length, 10);
  assert.equal(folderBarWidth(1_000, 1_000), 100);
  assert.ok(folderBarWidth(99, 1_000) > 0 && folderBarWidth(99, 1_000) <= 100);
  assert.equal(typeBarWidth(250, 10), 100);
  assert.equal(typeBarWidth(Number.NaN, 10), 0);
});

test("unavailable storage responses remain a recoverable chart state", () => {
  assert.equal(getStorageChartState({ isLoading: false, isError: true }, () => false), "unavailable");
  assert.equal(folderBarWidth(0, 0), 0);
  assert.equal(typeBarWidth(0, 0), 0);
});