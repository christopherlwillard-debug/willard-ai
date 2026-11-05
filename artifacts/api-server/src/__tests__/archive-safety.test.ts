import { test, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  ARCHIVE_LIMITS,
  ArchiveSafetyError,
  assertArchiveFileUnchanged,
  createArchiveBudget,
  createArchiveExpansionLimiter,
  inspectExtractedTree,
  isZipSymlinkEntry,
  isTarLinkEntry,
  getSevenZipEntryInfo,
  isSevenZipDirectoryEntry,
  isSevenZipLinkEntry,
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

function createSymlinkOrSkip(
  context: { skip(message: string): void },
  target: string,
  linkPath: string,
): boolean {
  try {
    fs.symlinkSync(target, linkPath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      context.skip("symlink creation is not permitted on this runner");
      return false;
    }
    throw error;
  }
}

test("rejects traversal, absolute, Windows drive, UNC, deep, and overlong archive paths", () => {
  for (const entryPath of [
    "../outside.txt",
    "nested/../../outside.txt",
    "/absolute.txt",
    "C:\\outside.txt",
    "C:relative.txt",
    "file.txt:secret-stream",
    "CON.txt",
    "CON .txt",
    "CONIN$",
    "COM¹.txt",
    "control\u0001char.txt",
    "nested/AUX",
    "trailing-dot./file.txt",
    "trailing-space /file.txt",
    "\\\\server\\share\\outside.txt",
  ]) {
    assertSafetyFailure(
      () => validateArchiveEntry({ path: entryPath, sizeBytes: 1 }, createArchiveBudget()),
      /traversal rejected|absolute path|Windows-incompatible path component/,
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

test("normalizes harmless current-directory archive prefixes", () => {
  const result = validateArchiveEntry(
    { path: "./folder/file.txt", sizeBytes: 1 },
    createArchiveBudget(),
  );
  assert.equal(result.normalizedPath, "folder/file.txt");
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
  assertSafetyFailure(
    () => {
      const budget = createArchiveBudget();
      validateArchiveEntry({ path: "Photos/Cat.jpg", sizeBytes: 1 }, budget);
      validateArchiveEntry({ path: "photos/cat.JPG", sizeBytes: 1 }, budget);
    },
    /duplicate entry path/,
  );
  assertSafetyFailure(
    () => {
      const budget = createArchiveBudget();
      validateArchiveEntry({ path: "café.jpg", sizeBytes: 1 }, budget);
      validateArchiveEntry({ path: "cafe\u0301.jpg", sizeBytes: 1 }, budget);
    },
    /duplicate entry path/,
  );
});

test("atomically refuses a symlink output and never changes the outside target", (t) => {
  const outside = path.join(root, "outside.txt");
  const outputRoot = path.join(root, "staging");
  const output = path.join(outputRoot, "nested", "file.txt");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(outside, "outside");
  if (!createSymlinkOrSkip(t, outside, output)) return;

  assertSafetyFailure(
    () => writeArchiveFileAtomically(outputRoot, output, Buffer.from("archive data")),
    /symlink/,
  );
  assert.equal(fs.readFileSync(outside, "utf8"), "outside");
  assert.equal(fs.readlinkSync(output), outside);
});

test("inspectExtractedTree rejects symlinks and reports bounded regular files", (t) => {
  const staging = path.join(root, "staging");
  const outside = path.join(root, "outside.txt");
  fs.mkdirSync(path.join(staging, "nested"), { recursive: true });
  fs.writeFileSync(path.join(staging, "nested", "photo.jpg"), "photo");
  fs.writeFileSync(outside, "outside");
  if (!createSymlinkOrSkip(t, outside, path.join(staging, "escape.txt"))) return;

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
  const replacement = path.join(root, "source-replacement.zip");
  fs.writeFileSync(archive, "original");
  const snapshot = snapshotArchiveFile(archive);
  fs.writeFileSync(replacement, "replaced");
  fs.renameSync(replacement, archive);

  assertSafetyFailure(
    () => assertArchiveFileUnchanged(archive, snapshot),
    /changed while it was being inspected/,
  );
});

test("detects Unix ZIP symlinks and Windows reparse points", () => {
  assert.equal(isZipSymlinkEntry(0xA1FF0000), true);
  assert.equal(isZipSymlinkEntry(0xA0000000), true);
  assert.equal(isZipSymlinkEntry(0x81A40000), false);
  assert.equal(isZipSymlinkEntry(0x00000400), true);
  assert.equal(isZipSymlinkEntry(0x00001410), true);
  assert.equal(isZipSymlinkEntry(0x00000020), false);
  assert.equal(isZipSymlinkEntry(undefined), false);
});

test("detects TAR symbolic and hard link entry types", () => {
  assert.equal(isTarLinkEntry("SymbolicLink"), true);
  assert.equal(isTarLinkEntry("Link"), true);
  assert.equal(isTarLinkEntry("HardLink"), true);
  assert.equal(isTarLinkEntry("File"), false);
  assert.equal(isTarLinkEntry("Directory"), false);
  assert.equal(isTarLinkEntry(undefined), false);
});

test("archive preview and validation reject ZIP and TAR link entries before extraction", () => {
  const routeSource = fs.readFileSync(new URL("../routes/organize.ts", import.meta.url), "utf8");
  assert.match(routeSource, /isZipSymlinkEntry\(\(e as any\)\.attr\)/);
  assert.match(routeSource, /isZipSymlinkEntry\(\(entry as any\)\.attr\)/);
  assert.match(routeSource, /isTarLinkEntry\(e\.type\)/);
  assert.match(routeSource, /isTarLinkEntry\(entry\.type\)/);
});


test("detects 7-Zip links in both ordinary and technical attribute fields", () => {
  assert.equal(isSevenZipLinkEntry("L"), true);
  assert.equal(isSevenZipLinkEntry(undefined, "A_ lrwxrwxrwx"), true);
  assert.equal(isSevenZipLinkEntry("....A", "A_ lrwxrwxrwx"), true);
  assert.equal(isSevenZipLinkEntry("D", "D_ drwxr-xr-x"), false);
  assert.equal(isSevenZipLinkEntry("....A", "A_ -rw-r--r--"), false);
  assert.equal(isSevenZipLinkEntry(undefined), false);
});

test("reads POSIX symlink metadata from the node-7z techInfo Map", () => {
  const info = getSevenZipEntryInfo({
    attributes: "....A",
    techInfo: new Map([
      ["Attributes", "A_ lrwxrwxrwx"],
      ["Folder", "-"],
      ["Size", "12"],
    ]),
  });
  assert.equal(info.isLink, true);
  assert.equal(info.isDirectory, false);
  assert.equal(info.sizeBytes, "12");
});

test("reads 7-Zip directory, size, and CRC metadata from techInfo", () => {
  const info = getSevenZipEntryInfo({
    techInfo: new Map([
      ["Attributes", "D_ drwxr-xr-x"],
      ["Folder", "+"],
      ["Size", "0"],
      ["CRC", "ABCD1234"],
    ]),
  });
  assert.equal(info.isLink, false);
  assert.equal(info.isDirectory, true);
  assert.equal(info.sizeBytes, "0");
  assert.equal(info.crc, "ABCD1234");
  assert.equal(isSevenZipDirectoryEntry("A_ drwxr-xr-x"), true);
  assert.equal(isSevenZipDirectoryEntry("....A", "-"), false);
});

test("stops decompression when the expanded TAR byte budget is exceeded", async () => {
  let received = 0;
  const sink = new Writable({
    write(chunk, _encoding, callback) { received += chunk.length; callback(); },
  });
  await assert.rejects(
    pipeline(Readable.from([Buffer.alloc(4), Buffer.alloc(4)]), createArchiveExpansionLimiter(7), sink),
    /Decompressed archive exceeds/,
  );
  assert.equal(received, 4);
});
