import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isMissingFilesystemEntry, isMissingRegularMediaFile, isMissingRegularMediaFileAsync, softDeleteMissingMediaRecord } from "../lib/media-health-scan.ts";
import { walkHealthDirectories } from "../lib/media-health-filesystem.ts";
import { parseHealthCleanupActions } from "../lib/media-health-actions.ts";

test("media health treats only ENOENT and ENOTDIR as confirmed missing paths", () => {
  assert.equal(isMissingFilesystemEntry({ code: "ENOENT" }), true);
  assert.equal(isMissingFilesystemEntry({ code: "ENOTDIR" }), true);
  assert.equal(isMissingFilesystemEntry({ code: "EACCES" }), false);
  assert.equal(isMissingFilesystemEntry({ code: "EIO" }), false);
});

test("media health distinguishes missing regular files from directories", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-media-health-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "photo.jpg");
  fs.writeFileSync(file, "photo");
  assert.equal(isMissingRegularMediaFile(file), false);
  assert.equal(isMissingRegularMediaFile(path.join(root, "missing.jpg")), true);
  assert.throws(() => isMissingRegularMediaFile(root), /not a regular/);
});

test("async media health distinguishes missing files from directories without sync filesystem calls", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-media-health-async-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "photo.jpg");
  fs.writeFileSync(file, "photo");
  assert.equal(await isMissingRegularMediaFileAsync(file), false);
  assert.equal(await isMissingRegularMediaFileAsync(path.join(root, "missing.jpg")), true);
  await assert.rejects(isMissingRegularMediaFileAsync(root), /not a regular/);
});

test("media health refuses symlink media paths rather than following them", (t) => {
  if (process.platform === "win32") {
    t.skip("Symlink creation may require elevated Windows privileges.");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-media-health-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "target.jpg");
  const link = path.join(root, "link.jpg");
  fs.writeFileSync(target, "photo");
  fs.symlinkSync(target, link);
  assert.throws(() => isMissingRegularMediaFile(link), /not a regular/);
});

test("missing-media cleanup rechecks the source and skips a file restored after inspection", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-health-restored-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "restored.jpg");

  // Model the original inspection finding followed by a restore before cleanup.
  assert.equal(isMissingRegularMediaFile(source), true);
  fs.writeFileSync(source, "restored media");

  let updateCalled = false;
  const result = await softDeleteMissingMediaRecord(source, async () => {
    updateCalled = true;
    return true;
  });

  assert.equal(result, "reappeared");
  assert.equal(updateCalled, false);
});

test("missing-media cleanup marks only a still-missing active record and preserves changed rows", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-health-soft-delete-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "missing.jpg");

  let updates = 0;
  const result = await softDeleteMissingMediaRecord(source, async () => {
    updates++;
    return true;
  });
  assert.equal(result, "marked_deleted");
  assert.equal(updates, 1);

  const changed = await softDeleteMissingMediaRecord(source, async () => false);
  assert.equal(changed, "record_changed");
});

test("Health Center action parsing rejects invalid and conflicting work before scheduling", () => {
  assert.deepEqual(parseHealthCleanupActions([]), {
    ok: false,
    error: "actions must be a non-empty array containing only supported cleanup actions",
  });
  assert.equal(parseHealthCleanupActions(["not-an-action"]).ok, false);
  assert.equal(parseHealthCleanupActions(["rebuildMetadata", "missingThumbnails"]).ok, false);
  assert.deepEqual(parseHealthCleanupActions(["orphanedRecords", "orphanedRecords"]), {
    ok: true,
    actions: ["orphanedRecords"],
  });
  assert.deepEqual(parseHealthCleanupActions(["fullThumbnailRebuild", "orphanedThumbnails"]), {
    ok: true,
    actions: ["fullThumbnailRebuild", "orphanedThumbnails"],
  });
});

test("Health Center walks real directories asynchronously and reports bounded progress", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-health-walk-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nested = path.join(root, "nested");
  const empty = path.join(nested, "empty");
  fs.mkdirSync(empty, { recursive: true });
  fs.writeFileSync(path.join(nested, "media.jpg"), "media");
  const progress: number[] = [];

  const result = await walkHealthDirectories(root, path.join(root, "excluded"), async (update) => {
    progress.push(update.processed);
  }, {
    maxEntriesPerDirectory: 10,
    maxEntriesPerTree: 10,
    reportEveryDirectories: 1,
  });

  assert.equal(result.visitedDirectories, 3);
  assert.equal(result.visitedEntries, 3);
  assert.deepEqual(result.empty, [empty]);
  assert.deepEqual(progress, [1, 2, 3]);
});

test("Health Center bounds a directory before accumulating an unbounded entry array", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-health-limit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "one"), "1");
  fs.writeFileSync(path.join(root, "two"), "2");

  await assert.rejects(
    walkHealthDirectories(root, path.join(root, "excluded"), undefined, {
      maxEntriesPerDirectory: 1,
      maxEntriesPerTree: 10,
      reportEveryDirectories: 1,
    }),
    /limited to 1 entries in one directory/,
  );
});
