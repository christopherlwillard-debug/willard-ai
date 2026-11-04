import fs from "node:fs";
import path from "node:path";
import { path7za as bundledPath7za } from "7zip-bin";

export interface SevenZipResolutionOptions {
  platform?: NodeJS.Platform;
  pathEnv?: string;
  configuredPath?: string;
  fallbackPath?: string;
  exists?: (candidate: string) => boolean;
}

/**
 * Prefer a system-installed official 7-Zip binary when one is available.
 * Replit provisions the pinned static Linux build through replit.nix; Windows
 * desktop builds continue to use the bundled platform-specific executable.
 */
export function resolveSevenZipPath(options: SevenZipResolutionOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const configuredPath = options.configuredPath ?? process.env.WILLARD_7ZIP_PATH;
  const fallbackPath = options.fallbackPath ?? bundledPath7za;
  const exists = options.exists ?? fs.existsSync;

  if (configuredPath && exists(configuredPath)) return configuredPath;

  const delimiter = platform === "win32" ? ";" : ":";
  const directories = pathEnv.split(delimiter).filter(Boolean);
  const binaries = platform === "win32" ? ["7z.exe"] : ["7zzs", "7zz"];
  for (const binary of binaries) {
    for (const directory of directories) {
      const candidate = path.join(directory, binary);
      if (exists(candidate)) return candidate;
    }
  }

  return fallbackPath;
}

export const path7za = resolveSevenZipPath();
