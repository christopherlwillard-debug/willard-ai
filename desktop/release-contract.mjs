import { createHash, createPublicKey, sign, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const WINDOWS_VERSION_PATTERN = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2}$/;
export const RELEASE_SCHEMA = 2;
export const RELEASE_PRODUCT = "Willard Media Center";
export const RELEASE_REPOSITORY = "christopherlwillard-debug/willard-ai";
export const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAG/IGtev3II4CtYzBjfYKnc5BWsSeQed+VFgRV2fYVxM=
-----END PUBLIC KEY-----
`;

const SIGNED_FIELDS = [
  "schema",
  "product",
  "repository",
  "version",
  "artifactName",
  "artifactUrl",
  "sha256",
  "sourceArtifactName",
  "sourceArtifactUrl",
  "sourceSha256",
  "notes",
  "minimumWindowsVersion",
];

function expectedArtifactName(version) {
  return `WillardMediaCenter-${version}-windows-x64.zip`;
}

function expectedSourceArtifactName(version) {
  return `WillardMediaCenter-${version}-source.zip`;
}

function expectedArtifactUrl(version, name) {
  return `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}/${name}`;
}

function signedManifestContents(manifest) {
  return JSON.stringify(Object.fromEntries(SIGNED_FIELDS.map((field) => [field, manifest[field] ?? ""])));
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`The release description has no valid ${label} checksum.`);
  }
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) return null;
  const [, major, minor, patch, prerelease = ""] = match;
  return {
    parts: [major, minor, patch].map(BigInt),
    prerelease: prerelease
      ? prerelease.split(".").map((identifier) => ({
          value: identifier,
          numeric: /^\d+$/.test(identifier),
        }))
      : [],
  };
}

function comparePrereleaseIdentifiers(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a.numeric && b.numeric) {
      const aNumber = BigInt(a.value);
      const bNumber = BigInt(b.value);
      if (aNumber !== bNumber) return aNumber > bNumber ? 1 : -1;
      continue;
    }
    if (a.numeric !== b.numeric) return a.numeric ? -1 : 1;
    if (a.value !== b.value) return a.value > b.value ? 1 : -1;
  }
  if (left.length === right.length) return 0;
  return left.length > right.length ? 1 : -1;
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error("Release versions must use MAJOR.MINOR.PATCH format.");
  for (let i = 0; i < 3; i += 1) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i] > b.parts[i] ? 1 : -1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1;
  if (a.prerelease.length > 0 && b.prerelease.length === 0) return -1;
  return comparePrereleaseIdentifiers(a.prerelease, b.prerelease);
}

export function parseWindowsVersion(value) {
  if (typeof value !== "string" || !WINDOWS_VERSION_PATTERN.test(value)) return null;
  const parts = value.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  while (parts.length < 3) parts.push(0);
  return parts;
}

export function compareWindowsVersions(left, right) {
  const a = parseWindowsVersion(left);
  const b = parseWindowsVersion(right);
  if (!a || !b) {
    throw new Error("Windows versions must use MAJOR[.MINOR[.BUILD]] numeric format.");
  }
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export function validateReleaseManifest(manifest, { publicKey = RELEASE_PUBLIC_KEY, allowUnsigned = false } = {}) {
  if (!manifest || typeof manifest !== "object") throw new Error("The release description is not valid JSON.");
  if (manifest.schema !== RELEASE_SCHEMA) throw new Error("The release description has an unsupported schema.");
  if (manifest.product !== RELEASE_PRODUCT) throw new Error("The release description is for the wrong product.");
  if (manifest.repository !== RELEASE_REPOSITORY) throw new Error("The release description is for the wrong repository.");
  const version = parseVersion(manifest.version);
  if (!version) throw new Error("The release description has an invalid version.");
  const artifactName = expectedArtifactName(manifest.version.trim());
  const sourceArtifactName = expectedSourceArtifactName(manifest.version.trim());
  if (manifest.artifactName !== artifactName || manifest.sourceArtifactName !== sourceArtifactName) {
    throw new Error("The release description has an invalid artifact name.");
  }
  if (manifest.artifactUrl !== expectedArtifactUrl(manifest.version.trim(), artifactName)) {
    throw new Error("The release description has an invalid Windows artifact address.");
  }
  if (manifest.sourceArtifactUrl !== expectedArtifactUrl(manifest.version.trim(), sourceArtifactName)) {
    throw new Error("The release description has an invalid source artifact address.");
  }
  assertSha256(manifest.sha256, "artifact");
  assertSha256(manifest.sourceSha256, "source artifact");
  const minimumWindowsVersion = manifest.minimumWindowsVersion ?? "";
  if (
    typeof minimumWindowsVersion !== "string" ||
    (minimumWindowsVersion !== "" && !parseWindowsVersion(minimumWindowsVersion))
  ) {
    throw new Error("The release description has an invalid Windows requirement.");
  }
  if (typeof manifest.notes !== "string") throw new Error("The release description has invalid notes.");
  if (!allowUnsigned) {
    if (typeof manifest.signature !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(manifest.signature)) {
      throw new Error("The release description has no valid signature.");
    }
    let signature;
    try {
      signature = Buffer.from(manifest.signature, "base64");
      const verificationKey = publicKey?.type === "public" ? publicKey : createPublicKey(publicKey);
      if (signature.length !== 64 || !verify(null, Buffer.from(signedManifestContents(manifest)), verificationKey, signature)) {
        throw new Error("signature mismatch");
      }
    } catch {
      throw new Error("The release description failed signature verification.");
    }
  }
  return {
    schema: RELEASE_SCHEMA,
    product: RELEASE_PRODUCT,
    repository: RELEASE_REPOSITORY,
    version: manifest.version.trim(),
    artifactName,
    artifactUrl: manifest.artifactUrl,
    sha256: manifest.sha256.toLowerCase(),
    sourceArtifactName,
    sourceArtifactUrl: manifest.sourceArtifactUrl,
    sourceSha256: manifest.sourceSha256.toLowerCase(),
    signature: manifest.signature || "",
    notes: manifest.notes,
    minimumWindowsVersion,
  };
}

export function signReleaseManifest(manifest, privateKey) {
  validateReleaseManifest(manifest, { allowUnsigned: true });
  return sign(null, Buffer.from(signedManifestContents(manifest)), privateKey).toString("base64");
}

export async function verifyReleaseArtifact(manifest, artifactPath, options) {
  const release = validateReleaseManifest(manifest, options);
  const actualSha256 = await hashFile(artifactPath);
  if (actualSha256 !== release.sha256) {
    throw new Error("The downloaded release did not match its signed artifact checksum.");
  }
  return release;
}

export function getUpdateDecision(currentVersion, manifest, options) {
  const release = validateReleaseManifest(manifest, options);
  const comparison = compareVersions(release.version, currentVersion);
  return {
    ...release,
    available: comparison > 0,
    sameOrOlder: comparison <= 0,
  };
}

function getCliPublicKeyPath(args) {
  const optionIndex = args.indexOf("--public-key");
  if (optionIndex < 0) return null;
  if (optionIndex !== args.length - 2 || !args[optionIndex + 1]) {
    throw new Error("--public-key must be followed by a PEM file path at the end of the command.");
  }
  return args[optionIndex + 1];
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url &&
    ["--verify", "--verify-artifact", "--compare", "--compare-windows", "--update-decision"].includes(process.argv[2])) {
  try {
    const command = process.argv[2];
    if (command === "--compare") {
      if (process.argv.includes("--public-key")) throw new Error("--public-key is only supported for manifest checks.");
      process.stdout.write(`${compareVersions(process.argv[3], process.argv[4])}\n`);
    } else if (command === "--compare-windows") {
      if (process.argv.includes("--public-key")) throw new Error("--public-key is only supported for manifest checks.");
      process.stdout.write(`${compareWindowsVersions(process.argv[3], process.argv[4])}\n`);
    } else {
      const publicKeyPath = getCliPublicKeyPath(process.argv.slice(3));
      const options = publicKeyPath
        ? { publicKey: await readFile(publicKeyPath, "utf8") }
        : undefined;
      const manifestPath = command === "--update-decision"
        ? process.argv[4]
        : process.argv[3];
      const manifest = JSON.parse((await readFile(manifestPath, "utf8")).replace(/^\uFEFF/, ""));
      if (command === "--verify-artifact") {
        await verifyReleaseArtifact(manifest, process.argv[4], options);
        console.log("Release signature, binding, and artifact checksum verified.");
      } else if (command === "--update-decision") {
        const decision = getUpdateDecision(process.argv[3], manifest, options);
        console.log(JSON.stringify({ available: decision.available, version: decision.version }));
      } else {
        validateReleaseManifest(manifest, options);
        console.log("Release signature and binding verified.");
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
