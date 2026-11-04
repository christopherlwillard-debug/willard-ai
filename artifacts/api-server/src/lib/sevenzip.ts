import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface SevenZipResolutionOptions {
  platform?: NodeJS.Platform;
  pathEnv?: string;
  configuredPath?: string;
  packagedPath?: string;
  exists?: (candidate: string) => boolean;
  getVersion?: (candidate: string) => string | undefined;
  moduleUrl?: string;
}

const MINIMUM_SUPPORTED_VERSION = { major: 26, minor: 1 };

function readSevenZipVersion(candidate: string): string | undefined {
  const result = spawnSync(candidate, ["i"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return undefined;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return output.match(/7-Zip(?: \(z\))? (\d+\.\d+)/)?.[1];
}

function isSupportedOfficialVersion(version: string | undefined): boolean {
  if (!version) return false;
  const match = version.match(/^(\d+)\.(\d+)$/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > MINIMUM_SUPPORTED_VERSION.major ||
    (major === MINIMUM_SUPPORTED_VERSION.major && minor >= MINIMUM_SUPPORTED_VERSION.minor);
}

/**
 * Resolve only a verified official 7-Zip binary. The old 7zip-bin fallback
 * shipped p7zip 16.02 on Linux and must never silently parse untrusted archives.
 * Missing or outdated binaries disable archive operations, not API startup.
 */
export function resolveSevenZipPath(options: SevenZipResolutionOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const configuredPath = options.configuredPath ?? process.env.WILLARD_7ZIP_PATH;
  const exists = options.exists ?? fs.existsSync;
  const getVersion = options.getVersion ?? readSevenZipVersion;
  const candidates: string[] = [];

  if (configuredPath) candidates.push(configuredPath);

  const packagedName = platform === "win32" ? "7z.exe" : platform === "darwin" ? "7zz" : "7zzs";
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const packagedPath = options.packagedPath ??
    path.resolve(path.dirname(fileURLToPath(moduleUrl)), "../vendor/7zip", packagedName);
  candidates.push(packagedPath);

  const delimiter = platform === "win32" ? ";" : ":";
  const directories = pathEnv.split(delimiter).filter(Boolean);
  const binaries = platform === "win32" ? ["7z.exe"] : ["7zzs", "7zz"];
  for (const binary of binaries) {
    for (const directory of directories) candidates.push(path.join(directory, binary));
  }

  const checked = new Set<string>();
  for (const candidate of candidates) {
    if (checked.has(candidate)) continue;
    checked.add(candidate);
    if (!exists(candidate)) continue;
    if (isSupportedOfficialVersion(getVersion(candidate))) return candidate;
  }
  return undefined;
}

export function getSevenZipPath(): string {
  const resolved = resolveSevenZipPath();
  if (resolved) return resolved;
  throw new Error(
    "Archive operations require official 7-Zip 26.01 or newer. Install it on PATH or set WILLARD_7ZIP_PATH; the bundled legacy p7zip fallback is intentionally disabled.",
  );
}
