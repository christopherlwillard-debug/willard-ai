import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getSevenZipPath, resolveSevenZipPath } from "../lib/sevenzip.ts";

const officialVersion = () => "26.05";

test("configured official 7-Zip path takes precedence when its version is supported", () => {
  assert.equal(
    resolveSevenZipPath({
      platform: "linux",
      pathEnv: "/usr/bin",
      configuredPath: "/opt/willard/7zz",
      exists: (candidate) => candidate === "/opt/willard/7zz",
      getVersion: officialVersion,
    }),
    "/opt/willard/7zz",
  );
});

test("outdated configured binaries are skipped in favor of a verified official system binary", () => {
  const current = path.join("/nix/store/7zip/bin", "7zzs");
  assert.equal(
    resolveSevenZipPath({
      platform: "linux",
      pathEnv: "/nix/store/7zip/bin",
      configuredPath: "/opt/legacy/7za",
      exists: (candidate) => candidate === "/opt/legacy/7za" || candidate === current,
      getVersion: (candidate) => candidate === current ? "26.05" : "16.02",
    }),
    current,
  );
});

test("Linux prefers verified official static 7zzs over dynamic 7zz", () => {
  const staticBinary = path.join("/nix/store/7zip/bin", "7zzs");
  const dynamicBinary = path.join("/nix/store/7zip/bin", "7zz");
  assert.equal(
    resolveSevenZipPath({
      platform: "linux",
      pathEnv: "/nix/store/7zip/bin",
      exists: (candidate) => candidate === staticBinary || candidate === dynamicBinary,
      getVersion: (candidate) => candidate === staticBinary ? "26.05" : "26.05",
    }),
    staticBinary,
  );
});

test("Linux uses official dynamic 7zz when static 7zzs is absent", () => {
  const candidate = path.join("/usr/local/bin", "7zz");
  assert.equal(
    resolveSevenZipPath({
      platform: "linux",
      pathEnv: "/usr/local/bin",
      exists: (value) => value === candidate,
      getVersion: officialVersion,
    }),
    candidate,
  );
});

test("missing or outdated binaries fail closed instead of using bundled p7zip", () => {
  assert.equal(
    resolveSevenZipPath({
      platform: "linux",
      pathEnv: "",
      exists: () => false,
      getVersion: () => undefined,
    }),
    undefined,
  );
  assert.equal(
    resolveSevenZipPath({
      platform: "linux",
      pathEnv: "/usr/bin",
      exists: () => true,
      getVersion: () => "16.02",
    }),
    undefined,
  );
});

test("Windows resolves official system 7-Zip instead of a legacy bundled executable", () => {
  const candidate = path.join("C:\\tools", "7z.exe");
  assert.equal(
    resolveSevenZipPath({
      platform: "win32",
      pathEnv: "C:\\tools",
      exists: (value) => value === candidate,
      getVersion: officialVersion,
    }),
    candidate,
  );
});

test("packaged official Windows binary takes precedence over system PATH", () => {
  const packaged = path.join("C:\\", "Willard", "api-runtime", "dist", "vendor", "7z.exe");
  assert.equal(
    resolveSevenZipPath({
      platform: "win32",
      pathEnv: "C:\\tools",
      packagedPath: packaged,
      exists: (candidate) => candidate === packaged || candidate.endsWith("7z.exe"),
      getVersion: (candidate) => candidate === packaged ? "26.05" : "16.02",
    }),
    packaged,
  );
});

test("compiled API resolves the bundled official 7-Zip folder beside api-runtime", () => {
  const moduleUrl = pathToFileURL("/tmp/willard/api-runtime/dist/index.mjs").href;
  const packaged = path.join("/tmp/willard/api-runtime", "vendor", "7zip", "7zzs");
  assert.equal(
    resolveSevenZipPath({
      platform: "linux",
      pathEnv: "",
      moduleUrl,
      exists: (candidate) => candidate === packaged,
      getVersion: officialVersion,
    }),
    packaged,
  );
});

test("archive operations return an actionable error when no official binary is available", () => {
  assert.throws(
    () => getSevenZipPath({
      platform: "linux",
      pathEnv: "",
      exists: () => false,
      getVersion: () => undefined,
    }),
    /official 7-Zip 26\.01 or newer.*WILLARD_7ZIP_PATH/,
  );
});
