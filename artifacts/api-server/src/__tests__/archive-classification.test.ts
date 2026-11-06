import assert from "node:assert/strict";
import test from "node:test";
import { classifyMediaType } from "../lib/media-classification.ts";
import {
  computeCategoryFromContent,
  getFileTypeFromName,
} from "../lib/archive-classification.ts";

test("archive previews use the canonical media catalog extension sets", () => {
  const cases: Array<[string, string, string]> = [
    ["family.avif", "photo", "image"],
    ["camera.CR3", "photo", "image"],
    ["design.psd", "photo", "image"],
    ["clip.mts", "video", "video"],
    ["clip.m2ts", "video", "video"],
    ["camera.mxf", "video", "video"],
    ["track.opus", "audio", "audio"],
    ["track.aiff", "audio", "audio"],
    ["records.csv", "document", "document"],
    ["sheet.ods", "document", "document"],
    ["notes.md", "document", "document"],
    ["slides.key", "document", "document"],
  ];

  for (const [filename, mediaType, archiveType] of cases) {
    assert.equal(classifyMediaType(filename.split(".").pop()!), mediaType, filename);
    assert.equal(getFileTypeFromName(filename), archiveType, filename);
  }
});

test("archive and software formats include compound TAR wrappers and binary containers", () => {
  for (const filename of [
    "backup.zip", "backup.rar", "backup.7z", "backup.tar",
    "backup.tar.gz", "backup.tgz", "backup.tar.bz2", "backup.tbz2",
    "backup.tar.xz", "backup.txz", "backup.cab", "backup.iso",
  ]) {
    assert.equal(getFileTypeFromName(filename), "archive", filename);
  }

  for (const filename of ["setup.exe", "installer.msi", "package.deb", "script.sh"]) {
    assert.equal(getFileTypeFromName(filename), "software", filename);
  }
});

test("archive category summaries count audio and ignore directory entries", () => {
  assert.equal(
    computeCategoryFromContent([
      { isDirectory: false, fileType: "audio" },
      { isDirectory: false, fileType: "audio" },
      { isDirectory: false, fileType: "audio" },
      { isDirectory: false, fileType: "document" },
      { isDirectory: true, fileType: "audio" },
    ], false),
    "Audio Archive",
  );
});

test("archive category summaries retain password and empty-archive states", () => {
  assert.equal(computeCategoryFromContent([], true), "Password Protected");
  assert.equal(computeCategoryFromContent([], false), "Unknown");
  assert.equal(
    computeCategoryFromContent([{ isDirectory: false, fileType: "unrecognized" }], false),
    "General",
  );
});

test("archive filename classification handles both separator styles", () => {
  assert.equal(getFileTypeFromName("folder\\camera\\family.CR3"), "image");
  assert.equal(getFileTypeFromName("folder/camera/clip.M2TS"), "video");
  assert.equal(getFileTypeFromName("README"), "other");
});
