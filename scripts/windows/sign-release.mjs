import { createPrivateKey } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { signReleaseManifest, validateReleaseManifest } from "../../desktop/release-contract.mjs";

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error("Usage: node scripts/windows/sign-release.mjs <release-manifest.json>");

const encodedKey = process.env.WILLARD_RELEASE_SIGNING_PRIVATE_KEY;
if (!encodedKey) {
  throw new Error("WILLARD_RELEASE_SIGNING_PRIVATE_KEY is required; refusing to publish an unsigned release.");
}

function decodePrivateKey(value) {
  const trimmed = value.trim();
  if (trimmed.includes("BEGIN PRIVATE KEY")) return createPrivateKey(trimmed);
  return createPrivateKey({ key: Buffer.from(trimmed, "base64"), format: "der", type: "pkcs8" });
}

const fullPath = path.resolve(manifestPath);
const manifest = JSON.parse((await readFile(fullPath, "utf8")).replace(/^\uFEFF/, ""));
manifest.signature = signReleaseManifest(manifest, decodePrivateKey(encodedKey));
validateReleaseManifest(manifest);
await writeFile(fullPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Signed release manifest: ${fullPath}`);