import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
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
      exists: () => true,
    }),
    "C:\\app\\7za.exe",
  );
});
