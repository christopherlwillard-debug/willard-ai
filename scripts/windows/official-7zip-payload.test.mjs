import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { copyOfficialWindows7Zip } from "./official-7zip-payload.mjs";

test("release payload copies only official 7z.exe and its required DLL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "willard-official-7zip-payload-"));
  const sourceDir = path.join(root, "source");
  const destinationDir = path.join(root, "payload", "vendor");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(sourceDir, "7z.exe"), "verified official executable");
  await writeFile(path.join(sourceDir, "7z.dll"), "verified official library");
  try {
    const result = await copyOfficialWindows7Zip(path.join(sourceDir, "7z.exe"), destinationDir);
    assert.equal(await readFile(result.executablePath, "utf8"), "verified official executable");
    assert.equal(await readFile(result.dllPath, "utf8"), "verified official library");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release payload refuses an incomplete or unexpected official binary source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "willard-official-7zip-invalid-"));
  const sourceDir = path.join(root, "source");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(sourceDir, "7za.exe"), "not the expected executable");
  try {
    await assert.rejects(
      copyOfficialWindows7Zip(path.join(sourceDir, "7za.exe"), path.join(root, "payload")),
      /must be the verified 7z.exe/,
    );
    await writeFile(path.join(sourceDir, "7z.exe"), "executable without DLL");
    await assert.rejects(
      copyOfficialWindows7Zip(path.join(sourceDir, "7z.exe"), path.join(root, "payload")),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
