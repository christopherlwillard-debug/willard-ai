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
  compareWindowsVersions,
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

test("compares stable releases and semantic prerelease identifiers safely", () => {
  assert.equal(compareVersions("1.2.0", "1.1.9"), 1);
  assert.equal(compareVersions("1.2.0-beta.1", "1.2.0"), -1);
  assert.equal(compareVersions("1.2.0-beta.10", "1.2.0-beta.2"), 1);
  assert.equal(compareVersions("1.2.0-beta.2", "1.2.0-beta.10"), -1);
  assert.equal(compareVersions("1.2.0-beta.1", "1.2.0-beta.alpha"), -1);
  assert.equal(compareVersions("1.2.0-beta.alpha", "1.2.0-beta.1"), 1);
  assert.equal(compareVersions("1.2.0-beta.1", "1.2.0-beta.1.1"), -1);
  assert.equal(compareVersions("1.2.0-alpha.10", "1.2.0-alpha.2"), 1);
  assert.equal(compareVersions("1.2.0-alpha.2", "1.2.0-alpha.beta"), -1);
  assert.equal(compareVersions("1.2.0-alpha", "1.2.0-alpha.1"), -1);
  assert.equal(compareVersions("9007199254740993.0.0", "9007199254740992.0.0"), 1);
  assert.equal(
    compareVersions("1.2.0-alpha.9007199254740993", "1.2.0-alpha.9007199254740992"),
    1,
  );
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

test("compares Windows NT versions numerically, including Windows 11 build thresholds", () => {
  assert.equal(compareWindowsVersions("10.0.19045", "10"), 1);
  assert.equal(compareWindowsVersions("10.0.22000", "10.0.22000"), 0);
  assert.equal(compareWindowsVersions("10.0.22631", "10.0.22000"), 1);
  assert.equal(compareWindowsVersions("10.0.19045", "10.0.22000"), -1);
  assert.equal(compareWindowsVersions("6.3.9600", "10"), -1);

  for (const invalid of [
    "Windows 10",
    "10..22000",
    "10.00.1",
    "10.0.22000.1",
    "10.0.9007199254740992",
  ]) {
    assert.throws(
      () => compareWindowsVersions(invalid, "10"),
      /Windows versions must use/,
    );
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
  const compareWindows = (current, minimum) => Number(execFileSync(
    process.execPath,
    [releaseContractPath, "--compare-windows", current, minimum],
    { encoding: "utf8" },
  ).trim());
  assert.equal(compareWindows("10.0.19045", "10"), 1);
  assert.equal(compareWindows("10.0.19045", "10.0.22000"), -1);
});

test("CLI verifies signed stable and prerelease manifests before making update decisions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "willard-release-cli-"));
  const manifestPath = path.join(root, "release-manifest.json");
  const publicKeyPath = path.join(root, "test-public-key.pem");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const createSignedRelease = (version) => {
    const artifactName = `WillardMediaCenter-${version}-windows-x64.zip`;
    const sourceArtifactName = `WillardMediaCenter-${version}-source.zip`;
    const manifest = {
      ...unsignedRelease,
      version,
      artifactName,
      artifactUrl: `https://github.com/christopherlwillard-debug/willard-ai/releases/download/v${version}/${artifactName}`,
      sourceArtifactName,
      sourceArtifactUrl: `https://github.com/christopherlwillard-debug/willard-ai/releases/download/v${version}/${sourceArtifactName}`,
    };
    return { ...manifest, signature: signReleaseManifest(manifest, privateKey) };
  };
  const decide = (currentVersion) => JSON.parse(execFileSync(
    process.execPath,
    [
      releaseContractPath,
      "--update-decision",
      currentVersion,
      manifestPath,
      "--public-key",
      publicKeyPath,
    ],
    { encoding: "utf8" },
  ));
  const writeManifest = async (manifest) => {
    await writeFile(manifestPath, JSON.stringify(manifest));
  };

  try {
    await writeFile(publicKeyPath, publicKeyPem);
    const stable = createSignedRelease("1.2.0");
    await writeManifest(stable);
    assert.deepEqual(decide("1.2.0-beta.1"), { available: true, version: "1.2.0" });

    const prerelease = createSignedRelease("1.2.0-beta.10");
    await writeManifest(prerelease);
    assert.deepEqual(decide("1.2.0-beta.2"), { available: true, version: "1.2.0-beta.10" });

    await writeManifest({ ...stable, notes: "changed after signing" });
    assert.throws(
      () => decide("1.1.0"),
      (error) => error.status === 1 && String(error.stderr).includes("signature verification"),
    );

    await writeManifest({ ...stable, version: "1.2.0-beta..1" });
    assert.throws(
      () => decide("1.1.0"),
      (error) => error.status === 1 && String(error.stderr).includes("invalid version"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects incomplete or unsafe release descriptions", () => {
  assert.throws(() => validateReleaseManifest({ ...release, sha256: "bad" }, { publicKey }), /checksum/);
  assert.throws(() => validateReleaseManifest({ ...release, artifactUrl: "file:///tmp/app.zip" }, { publicKey }), /artifact address/);
  assert.throws(() => validateReleaseManifest({ ...release, product: "Other App" }, { publicKey }), /wrong product/);
  assert.throws(() => validateReleaseManifest({ ...release, sha256: "c".repeat(64) }, { publicKey }), /signature/);
  assert.throws(() => validateReleaseManifest({ ...release, artifactUrl: "https://evil.example/download.zip" }, { publicKey }), /artifact address/);
});

test("validates signed minimum Windows requirements", () => {
  const windows11Unsigned = { ...unsignedRelease, minimumWindowsVersion: "10.0.22000" };
  const windows11Release = {
    ...windows11Unsigned,
    signature: signReleaseManifest(windows11Unsigned, privateKey),
  };
  assert.equal(
    validateReleaseManifest(windows11Release, { publicKey }).minimumWindowsVersion,
    "10.0.22000",
  );

  for (const invalid of [
    "Windows 11",
    "10..22000",
    "10.00.1",
    "10.0.22000.1",
    "10.0.9007199254740992",
  ]) {
    assert.throws(
      () => signReleaseManifest({ ...unsignedRelease, minimumWindowsVersion: invalid }, privateKey),
      /Windows requirement/,
    );
  }
  assert.throws(
    () => validateReleaseManifest({ ...release, minimumWindowsVersion: 0 }, { publicKey }),
    /Windows requirement/,
  );
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