import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ScanPriorityQueue,
  walkNas,
  walkNasAsync,
  type FileEntry,
} from "../lib/library-engine/indexer.ts";
import {
  DEFAULT_SCANNER_SETTINGS,
  type ScannerSettings,
} from "../lib/system-filter.ts";

function makeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-indexer-"));
  fs.writeFileSync(path.join(root, "photo.jpg"), "photo");
  fs.writeFileSync(path.join(root, "installer.exe"), "installer");
  fs.writeFileSync(path.join(root, "disk-image.iso"), "disk image");
  return root;
}

function settings(indexOtherFiles: boolean): ScannerSettings {
  return { ...DEFAULT_SCANNER_SETTINGS, indexOtherFiles };
}

function names(entries: FileEntry[]): string[] {
  return entries.map((entry) => entry.name).sort();
}

test("walkNas excludes other file types and reports the canonical skip reason", () => {
  const root = makeFixture();
  try {
    const results: FileEntry[] = [];
    const skipped: Array<{ file: string; reason: string }> = [];

    walkNas(
      root,
      new Set(),
      results,
      undefined,
      (file, reason) => skipped.push({ file: path.basename(file), reason }),
      undefined,
      undefined,
      undefined,
      undefined,
      settings(false),
    );

    assert.deepEqual(names(results), ["photo.jpg"]);
    assert.deepEqual(
      skipped.sort((a, b) => a.file.localeCompare(b.file)),
      [
        { file: "disk-image.iso", reason: "other_type_excluded" },
        { file: "installer.exe", reason: "other_type_excluded" },
      ],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("walkNas includes other file types when indexing them is enabled", () => {
  const root = makeFixture();
  try {
    const results: FileEntry[] = [];
    const skipped: string[] = [];

    walkNas(
      root,
      new Set(),
      results,
      undefined,
      (file, reason) => skipped.push(`${path.basename(file)}:${reason}`),
      undefined,
      undefined,
      undefined,
      undefined,
      settings(true),
    );

    assert.deepEqual(names(results), ["disk-image.iso", "installer.exe", "photo.jpg"]);
    assert.deepEqual(skipped, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("walkNasAsync excludes and then includes other file types in a real queue scan", async () => {
  const root = makeFixture();
  try {
    const excludedQueue = new ScanPriorityQueue();
    const excluded: Array<{ file: string; reason: string }> = [];

    await walkNasAsync(
      root,
      new Set(),
      excludedQueue,
      undefined,
      undefined,
      (file, reason) => excluded.push({ file: path.basename(file), reason }),
      undefined,
      undefined,
      undefined,
      undefined,
      settings(false),
    );
    excludedQueue.close();

    const excludedEntries: FileEntry[] = [];
    for (;;) {
      const entry = await excludedQueue.pop();
      if (!entry) break;
      excludedEntries.push(entry);
    }
    assert.deepEqual(names(excludedEntries), ["photo.jpg"]);
    assert.deepEqual(
      excluded.sort((a, b) => a.file.localeCompare(b.file)),
      [
        { file: "disk-image.iso", reason: "other_type_excluded" },
        { file: "installer.exe", reason: "other_type_excluded" },
      ],
    );

    const includedQueue = new ScanPriorityQueue();
    const includedSkipped: string[] = [];
    await walkNasAsync(
      root,
      new Set(),
      includedQueue,
      undefined,
      undefined,
      (file, reason) => includedSkipped.push(`${path.basename(file)}:${reason}`),
      undefined,
      undefined,
      undefined,
      undefined,
      settings(true),
    );
    includedQueue.close();

    const includedEntries: FileEntry[] = [];
    for (;;) {
      const entry = await includedQueue.pop();
      if (!entry) break;
      includedEntries.push(entry);
    }
    assert.deepEqual(names(includedEntries), ["disk-image.iso", "installer.exe", "photo.jpg"]);
    assert.deepEqual(includedSkipped, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});