import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveSevenZipPath } from "../lib/sevenzip.ts";

test("configured 7-Zip path takes precedence when it exists", () => {
  assert.equal(
    resolveSevenZipPath({
      platform: "linux",
      pathEnv: "/usr/bin",
      configuredPath: "/opt/willard/7zz",
      fallbackPath: "/legacy/7za",
      exists: (candidate) => candidate === "/opt/willard/7zz",
    }),
    "/opt/willard/7zz",
  );
});

test("Linux prefers the official static 7zzs binary over 7zz and legacy fallback", () => {
  const available = new Set([path.join("/nix/store/7zip/bin", "7zzs"), path.join("/nix/store/7zip/bin", "7zz")]);
  assert.equal(
    resolveSevenZipPath({
      platform: "linux",
      pathEnv: "/nix/store/7zip/bin",
      fallbackPath: "/legacy/7za",
      exists: (candidate) => available.has(candidate),
    }),
    path.join("/nix/store/7zip/bin", "7zzs"),
  );
});

test("Linux falls back to official dynamic 7zz when static 7zzs is absent", () => {
  const candidate = path.join("/usr/local/bin", "7zz");
  assert.equal(
    resolveSevenZipPath({
      platform: "linux",
      pathEnv: "/usr/local/bin",
      fallbackPath: "/legacy/7za",
      exists: (value) => value === candidate,
    }),
    candidate,
  );
});

test("missing system binaries preserve the bundled compatibility fallback", () => {
  assert.equal(
    resolveSevenZipPath({
      platform: "linux",
      pathEnv: "",
      fallbackPath: "/legacy/7za",
      exists: () => false,
    }),
    "/legacy/7za",
  );
});

test("Windows continues to use its bundled executable unless explicitly configured", () => {
  assert.equal(
    resolveSevenZipPath({
      platform: "win32",
      pathEnv: "C:\\tools",
      fallbackPath: "C:\\app\\7za.exe",
      exists: (candidate) => candidate === "C:\\app\\7za.exe",
    }),
    "C:\\app\\7za.exe",
  );
});

test("packaged official Windows binary takes precedence over legacy fallback", () => {
  const packaged = path.join("C:\\", "Willard", "api-runtime", "dist", "vendor", "7z.exe");
  assert.equal(
    resolveSevenZipPath({
      platform: "win32",
      pathEnv: "C:\\tools",
      packagedPath: packaged,
      fallbackPath: "C:\\app\\7za.exe",
      exists: (candidate) => candidate === packaged,
    }),
    packaged,
  );
});

test("compiled API resolves the bundled 7-Zip folder beside api-runtime", () => {
  const moduleUrl = pathToFileURL("/tmp/willard/api-runtime/dist/index.mjs").href;
  const packaged = path.join("/tmp/willard/api-runtime", "vendor", "7zip", "7zzs");
  assert.equal(
    resolveSevenZipPath({
      platform: "linux",
      pathEnv: "",
      moduleUrl,
      fallbackPath: "/legacy/7za",
      exists: (candidate) => candidate === packaged,
    }),
    packaged,
  );
});
