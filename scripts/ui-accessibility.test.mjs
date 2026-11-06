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
const explorerPage = await readFile(
  new URL("../artifacts/willard-ai/src/pages/explorer.tsx", import.meta.url),
  "utf8",
);
const mediaViewer = await readFile(
  new URL("../artifacts/willard-ai/src/components/media/MediaViewer.tsx", import.meta.url),
  "utf8",
);
const mediaPage = await readFile(
  new URL("../artifacts/willard-ai/src/pages/media.tsx", import.meta.url),
  "utf8",
);
const peoplePage = await readFile(
  new URL("../artifacts/willard-ai/src/pages/people.tsx", import.meta.url),
  "utf8",
);
const documentsPage = await readFile(
  new URL("../artifacts/willard-ai/src/pages/documents.tsx", import.meta.url),
  "utf8",
);
const organizePage = await readFile(
  new URL("../artifacts/willard-ai/src/pages/organize.tsx", import.meta.url),
  "utf8",
);
const cleanupPage = await readFile(
  new URL("../artifacts/willard-ai/src/pages/cleanup.tsx", import.meta.url),
  "utf8",
);
const mediaDetailPage = await readFile(
  new URL("../artifacts/willard-ai/src/pages/media-detail.tsx", import.meta.url),
  "utf8",
);
const optimizePage = await readFile(
  new URL("../artifacts/willard-ai/src/pages/optimize.tsx", import.meta.url),
  "utf8",
);
const settingsPage = await readFile(
  new URL("../artifacts/willard-ai/src/pages/settings.tsx", import.meta.url),
  "utf8",
);
const libraryJobStreamHook = await readFile(
  new URL("../artifacts/willard-ai/src/hooks/use-library-job-stream.ts", import.meta.url),
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


test("Explorer sorting, navigation, and errors are accessible", () => {
  assert.ok(explorerPage.includes('aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined}'));
  assert.ok(explorerPage.includes("currently sorted"));
  assert.ok(explorerPage.includes("Sort by"));
  assert.ok(explorerPage.includes('aria-label="Go to library root"'));
  assert.ok(explorerPage.includes('aria-label="Go up one folder"'));
  assert.ok(explorerPage.includes("aria-label={entry.isDirectory ?"));
  assert.ok(explorerPage.includes("Open folder"));
  assert.ok(explorerPage.includes("View details for"));
  assert.ok(explorerPage.includes('role="alert"'));

  const sortableHeadStart = explorerPage.indexOf("function SortableHead");
  const sortableHeadEnd = explorerPage.indexOf("// ── Main page", sortableHeadStart);
  const sortableHead = explorerPage.slice(sortableHeadStart, sortableHeadEnd);
  assert.match(sortableHead, /<button/);
  assert.doesNotMatch(sortableHead, /<TableHead[^>]*onClick=/);

  const entryRowStart = explorerPage.indexOf('<TableRow key={entry.path}');
  const entryRowTagEnd = explorerPage.indexOf(">", entryRowStart);
  assert.ok(entryRowStart >= 0 && entryRowTagEnd > entryRowStart);
  assert.doesNotMatch(explorerPage.slice(entryRowStart, entryRowTagEnd), /onClick=/);
});


test("media rename dialog is labelled, announces errors, and traps keyboard focus", () => {
  assert.ok(mediaViewer.includes('role="dialog"'));
  assert.ok(mediaViewer.includes('aria-modal="true"'));
  assert.ok(mediaViewer.includes('aria-labelledby="media-rename-title"'));
  assert.ok(mediaViewer.includes('htmlFor="media-rename-input"'));
  assert.ok(mediaViewer.includes('aria-invalid={Boolean(err)}'));
  assert.ok(mediaViewer.includes('aria-describedby={err ? "media-rename-error" : undefined}'));
  assert.ok(mediaViewer.includes('role="alert" aria-live="assertive"'));
  assert.ok(mediaViewer.includes('event.key !== "Tab"'));
  assert.ok(mediaViewer.includes("last.focus()"));
  assert.ok(mediaViewer.includes("first.focus()"));
  assert.ok(mediaViewer.includes("inp.current?.focus()"));
  assert.ok(mediaViewer.includes("requestAnimationFrame(() => renameTriggerRef.current?.focus())"));
  assert.ok(mediaViewer.includes('aria-label={"Rename " + file.name}'));
});

test("media rename refreshes both the viewer path and the media-list cache", () => {
  assert.ok(mediaViewer.includes("Promise<{ id: number; name: string; relativePath: string }>"));
  assert.ok(mediaViewer.includes("onRenameChange(updated.id, updated.name, updated.relativePath)"));
  assert.ok(mediaPage.includes("onRenameChange={(id, name, relativePath) =>"));
  assert.ok(mediaPage.includes("{ ...item, name, relativePath }"));
  assert.ok(mediaPage.includes('queryClient.invalidateQueries({ queryKey: ["media-files"] })'));
});

test("search result cards are keyboard operable and keep similar-search actions separate", () => {
  const cardStart = searchPage.indexOf("function ResultCard(");
  const cardEnd = searchPage.indexOf("// ── Detail sheet", cardStart);
  assert.ok(cardStart >= 0 && cardEnd > cardStart, "ResultCard component should exist");
  const card = searchPage.slice(cardStart, cardEnd);
  assert.ok(card.includes('<button\n        type="button"'));
  assert.ok(card.includes('aria-label={"Open " + item.name + " details"}'));
  assert.ok(card.includes("onClick={() => onOpen(item)}"));
  assert.ok(card.includes("focus-visible:ring-2"));
  assert.ok(!card.slice(0, card.indexOf("<button")).includes("onClick="));
  const mainButtonClose = card.indexOf("</button>");
  const similarAction = card.indexOf('data-testid={"button-similar-" + item.id}');
  assert.ok(mainButtonClose >= 0 && similarAction > mainButtonClose,
    "Similar-search action must not be nested inside the card's open button");
  assert.ok(card.includes('aria-label={"Find similar files to " + item.name}'));
  assert.ok(card.includes("sm:group-focus-within:opacity-100"));
});

test("media thumbnail cards use a native open button and independent labelled actions", () => {
  const start = mediaPage.indexOf("function ThumbnailCard(");
  const end = mediaPage.indexOf("// ── Scan status banner", start);
  assert.ok(start >= 0 && end > start, "ThumbnailCard component should exist");
  const card = mediaPage.slice(start, end);
  assert.ok(card.includes('aria-label={"Open " + file.name}'));
  assert.ok(card.includes('aria-label={selected ? "Deselect " + file.name : "Select " + file.name}'));
  assert.ok(card.includes("aria-pressed={selected}"));
  assert.ok(card.includes('aria-label={file.favorite ? "Remove " + file.name + " from favorites" : "Add " + file.name + " to favorites"}'));
  assert.ok(card.includes("aria-pressed={file.favorite}"));
  assert.ok(card.includes("group-focus-within:opacity-100"));
  assert.ok(!card.includes('role="button"'));
  assert.ok(card.includes('"border-primary bg-primary text-primary-foreground opacity-100"'));
});

test("people media tiles separate open and move-face controls", () => {
  const start = peoplePage.indexOf('data-testid="person-items-grid"');
  const end = peoplePage.indexOf("<ReassignFaceDialog", start);
  assert.ok(start >= 0 && end > start, "People media grid should exist");
  const grid = peoplePage.slice(start, end);
  assert.ok(grid.includes('aria-label={"Open " + it.name + " in media viewer"}'));
  assert.ok(grid.includes('aria-label={"Move face from " + it.name}'));
  assert.ok(grid.includes("group-focus-within:opacity-100"));
  assert.ok(grid.indexOf("</button>") < grid.indexOf('aria-label={"Move face from " + it.name}'));
  assert.ok(!grid.includes('role="button"'));
  assert.ok(!grid.includes("onKeyDown="));
});

test("document table navigation is provided by a labelled native button", () => {
  const start = documentsPage.indexOf('data-testid={"button-open-document-" + doc.id}');
  assert.ok(start >= 0, "Document open action should have a stable test marker");
  const buttonStart = documentsPage.lastIndexOf("<button", start);
  const buttonEnd = documentsPage.indexOf("</button>", start);
  assert.ok(buttonStart >= 0 && buttonEnd > start);
  const button = documentsPage.slice(buttonStart, buttonEnd);
  assert.ok(button.includes('type="button"'));
  assert.ok(button.includes('aria-label={"Open document " + doc.filename}'));
  assert.ok(button.includes("onClick={() => setSelectedDoc(doc)}"));
  assert.ok(documentsPage.includes('if ((event.target as HTMLElement).closest("button")) return;'));
  assert.ok(documentsPage.includes("setSelectedDoc(doc);"));
});

test("organize job rows expose keyboard-accessible open and delete actions", () => {
  const start = organizePage.indexOf("function OrganizeJobRow(");
  const end = organizePage.indexOf("// ── Page", start);
  assert.ok(start >= 0 && end > start, "OrganizeJobRow component should exist");
  const row = organizePage.slice(start, end);
  assert.ok(row.includes('className="cursor-pointer hover:bg-secondary/30"'));
  assert.ok(row.includes('aria-label={"Open organization job " + sourceName}'));
  assert.ok(row.includes('aria-label={"Delete organization job " + sourceName}'));
  assert.ok(row.includes('aria-label={"View report for organization job " + sourceName}'));
  assert.ok(row.includes('currentJob.sourcePath.replaceAll("\\\\", "/")'),
    "Windows backslash paths must be normalized before extracting the filename");
  assert.ok(row.includes('if ((event.target as HTMLElement).closest("button")) return;'));
  assert.ok(row.includes("onOpen();"));
});

test("duplicate cleanup choices expose selection state to assistive technology", () => {
  const start = cleanupPage.indexOf('data-testid={"button-keep-duplicate-" + file.id}');
  assert.ok(start >= 0, "Duplicate keep choice should have a stable test marker");
  const buttonStart = cleanupPage.lastIndexOf("<button", start);
  const buttonEnd = cleanupPage.indexOf("</button>", start);
  assert.ok(buttonStart >= 0 && buttonEnd > start);
  const button = cleanupPage.slice(buttonStart, buttonEnd);
  assert.ok(button.includes('type="button"'));
  assert.ok(button.includes("aria-pressed={isKeep}"));
  assert.ok(button.includes('aria-label={"Choose " + file.filename + " as the copy to keep"}'));
  assert.ok(button.includes("focus-visible:ring-2"));
});

test("cleanup thumbnails honor the configured application base path", () => {
  assert.ok(cleanupPage.includes('import { apiUrl } from "@/lib/api";'));
  assert.ok(cleanupPage.includes('const thumbUrl = file.mediaId ? apiUrl(`/media/thumbnail/${file.mediaId}`) : null;'));
  assert.equal(cleanupPage.includes('const thumbUrl = file.mediaId ? `/api/media/thumbnail/${file.mediaId}` : null;'), false);
});

test("media detail streaming and optimize scans honor the configured application base path", () => {
  assert.ok(mediaDetailPage.includes('const streamUrl = apiUrl(`/media/file/${file.id}/stream`);'));
  assert.equal(mediaDetailPage.includes('const streamUrl = `/api/media/file/${file.id}/stream`;'), false);
  assert.ok(optimizePage.includes('const url = apiUrl(force ? "/optimize/scan?force=true" : "/optimize/scan");'));
  assert.equal(optimizePage.includes('const url = force ? "/api/optimize/scan?force=true" : "/api/optimize/scan";'), false);
});


test("media viewer is a keyboard-contained modal with accessible media actions", () => {
  assert.ok(mediaViewer.includes("function useDialogFocusTrap"));
  assert.ok(mediaViewer.includes("dialog.addEventListener(\"keydown\", onKeyDown)"));
  assert.ok(mediaViewer.includes("if (previousFocus?.isConnected) previousFocus.focus()"));
  assert.ok(mediaViewer.includes("useDialogFocusTrap(containerRef, { focusContainer: true, suspendRef: nestedDialogOpenRef })"));
  assert.ok(mediaViewer.includes("aria-hidden={nestedDialogOpenRef.current}"));
  assert.ok(mediaViewer.includes("onFocusCapture={showControls}"));
  assert.ok(mediaViewer.includes("if (showRename || showDelete || showTags) return;"));
  assert.ok(mediaViewer.includes('aria-label="Zoom out"'));
  assert.ok(mediaViewer.includes('aria-label="Zoom in"'));
  assert.ok(mediaViewer.includes('aria-label={"Edit tags for " + file.name}'));
  assert.ok(mediaViewer.includes('aria-label={"Close viewer for " + file.name}'));
  assert.ok(mediaViewer.includes('aria-label={showFilm ? "Hide filmstrip" : "Show filmstrip"}'));
  assert.ok(mediaViewer.includes("aria-expanded={showFilm}"));
  assert.ok(mediaViewer.includes('aria-label={"Open details for " + file.name}'));
  assert.equal(mediaViewer.includes('<button title="Open detail page"'), false);
});

test("nested media dialogs expose semantic roles, labels, and focus handling", () => {
  assert.ok(mediaViewer.includes('role="alertdialog"'));
  assert.ok(mediaViewer.includes('aria-labelledby="media-delete-title"'));
  assert.ok(mediaViewer.includes('aria-describedby="media-delete-description"'));
  assert.ok(mediaViewer.includes('aria-labelledby="media-tags-title"'));
  assert.ok(mediaViewer.includes('aria-label="New tag"'));
  assert.ok(mediaViewer.includes("useDialogFocusTrap(dialogRef, { initialFocusRef: inputRef })"));
  assert.ok(mediaViewer.includes('role="alert" aria-live="assertive"'));
});

test("settings ignored-folder and ignored-extension removals have accessible names", () => {
  assert.ok(settingsPage.includes('aria-label={"Remove ignored folder " + f}'));
  assert.ok(settingsPage.includes('aria-label={"Remove ignored extension " + e}'));
});


test("library job progress reconnects with one owned EventSource", () => {
  const start = libraryJobStreamHook.indexOf("const connect = () =>");
  const end = libraryJobStreamHook.indexOf("\n    const onJobs", start);
  assert.ok(start >= 0 && end > start, "job stream connect function should exist");
  const connect = libraryJobStreamHook.slice(start, end);
  assert.match(connect, /source && source\.readyState !== EventSource\.CLOSED/);
  assert.match(connect, /clearTimeout\(reconnectTimer\)/);
  assert.match(connect, /reconnectTimer = null/);
  assert.match(connect, /const nextSource = new EventSource/);
  assert.match(connect, /if \(source !== nextSource\) return/);
  assert.match(connect, /nextSource\.removeEventListener\("jobs", handleJobs\)/);
  assert.match(connect, /reconnectTimer = setTimeout\(\(\) => \{[\s\S]*?reconnectTimer = null;[\s\S]*?connect\(\);/);
});
