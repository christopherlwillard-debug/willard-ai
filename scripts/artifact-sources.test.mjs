import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertCanonicalArtifactSources,
  assertNoTrackedGeneratedOutputs,
  findArtifactManifests,
} from "./artifact-sources.mjs";

const apiManifest = `kind = "api"
[[services]]
localPort = 8080
`;

test("repository artifact discovery ignores generated staging trees", async () => {
  const root = await fsFixture();
  try {
    await mkdir(path.join(root, "artifacts/api-server/.replit-artifact"), { recursive: true });
    await mkdir(path.join(root, "build/windows/api-runtime/.replit-artifact"), { recursive: true });
    await writeFile(
      path.join(root, "artifacts/api-server/.replit-artifact/artifact.toml"),
      apiManifest,
    );
    await writeFile(
      path.join(root, "build/windows/api-runtime/.replit-artifact/artifact.toml"),
      apiManifest,
    );

    const manifests = await findArtifactManifests(root);
    assert.deepEqual(manifests.map((manifest) => manifest.path), [
      "artifacts/api-server/.replit-artifact/artifact.toml",
    ]);
    assert.doesNotThrow(() => assertCanonicalArtifactSources(manifests));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact discovery rejects duplicate API or port-8080 sources", () => {
  const manifests = [
    { path: "artifacts/api-server/.replit-artifact/artifact.toml", contents: apiManifest },
    { path: "artifacts/api-server-copy/.replit-artifact/artifact.toml", contents: apiManifest },
  ];
  assert.throws(
    () => assertCanonicalArtifactSources(manifests),
    /exactly one API artifact manifest/,
  );
});

test("release ZIPs and build trees cannot be tracked", () => {
  assert.doesNotThrow(() =>
    assertNoTrackedGeneratedOutputs([
      "artifacts/api-server/src/index.ts",
      "docs/release-validation.md",
    ]),
  );
  assert.throws(
    () => assertNoTrackedGeneratedOutputs(["build/windows/payload-manifest.json"]),
    /Generated release outputs/,
  );
  assert.throws(
    () => assertNoTrackedGeneratedOutputs(["willard-media-center.zip"]),
    /Generated release outputs/,
  );
});

async function fsFixture() {
  return mkdtemp(path.join(os.tmpdir(), "willard-artifact-sources-"));
}