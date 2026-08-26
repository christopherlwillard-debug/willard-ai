import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

test("release scripts reject stale build directories but allow isolated test output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "willard-release-root-"));
  try {
    assert.doesNotThrow(() => assertCanonicalReleaseDirectory(path.join(root, "build", "windows"), root));
    assert.throws(
      () => assertCanonicalReleaseDirectory(path.join(root, "build", "windows-clean"), root),
      /canonical staging directory/,
    );
    assert.doesNotThrow(() => assertCanonicalReleaseDirectory(path.join(root, "tmp", "release"), root));
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