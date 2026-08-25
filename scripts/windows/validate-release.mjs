import { access, lstat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const execFileAsync = promisify(execFile);

const IMAGE_PROCESSING_PACKAGES = new Set([
  "canvas",
  "gif-parser",
  "gifwrap",
  "heic-convert",
  "image-size",
  "image-type",
  "jimp",
  "jpeg-js",
  "parse-png",
  "pngjs",
  "probe-image-size",
  "sharp",
]);

export function findHighSeverityImageAdvisories(report, scopes = {}) {
  const advisories = Object.values(report?.advisories ?? {});
  const findings = [];
  const scopeEntries = Object.entries(scopes);

  for (const advisory of advisories) {
    if (!["high", "critical"].includes(String(advisory.severity).toLowerCase())) continue;
    if (!IMAGE_PROCESSING_PACKAGES.has(advisory.module_name)) continue;
    for (const finding of advisory.findings ?? []) {
      for (const dependencyPath of finding.paths ?? []) {
        const scope = scopeEntries.find(([, marker]) => dependencyPath.startsWith(marker))?.[0];
        if (scope) {
          findings.push({
            scope,
            package: advisory.module_name,
            version: finding.version || "unknown",
            severity: String(advisory.severity).toLowerCase(),
            path: dependencyPath,
            title: advisory.title || "Known security advisory",
          });
        }
      }
    }
  }
  return findings;
}

async function auditResolvedDependencies() {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  let stdout;
  try {
    ({ stdout } = await execFileAsync(pnpm, ["audit", "--json"], {
      cwd: root,
      maxBuffer: 10 * 1024 * 1024,
    }));
  } catch (error) {
    stdout = error?.stdout;
    if (!stdout) {
      throw new Error(`Unable to run the resolved dependency security audit: ${error?.message || error}`);
    }
  }

  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    throw new Error("Resolved dependency security audit did not return valid JSON.");
  }

  const findings = findHighSeverityImageAdvisories(report, {
    "API runtime": "artifacts__api-server>",
    "Mobile toolchain": "artifacts__willard-mobile>",
  });
  if (findings.length === 0) return;

  const details = findings.map((finding) =>
    `- ${finding.scope}: ${finding.package}@${finding.version} (${finding.severity}) via ${finding.path} — ${finding.title}`
  ).join("\n");
  throw new Error(`High or critical image-processing advisories found in the resolved dependency graph:\n${details}`);
}

export async function validateRelease() {
  const releaseDir = path.resolve(process.env.WILLARD_RELEASE_DIR || path.join(root, "build", "windows"));
  const version = process.env.WILLARD_VERSION || "0.1.0";

const requiredFiles = [
  "version.json",
  "runtime/node.exe",
  "desktop/WillardMediaCenter.ps1",
  "Start Willard Media Center.bat",
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

const launcher = await readFile(path.join(releaseDir, "desktop", "WillardMediaCenter.ps1"), "utf8");
for (const requiredReference of [
  "runtime\\node.exe",
  "api-runtime\\dist\\index.mjs",
  "api-runtime\\setup-db.cjs",
  "desktop\\desktop-web-server.mjs",
  "web",
]) {
  if (!launcher.includes(requiredReference)) {
    throw new Error(`Packaged launcher does not reference required payload: ${requiredReference}`);
  }
}

const pgTypes = path.join(releaseDir, "api-runtime", "node_modules", "pg-types");
try {
  if ((await lstat(pgTypes)).isSymbolicLink()) {
    throw new Error("Packaged pg-types dependency is a symbolic link; Windows extraction would break it.");
  }
} catch (error) {
  if (error?.code === "ENOENT") throw new Error("Packaged pg-types dependency is missing.");
  throw error;
}

const sharpPackage = path.join(releaseDir, "api-runtime", "node_modules", "sharp", "package.json");
try {
  const sharpManifest = JSON.parse(await readFile(sharpPackage, "utf8"));
  if (sharpManifest.version !== "0.35.2") {
    throw new Error(`Packaged sharp must be 0.35.2, found ${sharpManifest.version || "unknown"}.`);
  }
} catch (error) {
  if (error?.code === "ENOENT") throw new Error("Packaged sharp dependency is missing.");
  throw error;
}

const manifest = JSON.parse(await readFile(path.join(releaseDir, "version.json"), "utf8"));
if (manifest.product !== "Willard Media Center") throw new Error("Packaged release has the wrong product name.");
if (manifest.version !== version) throw new Error(`version.json says ${manifest.version}, expected ${version}.`);
if (manifest.requires?.windows !== "10+") throw new Error("Windows prerequisite is missing from version.json.");
if (manifest.requires?.postgresql !== "14+") throw new Error("PostgreSQL prerequisite is missing from version.json.");
if (!manifest.optional?.ffmpeg) throw new Error("FFmpeg optional-prerequisite note is missing from version.json.");

if (process.env.WILLARD_RELEASE_ZIP) {
  const zipPath = path.resolve(process.env.WILLARD_RELEASE_ZIP);
  const hash = createHash("sha256").update(await readFile(zipPath)).digest("hex");
  const releaseManifestPath = process.env.WILLARD_RELEASE_MANIFEST
    ? path.resolve(process.env.WILLARD_RELEASE_MANIFEST)
    : path.join(path.dirname(zipPath), "release-manifest.json");
  const releaseManifest = JSON.parse(await readFile(releaseManifestPath, "utf8"));
  if (releaseManifest.version !== version) throw new Error("Release manifest version does not match the packaged payload.");
  if (releaseManifest.artifactName !== path.basename(zipPath)) throw new Error("Release manifest artifact name does not match the ZIP.");
  if (releaseManifest.sha256?.toLowerCase() !== hash) throw new Error("Release manifest checksum does not match the ZIP.");
  if (!releaseManifest.artifactUrl?.endsWith("/" + path.basename(zipPath))) throw new Error("Release manifest artifact URL does not match the ZIP.");
}

  await auditResolvedDependencies();
  console.log(`Validated Willard Media Center ${version} release payload at ${releaseDir}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await validateRelease();
}