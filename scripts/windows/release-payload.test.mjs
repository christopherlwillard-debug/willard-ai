import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import {
  assertCanonicalReleaseDirectory,
  assertLocalHtmlReferences,
  createPayloadManifest,
  validatePayloadManifest,
  writePayloadManifest,
} from "./release-payload.mjs";

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "willard-release-payload-"));
  await mkdir(path.join(root, "desktop"), { recursive: true });
  await mkdir(path.join(root, "web", "assets"), { recursive: true });
  await writeFile(path.join(root, "desktop", "loading.html"), '<video src="../web/willard-loading.mp4"></video>');
  await writeFile(path.join(root, "web", "index.html"), '<script src="/assets/app.js"></script><link href="/favicon.svg">');
  await writeFile(path.join(root, "web", "assets", "app.js"), "console.log('willard');");
  await writeFile(path.join(root, "web", "favicon.svg"), "<svg></svg>");
  await writeFile(path.join(root, "web", "willard-loading.mp4"), "video");
  return root;
}

test("payload manifests are deterministic and validate local HTML assets", async () => {
  const first = await createFixture();
  const second = await createFixture();
  try {
    const firstManifest = await writePayloadManifest(first, "1.2.3");
    const secondManifest = await writePayloadManifest(second, "1.2.3");
    assert.deepEqual(firstManifest, secondManifest);
    await assertLocalHtmlReferences(first, "desktop/loading.html");
    await assertLocalHtmlReferences(first, "web/index.html");
    assert.deepEqual(await validatePayloadManifest(first, "1.2.3"), firstManifest);
  } finally {
    await Promise.all([rm(first, { recursive: true, force: true }), rm(second, { recursive: true, force: true })]);
  }
});

test("payload validation detects generated drift and missing files", async () => {
  const root = await createFixture();
  try {
    await writePayloadManifest(root, "1.2.3");
    await writeFile(path.join(root, "web", "assets", "app.js"), "changed");
    await assert.rejects(() => validatePayloadManifest(root, "1.2.3"), /drift detected/);
    await assert.rejects(() => assertLocalHtmlReferences(root, "desktop/missing.html"), /ENOENT|access/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows release stages official 7-Zip at the API resolver path", async () => {
  const buildSource = await readFile(new URL("./build-release.mjs", import.meta.url), "utf8");
  const resolverSource = await readFile(
    new URL("../../artifacts/api-server/src/lib/sevenzip.ts", import.meta.url),
    "utf8",
  );
  assert.match(buildSource, /path\.join\(deployOutput, "dist", "vendor", "7zip"\)/);
  assert.match(resolverSource, /"\.\.\/vendor\/7zip", packagedName/);
});

test("release scripts only accept canonical staging and reject symlinked build paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "willard-release-root-"));
  try {
    const canonical = path.join(root, "build", "windows");
    await mkdir(canonical, { recursive: true });
    assert.doesNotThrow(() => assertCanonicalReleaseDirectory(canonical, root));
    assert.throws(
      () => assertCanonicalReleaseDirectory(path.join(root, "build", "windows-clean"), root),
      /canonical staging directory/,
    );
    assert.throws(
      () => assertCanonicalReleaseDirectory(path.join(root, "tmp", "release"), root),
      /canonical staging directory/,
    );

    const realBuild = path.join(root, "real-build");
    await mkdir(realBuild);
    await rm(path.join(root, "build"), { recursive: true, force: true });
    await symlink(realBuild, path.join(root, "build"), "dir");
    assert.throws(
      () => assertCanonicalReleaseDirectory(canonical, root),
      /real directory, not a symlink or file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("payload manifests do not include their own generated file", async () => {
  const root = await createFixture();
  try {
    await writePayloadManifest(root, "1.2.3");
    const manifest = JSON.parse(await readFile(path.join(root, "payload-manifest.json"), "utf8"));
    assert.equal(manifest.files.some((entry) => entry.path === "payload-manifest.json"), false);
    assert.equal((await createPayloadManifest(root, "1.2.3")).files.length, manifest.files.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});