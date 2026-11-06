import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createSevenZipPathResolver,
  getSevenZipPath,
  resolveSevenZipPath,
} from "../lib/sevenzip.ts";

const officialVersion = async () => "26.05";

const resolverSource = readFileSync(new URL("../lib/sevenzip.ts", import.meta.url), "utf8");

test("production 7-Zip version probing uses the tracked asynchronous runner", () => {
  assert.ok(resolverSource.includes('runMediaToolAsync(candidate, ["i"]'));
  assert.ok(resolverSource.includes("timeoutMs: 10_000"));
  assert.ok(resolverSource.includes("maxBufferBytes: 64 * 1024"));
  assert.ok(!resolverSource.includes("spawnSync"));
});

test("configured official 7-Zip path takes precedence when its version is supported", async () => {
  assert.equal(
    await resolveSevenZipPath({
      platform: "linux",
      pathEnv: "/usr/bin",
      configuredPath: "/opt/willard/7zz",
      exists: (candidate) => candidate === "/opt/willard/7zz",
      getVersion: officialVersion,
    }),
    "/opt/willard/7zz",
  );
});

test("outdated configured binaries are skipped in favor of a verified official system binary", async () => {
  const current = path.join("/nix/store/7zip/bin", "7zzs");
  assert.equal(
    await resolveSevenZipPath({
      platform: "linux",
      pathEnv: "/nix/store/7zip/bin",
      configuredPath: "/opt/legacy/7za",
      exists: (candidate) => candidate === "/opt/legacy/7za" || candidate === current,
      getVersion: async (candidate) => candidate === current ? "26.05" : "16.02",
    }),
    current,
  );
});

test("Linux prefers verified official static 7zzs over dynamic 7zz", async () => {
  const staticBinary = path.join("/nix/store/7zip/bin", "7zzs");
  const dynamicBinary = path.join("/nix/store/7zip/bin", "7zz");
  assert.equal(
    await resolveSevenZipPath({
      platform: "linux",
      pathEnv: "/nix/store/7zip/bin",
      exists: (candidate) => candidate === staticBinary || candidate === dynamicBinary,
      getVersion: async () => "26.05",
    }),
    staticBinary,
  );
});

test("Linux uses official dynamic 7zz when static 7zzs is absent", async () => {
  const candidate = path.join("/usr/local/bin", "7zz");
  assert.equal(
    await resolveSevenZipPath({
      platform: "linux",
      pathEnv: "/usr/local/bin",
      exists: (value) => value === candidate,
      getVersion: officialVersion,
    }),
    candidate,
  );
});

test("missing or outdated binaries fail closed instead of using bundled p7zip", async () => {
  assert.equal(
    await resolveSevenZipPath({
      platform: "linux",
      pathEnv: "",
      exists: () => false,
      getVersion: async () => undefined,
    }),
    undefined,
  );
  assert.equal(
    await resolveSevenZipPath({
      platform: "linux",
      pathEnv: "/usr/bin",
      exists: () => true,
      getVersion: async () => "16.02",
    }),
    undefined,
  );
});

test("Windows resolves official system 7-Zip instead of a legacy bundled executable", async () => {
  const candidate = path.join("C:\\tools", "7z.exe");
  assert.equal(
    await resolveSevenZipPath({
      platform: "win32",
      pathEnv: "C:\\tools",
      exists: (value) => value === candidate,
      getVersion: officialVersion,
    }),
    candidate,
  );
});

test("packaged official Windows binary takes precedence at api-runtime/vendor/7zip", async () => {
  const moduleUrl = pathToFileURL("/tmp/willard/api-runtime/dist/index.mjs").href;
  const packaged = path.join("/tmp/willard/api-runtime", "vendor", "7zip", "7z.exe");
  assert.equal(
    await resolveSevenZipPath({
      platform: "win32",
      pathEnv: "C:\\tools",
      moduleUrl,
      exists: (candidate) => candidate === packaged || candidate.endsWith("7z.exe"),
      getVersion: async (candidate) => candidate === packaged ? "26.05" : "16.02",
    }),
    packaged,
  );
});

test("compiled API resolves the bundled official 7-Zip folder beside api-runtime", async () => {
  const moduleUrl = pathToFileURL("/tmp/willard/api-runtime/dist/index.mjs").href;
  const packaged = path.join("/tmp/willard/api-runtime", "vendor", "7zip", "7zzs");
  assert.equal(
    await resolveSevenZipPath({
      platform: "linux",
      pathEnv: "",
      moduleUrl,
      exists: (candidate) => candidate === packaged,
      getVersion: officialVersion,
    }),
    packaged,
  );
});

test("archive operations return an actionable error when no official binary is available", async () => {
  await assert.rejects(
    getSevenZipPath({
      platform: "linux",
      pathEnv: "",
      exists: () => false,
      getVersion: async () => undefined,
    }),
    /official 7-Zip 26\.01 or newer.*WILLARD_7ZIP_PATH/,
  );
});

test("resolver coalesces concurrent version probes and caches a verified path", async () => {
  let calls = 0;
  const resolve = createSevenZipPathResolver({
    platform: "linux",
    pathEnv: "",
    configuredPath: "/opt/willard/7zz",
    exists: (candidate) => candidate === "/opt/willard/7zz",
    getVersion: async () => {
      calls++;
      await new Promise<void>((done) => setImmediate(done));
      return "26.05";
    },
  });

  const [first, second] = await Promise.all([resolve(), resolve()]);
  assert.equal(first, "/opt/willard/7zz");
  assert.equal(second, first);
  assert.equal(await resolve(), first);
  assert.equal(calls, 1);
});

test("resolver retries a negative result so an operator can install 7-Zip without restarting", async () => {
  let calls = 0;
  const resolve = createSevenZipPathResolver({
    platform: "linux",
    pathEnv: "",
    configuredPath: "/opt/willard/7zz",
    exists: (candidate) => candidate === "/opt/willard/7zz",
    getVersion: async () => (++calls === 1 ? undefined : "26.05"),
  });

  assert.equal(await resolve(), undefined);
  assert.equal(await resolve(), "/opt/willard/7zz");
  assert.equal(calls, 2);
});
