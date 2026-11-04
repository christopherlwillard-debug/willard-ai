import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, lstat, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const PAYLOAD_MANIFEST_FILE = "payload-manifest.json";
export const CANONICAL_RELEASE_DIR_NAME = "build/windows";

function normalizeRelativePath(value) {
  return value.split(path.sep).join("/");
}

export function assertCanonicalReleaseDirectory(releaseDir, root) {
  const resolved = path.resolve(releaseDir);
  const canonical = path.resolve(root, CANONICAL_RELEASE_DIR_NAME);
  const buildRoot = path.resolve(root, "build");
  if (resolved === canonical) return;
  if (resolved === buildRoot || resolved.startsWith(`${buildRoot}${path.sep}`)) {
    throw new Error(
      `Windows releases must use the canonical staging directory ${CANONICAL_RELEASE_DIR_NAME}; refusing ${normalizeRelativePath(path.relative(root, resolved))}.`,
    );
  }
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function collectFiles(root, current = root, result = []) {
  for (const name of (await readdir(current)).sort((left, right) => left.localeCompare(right))) {
    const fullPath = path.join(current, name);
    const info = await lstat(fullPath);
    if (info.isSymbolicLink()) {
      throw new Error(`Windows payload contains a symbolic link: ${normalizeRelativePath(path.relative(root, fullPath))}`);
    }
    if (info.isDirectory()) {
      await collectFiles(root, fullPath, result);
    } else if (info.isFile()) {
      result.push({
        path: normalizeRelativePath(path.relative(root, fullPath)),
        size: info.size,
        sha256: await hashFile(fullPath),
      });
    }
  }
  return result;
}

export async function createPayloadManifest(releaseDir, version) {
  const files = (await collectFiles(releaseDir))
    .filter((entry) => entry.path !== PAYLOAD_MANIFEST_FILE)
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    format: 1,
    product: "Willard Media Center",
    version,
    files,
  };
}

export async function writePayloadManifest(releaseDir, version) {
  const manifest = await createPayloadManifest(releaseDir, version);
  await writeFile(
    path.join(releaseDir, PAYLOAD_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

function validateManifestPath(relative) {
  if (
    typeof relative !== "string" ||
    !relative ||
    relative.includes("\\") ||
    path.posix.isAbsolute(relative) ||
    relative.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Payload manifest contains an unsafe path: ${relative}`);
  }
}

export async function validatePayloadManifest(releaseDir, expectedVersion) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(releaseDir, PAYLOAD_MANIFEST_FILE), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("Packaged release is missing payload-manifest.json.");
    throw new Error(`Packaged payload manifest is not valid JSON: ${error?.message || error}`);
  }

  if (manifest?.format !== 1 || manifest?.product !== "Willard Media Center") {
    throw new Error("Packaged payload manifest has an unsupported format or product.");
  }
  if (manifest.version !== expectedVersion) {
    throw new Error(`Payload manifest says ${manifest.version}, expected ${expectedVersion}.`);
  }
  if (!Array.isArray(manifest.files)) {
    throw new Error("Packaged payload manifest does not contain a file list.");
  }

  const expected = new Map();
  for (const entry of manifest.files) {
    validateManifestPath(entry?.path);
    if (expected.has(entry.path)) throw new Error(`Payload manifest lists a duplicate file: ${entry.path}`);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/i.test(entry.sha256 || "")) {
      throw new Error(`Payload manifest has invalid metadata for: ${entry.path}`);
    }
    expected.set(entry.path, entry);
  }

  const actual = await collectFiles(releaseDir);
  const actualPaths = new Set(actual.map((entry) => entry.path));
  for (const entry of actual) {
    if (entry.path === PAYLOAD_MANIFEST_FILE) continue;
    const expectedEntry = expected.get(entry.path);
    if (!expectedEntry) throw new Error(`Packaged payload contains an unlisted file: ${entry.path}`);
    if (entry.size !== expectedEntry.size || entry.sha256.toLowerCase() !== expectedEntry.sha256.toLowerCase()) {
      throw new Error(`Packaged payload drift detected for: ${entry.path}`);
    }
  }
  for (const relative of expected.keys()) {
    if (!actualPaths.has(relative)) throw new Error(`Packaged payload is missing manifest file: ${relative}`);
  }

  return manifest;
}

export async function assertReferencedFile(releaseDir, baseDir, reference) {
  const cleanReference = reference.split(/[?#]/, 1)[0];
  if (!cleanReference || /^(?:[a-z]+:|data:|#|\/\/)/i.test(cleanReference)) return;
  const candidate = path.resolve(baseDir, cleanReference.replace(/^\/+/, ""));
  const relative = path.relative(releaseDir, candidate);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Packaged asset reference escapes the payload: ${reference}`);
  }
  try {
    const info = await stat(candidate);
    if (!info.isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`Packaged asset reference is missing: ${reference}`);
  }
}

export async function assertLocalHtmlReferences(releaseDir, relativeFile) {
  const filePath = path.join(releaseDir, relativeFile);
  await access(filePath);
  const html = await readFile(filePath, "utf8");
  const references = [...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
  const baseDir = relativeFile === "web/index.html" || relativeFile.startsWith("web/")
    ? path.join(releaseDir, "web")
    : path.dirname(filePath);
  for (const reference of references) {
    await assertReferencedFile(releaseDir, baseDir, reference);
  }
}