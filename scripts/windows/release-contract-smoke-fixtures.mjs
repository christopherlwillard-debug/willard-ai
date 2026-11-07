import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [contractPath, outputRoot] = process.argv.slice(2);
if (!contractPath || !outputRoot) {
  throw new Error("Usage: release-contract-smoke-fixtures.mjs <release-contract.mjs> <output-directory>");
}

const { signReleaseManifest } = await import(pathToFileURL(path.resolve(contractPath)).href);
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
await mkdir(outputRoot, { recursive: true });
await writeFile(
  path.join(outputRoot, "test-public-key.pem"),
  publicKey.export({ type: "spki", format: "pem" }),
  "utf8",
);

function createRelease(version) {
  const artifactName = `WillardMediaCenter-${version}-windows-x64.zip`;
  const sourceArtifactName = `WillardMediaCenter-${version}-source.zip`;
  const manifest = {
    schema: 2,
    product: "Willard Media Center",
    repository: "christopherlwillard-debug/willard-ai",
    version,
    artifactName,
    artifactUrl: `https://github.com/christopherlwillard-debug/willard-ai/releases/download/v${version}/${artifactName}`,
    sha256: "a".repeat(64),
    sourceArtifactName,
    sourceArtifactUrl: `https://github.com/christopherlwillard-debug/willard-ai/releases/download/v${version}/${sourceArtifactName}`,
    sourceSha256: "b".repeat(64),
    notes: "Packaged Windows updater smoke fixture.",
    minimumWindowsVersion: "10.0.19045",
  };
  return { ...manifest, signature: signReleaseManifest(manifest, privateKey) };
}

const stable = createRelease("2.0.0");
const prerelease = createRelease("2.0.0-beta.10");
const fixtures = {
  "stable.json": stable,
  "prerelease.json": prerelease,
  "invalid-signature.json": {
    ...stable,
    signature: Buffer.alloc(64, 0x42).toString("base64"),
  },
  "malformed-version.json": {
    ...stable,
    version: "2.0.0-beta..1",
  },
};

for (const [name, manifest] of Object.entries(fixtures)) {
  await writeFile(path.join(outputRoot, name), `${JSON.stringify(manifest)}\n`, "utf8");
}
