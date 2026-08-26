import { test, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  ARCHIVE_LIMITS,
  ArchiveSafetyError,
  assertArchiveFileUnchanged,
  createArchiveBudget,
  inspectExtractedTree,
  snapshotArchiveFile,
  validateArchiveEntry,
  writeArchiveFileAtomically,
} from "../lib/archive-safety.ts";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-archive-safety-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function assertSafetyFailure(action: () => unknown, expected: RegExp): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ArchiveSafetyError);
    assert.match(error.message, expected);
    return true;
  });
}

test("rejects traversal, absolute, Windows drive, UNC, deep, and overlong archive paths", () => {
  for (const entryPath of [
    "../outside.txt",
    "nested/../../outside.txt",
    "/absolute.txt",
    "C:\\outside.txt",
    "\\\\server\\share\\outside.txt",
  ]) {
    assertSafetyFailure(
      () => validateArchiveEntry({ path: entryPath, sizeBytes: 1 }, createArchiveBudget()),
      /traversal rejected|absolute path/,
    );
  }

  const deepPath = `${Array.from({ length: ARCHIVE_LIMITS.maxPathDepth + 1 }, () => "d").join("/")}/file.txt`;
  assertSafetyFailure(
    () => validateArchiveEntry({ path: deepPath, sizeBytes: 1 }, createArchiveBudget()),
    /depth limit/,
  );
  assertSafetyFailure(
    () => validateArchiveEntry({ path: "x".repeat(ARCHIVE_LIMITS.maxPathLength + 1), sizeBytes: 1 }, createArchiveBudget()),
    /character limit/,
  );
});

test("bounds entry count, per-file expansion, total expansion, and duplicate paths", () => {
  const countBudget = createArchiveBudget();
  for (let i = 0; i < ARCHIVE_LIMITS.maxEntries; i++) {
    validateArchiveEntry({ path: `file-${i}.txt`, sizeBytes: 0 }, countBudget);
  }
  assertSafetyFailure(
    () => validateArchiveEntry({ path: "one-too-many.txt", sizeBytes: 0 }, countBudget),
    /more than/,
  );

  assertSafetyFailure(
    () => validateArchiveEntry({ path: "large.bin", sizeBytes: ARCHIVE_LIMITS.maxEntryBytes + 1 }, createArchiveBudget()),
    /per-file limit/,
  );
  assertSafetyFailure(
    () => {
      const budget = createArchiveBudget();
      for (let i = 0; i < 8; i++) {
        validateArchiveEntry({ path: `first-${i}.bin`, sizeBytes: ARCHIVE_LIMITS.maxEntryBytes }, budget);
      }
      validateArchiveEntry({ path: "second.bin", sizeBytes: 1 }, budget);
    },
    /total limit/,
  );
  assertSafetyFailure(
    () => {
      const budget = createArchiveBudget();
      validateArchiveEntry({ path: "same.txt", sizeBytes: 1 }, budget);
      validateArchiveEntry({ path: "same.txt", sizeBytes: 1 }, budget);
    },
    /duplicate entry path/,
  );
  assertSafetyFailure(
    () => {
      const budget = createArchiveBudget();
      validateArchiveEntry({ path: "./nested//same.txt", sizeBytes: 1 }, budget);
      validateArchiveEntry({ path: "nested/same.txt", sizeBytes: 1 }, budget);
    },
    /duplicate entry path/,
  );
});

test("atomically refuses a symlink output and never changes the outside target", () => {
  const outside = path.join(root, "outside.txt");
  const outputRoot = path.join(root, "staging");
  const output = path.join(outputRoot, "nested", "file.txt");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(outside, "outside");
  fs.symlinkSync(outside, output);

  assertSafetyFailure(
    () => writeArchiveFileAtomically(outputRoot, output, Buffer.from("archive data")),
    /symlink/,
  );
  assert.equal(fs.readFileSync(outside, "utf8"), "outside");
  assert.equal(fs.readlinkSync(output), outside);
});

test("inspectExtractedTree rejects symlinks and reports bounded regular files", () => {
  const staging = path.join(root, "staging");
  const outside = path.join(root, "outside.txt");
  fs.mkdirSync(path.join(staging, "nested"), { recursive: true });
  fs.writeFileSync(path.join(staging, "nested", "photo.jpg"), "photo");
  fs.writeFileSync(outside, "outside");
  fs.symlinkSync(outside, path.join(staging, "escape.txt"));

  assertSafetyFailure(
    () => inspectExtractedTree(staging),
    /produced a symlink/,
  );

  fs.unlinkSync(path.join(staging, "escape.txt"));
  const summary = inspectExtractedTree(staging);
  assert.equal(summary.files.length, 1);
  assert.equal(summary.totalBytes, 5);
  assert.equal(summary.files[0]?.relativePath, path.join("nested", "photo.jpg"));
});

test("source replacement between archive phases is detected", () => {
  const archive = path.join(root, "source.zip");
  fs.writeFileSync(archive, "original");
  const snapshot = snapshotArchiveFile(archive);
  fs.writeFileSync(archive, "replaced");

  assertSafetyFailure(
    () => assertArchiveFileUnchanged(archive, snapshot),
    /changed while it was being inspected/,
  );
});