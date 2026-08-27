import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const AUTHORITATIVE_API_MANIFEST =
  "artifacts/api-server/.replit-artifact/artifact.toml";

const GENERATED_DIRECTORY_NAMES = new Set([
  ".git",
  ".cache",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out-tsc",
  "tmp",
]);

function normalizeRelativePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

async function collectArtifactManifests(root, current = root, result = []) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.isDirectory() && GENERATED_DIRECTORY_NAMES.has(entry.name)) continue;

    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await collectArtifactManifests(root, entryPath, result);
      continue;
    }
    if (
      entry.isFile() &&
      entry.name === "artifact.toml" &&
      path.basename(path.dirname(entryPath)) === ".replit-artifact"
    ) {
      result.push({
        path: normalizeRelativePath(root, entryPath),
        contents: await readFile(entryPath, "utf8"),
      });
    }
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function parseArtifactManifest(contents) {
  const kind = contents.match(/^\s*kind\s*=\s*"([^"]+)"/m)?.[1] ?? "";
  const localPorts = [...contents.matchAll(/^\s*localPort\s*=\s*(\d+)\s*$/gm)]
    .map((match) => Number(match[1]));
  return { kind, localPorts };
}

export async function findArtifactManifests(root) {
  return collectArtifactManifests(path.resolve(root));
}

export function assertCanonicalArtifactSources(manifests) {
  const apiManifests = manifests.filter(
    (manifest) => parseArtifactManifest(manifest.contents).kind === "api",
  );
  if (apiManifests.length !== 1) {
    throw new Error(
      `Expected exactly one API artifact manifest, found ${apiManifests.length}: ${
        apiManifests.map((manifest) => manifest.path).join(", ") || "none"
      }`,
    );
  }
  if (apiManifests[0].path !== AUTHORITATIVE_API_MANIFEST) {
    throw new Error(
      `The API artifact must come from ${AUTHORITATIVE_API_MANIFEST}, not ${apiManifests[0].path}.`,
    );
  }

  const port8080Manifests = manifests.filter((manifest) =>
    parseArtifactManifest(manifest.contents).localPorts.includes(8080),
  );
  if (port8080Manifests.length !== 1) {
    throw new Error(
      `Expected exactly one artifact service on port 8080, found ${port8080Manifests.length}: ${
        port8080Manifests.map((manifest) => manifest.path).join(", ") || "none"
      }`,
    );
  }
}

export function assertNoTrackedGeneratedOutputs(trackedPaths) {
  const generated = trackedPaths.filter((filePath) =>
    /(?:^|\/)build\//.test(filePath) || /\.zip$/i.test(filePath),
  );
  if (generated.length > 0) {
    throw new Error(
      `Generated release outputs must not be tracked: ${generated.join(", ")}`,
    );
  }
}

function listTrackedFiles(root) {
  try {
    return execFileSync("git", ["-C", root, "ls-files", "-z"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\0")
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function validateRepositoryArtifactSources(root) {
  const resolvedRoot = path.resolve(root);
  const manifests = await findArtifactManifests(resolvedRoot);
  assertCanonicalArtifactSources(manifests);
  assertNoTrackedGeneratedOutputs(
    listTrackedFiles(resolvedRoot).filter((filePath) =>
      existsSync(path.join(resolvedRoot, filePath)),
    ),
  );
  return manifests.map((manifest) => manifest.path);
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const manifests = await validateRepositoryArtifactSources(root);
    console.log(
      `Validated ${manifests.length} artifact manifests; one authoritative API service owns port 8080.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}