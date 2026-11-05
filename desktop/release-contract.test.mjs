import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareVersions,
  getUpdateDecision,
  signReleaseManifest,
  validateReleaseManifest,
  verifyReleaseArtifact,
} from "./release-contract.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const unsignedRelease = {
  schema: 2,
  product: "Willard Media Center",
  repository: "christopherlwillard-debug/willard-ai",
  version: "1.2.0",
  artifactName: "WillardMediaCenter-1.2.0-windows-x64.zip",
  artifactUrl: "https://github.com/christopherlwillard-debug/willard-ai/releases/download/v1.2.0/WillardMediaCenter-1.2.0-windows-x64.zip",
  sha256: "a".repeat(64),
  sourceArtifactName: "WillardMediaCenter-1.2.0-source.zip",
  sourceArtifactUrl: "https://github.com/christopherlwillard-debug/willard-ai/releases/download/v1.2.0/WillardMediaCenter-1.2.0-source.zip",
  sourceSha256: "b".repeat(64),
  notes: "Test release.",
  minimumWindowsVersion: "10",
};
const release = { ...unsignedRelease, signature: signReleaseManifest(unsignedRelease, privateKey) };
const releaseContractPath = fileURLToPath(new URL("./release-contract.mjs", import.meta.url));

test("compares stable releases and SemVer prerelease identifiers safely", () => {
  assert.equal(compareVersions("1.2.0", "1.1.9"), 1);
  assert.equal(compareVersions("1.2.0-beta.1", "1.2.0"), -1);
  assert.equal(compareVersions("1.2.0-beta.10", "1.2.0-beta.2"), 1);
  assert.equal(compareVersions("1.2.0-beta.2", "1.2.0-beta.10"), -1);
  assert.equal(compareVersions("1.2.0-beta.1", "1.2.0-beta.alpha"), -1);
  assert.equal(compareVersions("1.2.0-beta.alpha", "1.2.0-beta.1"), 1);
  assert.equal(compareVersions("1.2.0-beta.1", "1.2.0-beta.1.1"), -1);
  assert.equal(compareVersions("1.2.0", "1.2.0"), 0);

  for (const invalid of [
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-beta.",
    "1.2.3-beta..1",
    "1.2.3-beta.01",
  ]) {
    assert.throws(() => compareVersions(invalid, "1.2.3"), /Release versions/);
  }
});

test("release-contract CLI compares semantic versions for the Windows launcher", () => {
  const compare = (left, right) => Number(execFileSync(
    process.execPath,
    [releaseContractPath, "--compare", left, right],
    { encoding: "utf8" },
  ).trim());
  assert.equal(compare("1.2.0", "1.2.0-beta.1"), 1);
  assert.equal(compare("1.2.0-beta.10", "1.2.0-beta.2"), 1);
  assert.equal(compare("1.2.0-beta.2", "1.2.0-beta.10"), -1);
});

test("rejects incomplete or unsafe release descriptions", () => {
  assert.throws(() => validateReleaseManifest({ ...release, sha256: "bad" }, { publicKey }), /checksum/);
  assert.throws(() => validateReleaseManifest({ ...release, artifactUrl: "file:///tmp/app.zip" }, { publicKey }), /artifact address/);
  assert.throws(() => validateReleaseManifest({ ...release, product: "Other App" }, { publicKey }), /wrong product/);
  assert.throws(() => validateReleaseManifest({ ...release, sha256: "c".repeat(64) }, { publicKey }), /signature/);
  assert.throws(() => validateReleaseManifest({ ...release, artifactUrl: "https://evil.example/download.zip" }, { publicKey }), /artifact address/);
});

test("only offers a newer verified release", () => {
  assert.equal(getUpdateDecision("1.1.0", release, { publicKey }).available, true);
  assert.equal(getUpdateDecision("1.2.0", release, { publicKey }).available, false);
  assert.equal(getUpdateDecision("1.2.0-beta.1", release, { publicKey }).available, true);
});

test("rejects altered artifact bytes before installation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "willard-release-contract-"));
  const artifactPath = path.join(root, "WillardMediaCenter-1.2.0-windows-x64.zip");
  try {
    const bytes = Buffer.from("authentic signed release bytes");
    const signed = {
      ...unsignedRelease,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    signed.signature = signReleaseManifest(signed, privateKey);
    await writeFile(artifactPath, bytes);
    await verifyReleaseArtifact(signed, artifactPath, { publicKey });
    await writeFile(artifactPath, Buffer.from("altered runtime"));
    await assert.rejects(
      () => verifyReleaseArtifact(signed, artifactPath, { publicKey }),
      /signed artifact checksum/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});