import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const searchPage = await readFile(
  new URL("../artifacts/willard-ai/src/pages/search.tsx", import.meta.url),
  "utf8",
);

function openingTagForTestId(needle) {
  const index = searchPage.indexOf(needle);
  assert.notEqual(index, -1, `Expected control marker: ${needle}`);
  const start = searchPage.lastIndexOf("<", index);
  const end = searchPage.indexOf(">", index);
  assert.ok(start >= 0 && end > start, `Expected opening JSX tag for: ${needle}`);
  return searchPage.slice(start, end + 1);
}

test("search controls expose accessible names and toggle state", () => {
  const searchInput = openingTagForTestId('data-testid="input-search"');
  assert.match(searchInput, /aria-label=\{hasSession \?/);

  const mediaFilter = openingTagForTestId('data-testid="select-type-filter"');
  assert.match(mediaFilter, /aria-label="Filter by media type"/);

  const favorites = openingTagForTestId('data-testid="button-favorite-filter"');
  assert.match(favorites, /aria-label="Filter favorites only"/);
  assert.match(favorites, /aria-pressed=\{favoriteOnly\}/);

  const submit = openingTagForTestId('data-testid="button-search"');
  assert.match(submit, /aria-label=\{search\.isPending \?/);
});

test("saved-search controls expose context-specific accessible names", () => {
  const saveInput = openingTagForTestId('data-testid="input-save-name"');
  assert.match(saveInput, /aria-label="Saved search name"/);

  const deleteButton = openingTagForTestId('data-testid={`button-delete-saved-${s.id}`}');
  assert.match(deleteButton, /aria-label=\{`Delete saved search \$\{s\.name\}`\}/);
});
