const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function parseVersion(value) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value.trim())) return null;
  const [core, prerelease = ""] = value.trim().split("-", 2);
  const parts = core.split(".").map(Number);
  return { parts, prerelease };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error("Release versions must use MAJOR.MINOR.PATCH format.");
  for (let i = 0; i < 3; i += 1) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i] > b.parts[i] ? 1 : -1;
  }
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

export function validateReleaseManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw new Error("The release description is not valid JSON.");
  if (!parseVersion(manifest.version)) throw new Error("The release description has an invalid version.");
  if (typeof manifest.artifactUrl !== "string" || !/^https?:\/\//i.test(manifest.artifactUrl)) {
    throw new Error("The release description has no usable download address.");
  }
  if (typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(manifest.sha256)) {
    throw new Error("The release description has no valid integrity checksum.");
  }
  if (manifest.minimumWindowsVersion && typeof manifest.minimumWindowsVersion !== "string") {
    throw new Error("The release description has an invalid Windows requirement.");
  }
  return {
    version: manifest.version.trim(),
    artifactUrl: manifest.artifactUrl,
    sha256: manifest.sha256.toLowerCase(),
    notes: typeof manifest.notes === "string" ? manifest.notes : "",
    minimumWindowsVersion: manifest.minimumWindowsVersion ?? "",
  };
}

export function getUpdateDecision(currentVersion, manifest) {
  const release = validateReleaseManifest(manifest);
  const comparison = compareVersions(release.version, currentVersion);
  return {
    ...release,
    available: comparison > 0,
    sameOrOlder: comparison <= 0,
  };
}