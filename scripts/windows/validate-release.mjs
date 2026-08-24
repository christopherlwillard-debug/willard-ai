import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const releaseDir = path.resolve(process.env.WILLARD_RELEASE_DIR || path.join(root, "build", "windows"));
const version = process.env.WILLARD_VERSION || "0.1.0";

const requiredFiles = [
  "version.json",
  "runtime/node.exe",
  "desktop/WillardMediaCenter.ps1",
  "desktop/desktop-web-server.mjs",
  "desktop/release-contract.mjs",
  "api-runtime/dist/index.mjs",
  "api-runtime/setup-db.cjs",
  "web/index.html",
];

for (const relative of requiredFiles) {
  try {
    await access(path.join(releaseDir, relative));
  } catch {
    throw new Error(`Packaged release is missing required file: ${relative}`);
  }
}

const manifest = JSON.parse(await readFile(path.join(releaseDir, "version.json"), "utf8"));
if (manifest.product !== "Willard Media Center") throw new Error("Packaged release has the wrong product name.");
if (manifest.version !== version) throw new Error(`version.json says ${manifest.version}, expected ${version}.`);
if (manifest.requires?.windows !== "10+") throw new Error("Windows prerequisite is missing from version.json.");
if (manifest.requires?.postgresql !== "14+") throw new Error("PostgreSQL prerequisite is missing from version.json.");
if (!manifest.optional?.ffmpeg) throw new Error("FFmpeg optional-prerequisite note is missing from version.json.");

console.log(`Validated Willard Media Center ${version} release payload at ${releaseDir}`);