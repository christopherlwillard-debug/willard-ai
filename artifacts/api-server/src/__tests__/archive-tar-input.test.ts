import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { getSevenZipPath } from "../lib/sevenzip.ts";
import * as tar from "tar";

import {
  getTarCompression,
  shouldTreatAsStandaloneCompressedFile,
  withTarInput,
} from "../lib/archive-tar-input.ts";

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "willard-tar-input-"));
}

async function createTarFixture(root: string): Promise<string> {
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "payload.txt"), "archive preview payload");
  const tarPath = path.join(root, "fixture.tar");
  await tar.create({ file: tarPath, cwd: source }, ["payload.txt"]);
  return tarPath;
}

async function assertPreviewListsPayload(archivePath: string, filename: string, scratchDir: string): Promise<void> {
  await withTarInput(archivePath, filename, scratchDir, async (tarPath, options) => {
    const names: string[] = [];
    await tar.list({
      file: tarPath,
      ...options,
      strict: true,
      onentry: (entry: any) => names.push(entry.path),
    });
    assert.deepEqual(names, ["payload.txt"]);
  });
  assert.deepEqual(fs.readdirSync(scratchDir), [], "decompressed scratch TAR must be removed");
}

test("resolves TAR compression from full and compound filename suffixes", () => {
  assert.equal(getTarCompression("backup.tar"), "none");
  assert.equal(getTarCompression("backup.tar.gz"), "gzip");
  assert.equal(getTarCompression("backup.tgz"), "gzip");
  assert.equal(getTarCompression("backup.gz"), "gzip");
  assert.equal(getTarCompression("backup.tar.bz2"), "bzip2");
  assert.equal(getTarCompression("backup.tbz2"), "bzip2");
  assert.equal(getTarCompression("backup.bz2"), "bzip2");
  assert.equal(getTarCompression("backup.tar.xz"), "xz");
  assert.equal(getTarCompression("backup.txz"), "xz");
  assert.equal(getTarCompression("backup.xz"), "xz");
});

test("only an empty parse failure for a bare compressed suffix is treated as a standalone file", () => {
  for (const filename of ["backup.gz", "backup.bz2", "backup.xz"]) {
    assert.equal(shouldTreatAsStandaloneCompressedFile(filename, 0, "tar-parse"), true);
    assert.equal(shouldTreatAsStandaloneCompressedFile(filename, 1, "tar-parse"), false);
    assert.equal(shouldTreatAsStandaloneCompressedFile(filename, 0, "input"), false);
  }
  for (const filename of ["backup.tar.gz", "backup.tar.bz2", "backup.tar.xz", "backup.tgz", "backup.tbz2", "backup.txz"]) {
    assert.equal(shouldTreatAsStandaloneCompressedFile(filename, 0, "tar-parse"), false);
  }
});

test("gzip-compressed TAR preview reads entries and removes its temporary input", async () => {
  const root = makeRoot();
  try {
    const tarPath = await createTarFixture(root);
    const archivePath = path.join(root, "fixture.tar.gz");
    const scratchDir = path.join(root, "scratch");
    fs.mkdirSync(scratchDir);
    fs.writeFileSync(archivePath, gzipSync(fs.readFileSync(tarPath)));
    await assertPreviewListsPayload(archivePath, "fixture.tar.gz", scratchDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("official 7-Zip bzip2 TAR preview reads entries and removes its temporary input", async (t) => {
  const root = makeRoot();
  try {
    let sevenZip: string;
    try {
      sevenZip = getSevenZipPath();
    } catch {
      t.skip("official 7-Zip is not available on this runner");
      return;
    }
    const tarPath = await createTarFixture(root);
    const archivePath = path.join(root, "fixture.tar.bz2");
    const packed = spawnSync(sevenZip, ["a", "-tbzip2", archivePath, tarPath], {
      cwd: root,
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(packed.status, 0, packed.stderr.toString());
    const scratchDir = path.join(root, "scratch");
    fs.mkdirSync(scratchDir);
    await assertPreviewListsPayload(archivePath, "fixture.tar.bz2", scratchDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("official 7-Zip xz TAR preview reads entries and removes its temporary input", async (t) => {
  const root = makeRoot();
  try {
    let sevenZip: string;
    try {
      sevenZip = getSevenZipPath();
    } catch {
      t.skip("official 7-Zip is not available on this runner");
      return;
    }
    const tarPath = await createTarFixture(root);
    const archivePath = path.join(root, "fixture.tar.xz");
    const packed = spawnSync(sevenZip, ["a", "-txz", archivePath, tarPath], {
      cwd: root,
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(packed.status, 0, packed.stderr.toString());
    const scratchDir = path.join(root, "scratch");
    fs.mkdirSync(scratchDir);
    await assertPreviewListsPayload(archivePath, "fixture.tar.xz", scratchDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid compressed input fails and leaves no partial scratch TAR", async (t) => {
  const root = makeRoot();
  try {
    let sevenZip: string;
    try {
      sevenZip = getSevenZipPath();
    } catch {
      t.skip("official 7-Zip is not available on this runner");
      return;
    }
    const archivePath = path.join(root, "broken.tar.xz");
    const scratchDir = path.join(root, "scratch");
    fs.mkdirSync(scratchDir);
    fs.writeFileSync(archivePath, "not an xz stream");
    await assert.rejects(
      withTarInput(archivePath, "broken.tar.xz", scratchDir, async () => undefined),
    );
    assert.deepEqual(fs.readdirSync(scratchDir), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("archive preview uses shared bounded decompression and rejects partial parse results", () => {
  const routeSource = fs.readFileSync(new URL("../routes/archives.ts", import.meta.url), "utf8");
  assert.match(routeSource, /peekTarWithPrivateScratch\(archivePath, archive\.filename, nasPath\)/);
  assert.ok(routeSource.includes("getTempDir(nasPath, `archive-preview-${randomUUID()}`)"));
  assert.ok(routeSource.includes("cleanTempDir(scratchDir, nasPath)"));
  assert.match(routeSource, /shouldTreatAsStandaloneCompressedFile\(archive\.filename, entries\.length, failureKind\)/);
  assert.match(routeSource, /Never persist a partial listing as a successful archive preview/);
  assert.ok(routeSource.includes('throw new Error(`Archive preview failed: ${error}`)'));
});
