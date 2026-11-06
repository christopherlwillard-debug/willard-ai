import { test } from "node:test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import {
  buildNoResultSuggestions,
  buildSuggestionPattern,
  buildSearchQuery,
  emptyIntent,
  localSearchClearFilters,
  mergeRefinedIntent,
  scoreRow,
  type RawRow,
  type SearchIntent,
} from "../lib/ai-search.ts";
import { activeMediaSql } from "../lib/media-scope.ts";

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

test("refinement suggestions can remove inherited filters instead of only adding constraints", () => {
  const previous = intent({
    semanticQuery: "vacation photos",
    keywords: ["vacation", "photos"],
    mediaTypes: ["image"],
    dateFrom: "2025-06-01",
    dateTo: "2025-09-01",
    objects: ["truck", "waterfall"],
    exclude: ["screenshots", "watermarks"],
    favoriteOnly: true,
    location: "Seattle",
  });
  const cleared = mergeRefinedIntent(previous, emptyIntent(), {
    semanticQuery: true,
    keywords: true,
    mediaTypes: true,
    dateRange: true,
    objects: true,
    exclude: ["screenshots"],
    favoriteOnly: true,
    location: true,
  });
  assert.equal(cleared.semanticQuery, null);
  assert.deepEqual(cleared.keywords, []);
  assert.deepEqual(cleared.mediaTypes, []);
  assert.equal(cleared.dateFrom, null);
  assert.equal(cleared.dateTo, null);
  assert.deepEqual(cleared.objects, []);
  assert.deepEqual(cleared.exclude, ["watermarks"]);
  assert.equal(cleared.favoriteOnly, false);
  assert.equal(cleared.location, null);
});

test("local-only search recognizes the built-in no-result clear-filter suggestions", () => {
  assert.deepEqual(localSearchClearFilters("Remove the date filter — try searching all time"), { dateRange: true });
  assert.deepEqual(localSearchClearFilters("Search all media instead of just images"), { mediaTypes: true });
  assert.deepEqual(localSearchClearFilters("Stop excluding \"screenshots\""), { exclude: ["screenshots"] });
  assert.deepEqual(localSearchClearFilters("Include non-favorites too"), { favoriteOnly: true });
  assert.deepEqual(localSearchClearFilters("Drop the location \"Seattle\" — many files have no GPS data"), { location: true });
  assert.deepEqual(localSearchClearFilters("Try just \"truck\" on its own"), {
    objects: true,
    keywords: true,
    semanticQuery: true,
  });
});

test("search query normalizes image intent to the stored photo media type", () => {
  const query = buildSearchQuery("/nas", intent({ mediaTypes: ["image"] }));
  assert.match(query.sql, /f\.media_type = ANY\(\$2\)/);
  assert.deepEqual(query.params, ["/nas", ["image", "photo"]]);
});

test("search query excludes both deleted and recycled media", () => {
  const query = buildSearchQuery("/nas", emptyIntent());
  assert.match(query.sql, new RegExp(activeMediaSql("f").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(query.sql, /last_scan_action IS NULL OR f\.last_scan_action <> 'DELETED'/);
});

test("semantic search orders by vector distance for ANN index scans", () => {
  const query = buildSearchQuery("/nas", intent({ semanticQuery: "sunset photos" }), 24, "[0.1,0.2]");
  assert.match(query.sql, /a\.embedding <=> \$2::vector ASC NULLS LAST/);
  assert.doesNotMatch(query.sql, /ORDER BY similarity DESC/);
  assert.deepEqual(query.params, ["/nas", "[0.1,0.2]"]);
});

test("named people search filters to visible face assignments in the active library", () => {
  const query = buildSearchQuery("/nas", intent({ personNames: ["grandma"] }));
  assert.match(query.sql, /EXISTS \(\s*SELECT 1\s+FROM faces face_match/);
  assert.match(query.sql, /lower\(person_match\.name\) = ANY\(\$2::text\[\]\)/);
  assert.deepEqual(query.params, ["/nas", ["grandma"]]);
});

test("named people matches explain the person identity", () => {
  const namedRow = { ...row(null), person_names: ["grandma"] };
  const result = scoreRow(namedRow, intent({ personNames: ["grandma"] }));
  assert.equal(result?.confidence, "likely");
  assert.deepEqual(result?.reasons, ["Person: Grandma"]);
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

const aiSearchSource = await readFile(
  new URL("../lib/ai-search.ts", import.meta.url),
  "utf8",
);

const searchRouteSource = await readFile(
  new URL("../routes/search.ts", import.meta.url),
  "utf8",
);

test("local-only route applies explicit clear-filter refinements", () => {
  assert.match(searchRouteSource, /localSearchClearFilters\(query\)/);
  assert.match(searchRouteSource, /mergeRefinedIntent\(previous, fallback, clear\)/);
});

test("AI intent parser accepts explicit clear-filter instructions", () => {
  assert.match(aiSearchSource, /"clearFilters"/);
  assert.match(aiSearchSource, /mergeRefinedIntent\(previous, parsed, effectiveClear\)/);
  assert.match(aiSearchSource, /const localClear = previous \? localSearchClearFilters\(query\) : \{\}/);
  assert.match(aiSearchSource, /localSearchClearFilters\(query\)/);
});

test("search suggestions treat SQL wildcard characters as literal text", () => {
  assert.ok(aiSearchSource.includes("const like = buildSuggestionPattern(prefix);"));
  assert.equal(
    buildSuggestionPattern("  100%_\\Archive  "),
    "%100\\%\\_\\\\archive%",
  );
  assert.match(aiSearchSource, /term LIKE \$2 ESCAPE E'\\\\\\\\'/);
});
