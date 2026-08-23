import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildNoResultSuggestions,
  buildSearchQuery,
  emptyIntent,
  mergeRefinedIntent,
  scoreRow,
  type RawRow,
  type SearchIntent,
} from "../lib/ai-search.ts";

const intent = (overrides: Partial<SearchIntent> = {}): SearchIntent => ({
  ...emptyIntent(),
  ...overrides,
});

function row(similarity: number | null): RawRow {
  return {
    id: 1, name: "sunset.jpg", relative_path: "photos/sunset.jpg", media_type: "photo",
    size_bytes: 100, thumbnail_path: "/thumb", date_taken: null, favorite: false,
    description: null, tags: [], objects: [], ocr_text: null, doc_type: null, scene: null,
    people: [], user_tags: [], hidden_tags: [], user_description: null, notes: null,
    gps_latitude: null, gps_longitude: null, place_name: null, similarity,
  };
}

test("refinement preserves prior media types while adding new constraints", () => {
  const merged = mergeRefinedIntent(
    intent({ mediaTypes: ["image"], dateFrom: "2025-06-01" }),
    intent({ objects: ["waterfall"] }),
  );
  assert.deepEqual(merged.mediaTypes, ["image"]);
  assert.equal(merged.dateFrom, "2025-06-01");
  assert.deepEqual(merged.objects, ["waterfall"]);
});

test("search query normalizes image intent to the stored photo media type", () => {
  const query = buildSearchQuery("/nas", intent({ mediaTypes: ["image"] }));
  assert.match(query.sql, /f\.media_type = ANY\(\$2\)/);
  assert.deepEqual(query.params, ["/nas", ["image", "photo"]]);
});

test("confidence labels use the documented score thresholds", () => {
  assert.equal(scoreRow(row(null), intent())?.confidence, "possible");
  assert.equal(scoreRow(row(null), intent({ keywords: ["sunset"] }))?.confidence, "possible");
  assert.equal(scoreRow(row(0.2), intent({ semanticQuery: "sunset" }))?.confidence, "possible");
  assert.equal(scoreRow(row(0.4), intent({ semanticQuery: "sunset" }))?.confidence, "likely");
  assert.equal(scoreRow(row(0.75), intent({ semanticQuery: "sunset" }))?.confidence, "very_likely");
});

test("no-result suggestions explain the active constraints", () => {
  const suggestions = buildNoResultSuggestions(intent({
    dateFrom: "2025-01-01",
    mediaTypes: ["image"],
    exclude: ["screenshots"],
    objects: ["truck", "waterfall"],
    location: "Seattle",
    favoriteOnly: true,
  }));
  assert.deepEqual(suggestions, [
    "Remove the date filter — try searching all time",
    "Search all media instead of just images",
    'Stop excluding "screenshots"',
    'Try just "truck" on its own',
  ]);
  assert.deepEqual(buildNoResultSuggestions(emptyIntent()), [
    "Try fewer or more general words",
    "Browse your collections instead",
  ]);
});