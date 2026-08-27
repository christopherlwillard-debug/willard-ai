import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const LIBRARY_DURABILITY_PATH = path.join(root, "library-durability-manifest.json");

const REQUIRED_PERMANENT = [
  "original media",
  "canonical media rows and content hashes",
  "manual metadata, corrections, notes, and favorites",
  "tags and manual album membership",
  "named people and face-to-person assignments",
  "archive index and cleanup history",
  "database backup manifests and recovery attempts",
];

const REQUIRED_RECOVERABLE = [
  "AI results and embeddings",
  "face scan state and derived face rows",
  "scan history",
  "job checkpoints, cursors, and resumable operation state",
  "saved searches and search history",
  "operational reports",
];

const REQUIRED_REBUILDABLE = [
  "thumbnails and previews",
  "face crop files",
  "local AI and face model caches",
  "temporary files",
  "incomplete conversion or import scratch",
];

export function loadLibraryDurabilityManifest() {
  return JSON.parse(readFileSync(LIBRARY_DURABILITY_PATH, "utf8"));
}

function includesAll(actual, required) {
  return required.every((item) => actual.includes(item));
}

export function validateLibraryDurabilityManifest(manifest, { rootDir = root } = {}) {
  const errors = [];
  if (manifest?.format !== 1) errors.push("durability manifest format must be 1");
  if (!manifest?.policyVersion) errors.push("durability manifest is missing policyVersion");
  if (manifest?.libraryIdentity?.requiredForRestore !== true) {
    errors.push("restore must require the stable NAS library identity");
  }
  if (manifest?.libraryIdentity?.operatorAttestationRequired !== true) {
    errors.push("restore must require explicit operator library identity attestation");
  }
  const classes = manifest?.classes || {};
  if (!includesAll(classes.permanent?.items || [], REQUIRED_PERMANENT)) {
    errors.push("permanent durability class is incomplete");
  }
  if (!includesAll(classes.recoverable?.items || [], REQUIRED_RECOVERABLE)) {
    errors.push("recoverable durability class is incomplete");
  }
  if (!includesAll(classes.rebuildable?.items || [], REQUIRED_REBUILDABLE)) {
    errors.push("rebuildable durability class is incomplete");
  }
  const checks = manifest?.verification?.requiredAfterRestore || [];
  for (const item of [
    "library identity and ownership",
    "canonical media counts, relative identities, and SHA-256 hashes",
    "manual metadata, corrections, albums, tags, and favorites",
    "AI results and face assignments",
    "archive and cleanup history",
    "resumable job state",
    "representative search and media opening",
  ]) {
    if (!checks.includes(item)) errors.push(`restore verification is missing ${item}`);
  }
  const evidence = manifest?.verification?.evidence;
  try {
    const absolute = path.resolve(rootDir, evidence);
    if (!absolute.startsWith(`${rootDir}${path.sep}`) || !readFileSync(absolute)) {
      errors.push("durability evidence is outside the repository or unreadable");
    }
  } catch {
    errors.push(`durability evidence is missing: ${evidence}`);
  }
  return errors;
}

export function assertLibraryDurabilityManifest(manifest = loadLibraryDurabilityManifest(), options) {
  const errors = validateLibraryDurabilityManifest(manifest, options);
  if (errors.length) {
    throw new Error(`Library durability manifest is incomplete:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  }
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assertLibraryDurabilityManifest();
  console.log("Library durability manifest is complete.");
}