import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pruneSevenZipPackage } from "./prune-7zip-binaries.mjs";

function makePackageFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "willard-7zip-prune-"));
  for (const relative of [
    "index.js",
    "LICENSE",
    "linux/x64/7zzs",
    "linux/x64/7zz",
    "linux/x64/7zzc",
    "linux/x64/7zzsc",
    "linux/arm64/7zzs",
    "win/x64/7z.exe",
    "win/x64/7z.dll",
    "win/x64/7zc/7z.exe",
    "win/x64/7zc/7z.dll",
    "win/arm64/7z.exe",
    "mac/x64/7zz",
    "mac/x64/7zzc",
    "mac/arm64/7zz",
  ]) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, relative);
  }
  return root;
}

test("Linux deployment retains only the selected static 7-Zip binary", async () => {
  const root = makePackageFixture();
  try {
    const result = await pruneSevenZipPackage(root, "linux", "x64");
    assert.equal(result.requiredPath, path.join(root, "linux", "x64", "7zzs"));
    assert.equal(readFileSync(result.requiredPath, "utf8"), "linux/x64/7zzs");
    assert.equal(readFileSync(path.join(root, "index.js"), "utf8"), "index.js");
    assert.equal(readFileSync(path.join(root, "LICENSE"), "utf8"), "LICENSE");
    assert.equal(path.existsSync?.(path.join(root, "linux", "x64", "7zz")), undefined);
    assert.throws(() => readFileSync(path.join(root, "linux", "x64", "7zz"), "utf8"), { code: "ENOENT" });
    assert.throws(() => readFileSync(path.join(root, "win", "x64", "7z.exe"), "utf8"), { code: "ENOENT" });
    assert.throws(() => readFileSync(path.join(root, "linux", "arm64", "7zzs"), "utf8"), { code: "ENOENT" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows deployment retains the executable and required DLL for the selected architecture", async () => {
  const root = makePackageFixture();
  try {
    const result = await pruneSevenZipPackage(root, "win32", "x64");
    assert.equal(result.requiredPath, path.join(root, "win", "x64", "7z.exe"));
    assert.equal(readFileSync(result.requiredPath, "utf8"), "win/x64/7z.exe");
    assert.equal(readFileSync(path.join(root, "win", "x64", "7z.dll"), "utf8"), "win/x64/7z.dll");
    assert.throws(() => readFileSync(path.join(root, "win", "x64", "7zc", "7z.exe"), "utf8"), { code: "ENOENT" });
    assert.throws(() => readFileSync(path.join(root, "linux", "x64", "7zzs"), "utf8"), { code: "ENOENT" });
    assert.throws(() => readFileSync(path.join(root, "win", "arm64", "7z.exe"), "utf8"), { code: "ENOENT" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruning fails closed for unsupported or missing platform binaries", async () => {
  const root = makePackageFixture();
  try {
    await assert.rejects(pruneSevenZipPackage(root, "freebsd", "x64"), /Unsupported 7-Zip runtime platform/);
    await assert.rejects(pruneSevenZipPackage(root, "linux", "mips"), /no binary directory/);
    assert.equal(readFileSync(path.join(root, "win", "x64", "7z.exe"), "utf8"), "win/x64/7z.exe");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
