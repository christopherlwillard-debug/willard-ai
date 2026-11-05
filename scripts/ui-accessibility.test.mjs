import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const searchPage = await readFile(
  new URL("../artifacts/willard-ai/src/pages/search.tsx", import.meta.url),
  "utf8",
);
const archivePage = await readFile(
  new URL("../artifacts/willard-ai/src/pages/archives.tsx", import.meta.url),
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

test("search failures are announced to assistive technology", () => {
  const error = openingTagForTestId('data-testid="text-search-error"');
  assert.match(error, /role="alert"/);
  assert.match(error, /aria-live="assertive"/);
});

test("saved-search controls expose context-specific accessible names", () => {
  const saveInput = openingTagForTestId('data-testid="input-save-name"');
  assert.match(saveInput, /aria-label="Saved search name"/);

  const deleteButton = openingTagForTestId('data-testid={`button-delete-saved-${s.id}`}');
  assert.match(deleteButton, /aria-label=\{`Delete saved search \$\{s\.name\}`\}/);
});


test("archive filter controls expose accessible names", () => {
  for (const label of [
    "Archive status",
    "Archive category",
    "Modified on or after",
    "Modified on or before",
    "Minimum archive size in megabytes",
    "Maximum archive size in megabytes",
  ]) {
    assert.ok(archivePage.includes(`aria-label="${label}"`), label);
  }
});
test("archive index reports request failures and provides a retry action", () => {
  assert.ok(archivePage.includes("const { data, isLoading, isError, refetch } = useListArchives"));
  assert.ok(archivePage.includes("Archive index unavailable"));
  assert.ok(archivePage.includes("Unable to load archives"));
  assert.ok(archivePage.includes('role="alert"'));
  assert.ok(archivePage.includes("onClick={() => refetch()}"));
  assert.equal(archivePage.includes("{data?.total ?? 0} archives indexed"), false);
});
