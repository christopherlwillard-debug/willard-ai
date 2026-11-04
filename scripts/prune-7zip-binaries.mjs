import { access, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PLATFORM_DIR = {
  linux: "linux",
  win32: "win",
  darwin: "mac",
};

const UNUSED_BINARIES = {
  linux: ["7zz", "7zzc", "7zzsc"],
  win32: ["7zc"],
  darwin: ["7zzc"],
};

export async function pruneSevenZipPackage(packageRoot, platform = process.platform, arch = process.arch) {
  const platformDir = PLATFORM_DIR[platform];
  if (!platformDir) throw new Error(`Unsupported 7-Zip runtime platform: ${platform}`);

  const resolvedRoot = await realpath(packageRoot);
  const targetDir = path.join(resolvedRoot, platformDir, arch);
  const targetStat = await stat(targetDir).catch(() => null);
  if (!targetStat?.isDirectory()) {
    throw new Error(`7-Zip package has no binary directory for ${platform}/${arch}`);
  }

  const removed = [];
  for (const candidate of ["linux", "win", "mac"]) {
    if (candidate === platformDir) continue;
    const candidatePath = path.join(resolvedRoot, candidate);
    await rm(candidatePath, { recursive: true, force: true });
    removed.push(candidatePath);
  }

  const platformRoot = path.join(resolvedRoot, platformDir);
  for (const candidate of await readdir(platformRoot, { withFileTypes: true })) {
    if (candidate.isDirectory() && candidate.name !== arch) {
      const candidatePath = path.join(platformRoot, candidate.name);
      await rm(candidatePath, { recursive: true, force: true });
      removed.push(candidatePath);
    }
  }

  for (const binary of UNUSED_BINARIES[platform]) {
    const binaryPath = path.join(targetDir, binary);
    await rm(binaryPath, { recursive: true, force: true });
    removed.push(binaryPath);
  }

  const requiredBinary = platform === "linux"
    ? "7zzs"
    : platform === "win32"
      ? "7z.exe"
      : "7zz";
  const requiredPath = path.join(targetDir, requiredBinary);
  await access(requiredPath);
  if (platform === "win32") await access(path.join(targetDir, "7z.dll"));

  return { packageRoot: resolvedRoot, targetDir, requiredPath, removed };
}

async function main() {
  const apiRequire = createRequire(path.join(ROOT, "artifacts", "api-server", "package.json"));
  const packageEntry = apiRequire.resolve("7zip-bin-full");
  const packageRoot = path.dirname(packageEntry);
  const result = await pruneSevenZipPackage(packageRoot);
  process.stdout.write(
    `Pruned 7-Zip package for ${process.platform}/${process.arch}; retained ${path.relative(ROOT, result.requiredPath)}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
