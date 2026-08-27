import { cp, lstat, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertCanonicalReleaseDirectory, writePayloadManifest } from "./release-payload.mjs";
import { assertStorageConformance } from "./storage-conformance.mjs";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.resolve(process.env.WILLARD_RELEASE_DIR || path.join(root, "build", "windows"));
const version = process.env.WILLARD_VERSION || "0.1.0";
const nodeRuntime = process.env.WILLARD_NODE_RUNTIME;
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const webBuildEnv = {
  ...process.env,
  PORT: process.env.PORT || "5000",
  BASE_PATH: process.env.BASE_PATH || "/",
};

async function copy(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

async function copyDereferenced(source, destination) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    try {
      return copyDereferenced(await realpath(source), destination);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source)) {
      await copyDereferenced(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination);
}

async function pruneWindowsPayload(payloadRoot) {
  const pnpmStore = path.join(payloadRoot, "node_modules", ".pnpm");
  try {
    const entries = await readdir(pnpmStore);
    for (const entry of entries) {
      if (/(darwin|linux|android|freebsd|arm64|armv7)/i.test(entry)) {
        await rm(path.join(pnpmStore, entry), { recursive: true, force: true });
      }
    }
  } catch {
    // A future package manager layout may not expose a .pnpm store.
  }

  const onnxRoot = path.join(
    payloadRoot,
    "node_modules",
    ".pnpm",
    "onnxruntime-node@1.24.3",
    "node_modules",
    "onnxruntime-node",
    "bin",
    "napi-v6",
  );
  for (const platform of ["linux", "darwin"]) {
    await rm(path.join(onnxRoot, platform), { recursive: true, force: true });
  }
  await rm(path.join(onnxRoot, "win32", "arm64"), { recursive: true, force: true });

  try {
    const webEntries = await readdir(
      path.join(payloadRoot, "node_modules", ".pnpm"),
    );
    for (const entry of webEntries.filter((name) => name.startsWith("onnxruntime-web@"))) {
      const webDist = path.join(
        payloadRoot,
        "node_modules",
        ".pnpm",
        entry,
        "node_modules",
        "onnxruntime-web",
        "dist",
      );
      for (const file of await readdir(webDist).catch(() => [])) {
        if (file.endsWith(".wasm") || file.endsWith(".map")) {
          await rm(path.join(webDist, file), { force: true });
        }
      }
    }
  } catch {
    // The web backend is not present in every production dependency layout.
  }
}

async function compactWindowsDependencies(payloadRoot) {
  const nodeModules = path.join(payloadRoot, "node_modules");
  const pnpmStore = path.join(nodeModules, ".pnpm");
  const sharedModules = path.join(pnpmStore, "node_modules");
  for (const entry of await readdir(sharedModules).catch(() => [])) {
    const source = path.join(sharedModules, entry);
    const destination = path.join(nodeModules, entry);
    try {
      await lstat(destination);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await copyDereferenced(source, destination);
    }
  }
  await rm(pnpmStore, { recursive: true, force: true });
  await rm(path.join(nodeModules, ".modules.yaml"), { force: true });
  await rm(path.join(nodeModules, ".pnpm-workspace-state-v1.json"), { force: true });
  await rm(path.join(nodeModules, ".bin"), { recursive: true, force: true });
  await rm(path.join(payloadRoot, "pnpm-lock.yaml"), { force: true });
}

async function pruneBuildOnlyFiles(apiOutput) {
  for (const relative of [
    "src",
    "build.mjs",
    "tsconfig.json",
    ".tsbuildinfo",
    ".replit-artifact",
  ]) {
    await rm(path.join(apiOutput, relative), { recursive: true, force: true });
  }
  await writeFile(
    path.join(apiOutput, "package.json"),
    `${JSON.stringify({ name: "willard-api-runtime", private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );
}

async function main() {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error("WILLARD_VERSION must be MAJOR.MINOR.PATCH.");
  assertStorageConformance();
  if (!nodeRuntime) throw new Error("Set WILLARD_NODE_RUNTIME to a directory containing the Windows node.exe runtime.");
  assertCanonicalReleaseDirectory(output, root);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });

  await run(pnpmCommand, ["--filter", "@workspace/willard-ai", "run", "build"], { cwd: root, env: webBuildEnv, stdio: "inherit" });
  await run(pnpmCommand, ["--filter", "@workspace/api-server", "run", "build"], { cwd: root, stdio: "inherit" });
  const deployOutput = path.join(output, ".api-deploy");
  const apiOutput = path.join(output, "api-runtime");
  await run(
    pnpmCommand,
    [
      "--filter",
      "@workspace/api-server",
      "deploy",
      "--prod",
      "--no-optional",
      "--config.inject-workspace-packages=true",
      deployOutput,
    ],
    { cwd: root, stdio: "inherit" },
  );
  await pruneWindowsPayload(deployOutput);
  await copyDereferenced(deployOutput, apiOutput);
  await compactWindowsDependencies(apiOutput);
  await pruneBuildOnlyFiles(apiOutput);
  await rm(deployOutput, { recursive: true, force: true });

  await copy(path.join(root, "artifacts/willard-ai/dist/public"), path.join(output, "web"));
  await copy(path.join(root, "artifacts/api-server/dist"), path.join(output, "api-runtime/dist"));
  await copy(path.join(root, "setup-db.cjs"), path.join(output, "api-runtime/setup-db.cjs"));
  await copy(path.join(root, "desktop/release-contract.mjs"), path.join(output, "desktop/release-contract.mjs"));
  await copy(path.join(root, "desktop/desktop-web-server.mjs"), path.join(output, "desktop/desktop-web-server.mjs"));
  await copy(path.join(root, "desktop/database-backup.mjs"), path.join(output, "desktop/database-backup.mjs"));
  await copy(path.join(root, "desktop/loading.html"), path.join(output, "desktop/loading.html"));
  await copy(path.join(root, "desktop/WillardMediaCenter.ps1"), path.join(output, "desktop/WillardMediaCenter.ps1"));
  await copy(path.join(root, "desktop/Start Willard Media Center.bat"), path.join(output, "Start Willard Media Center.bat"));
  await copy(path.join(root, "installer/willard.ico"), path.join(output, "icons/willard.ico"));
  await copy(path.join(nodeRuntime, "node.exe"), path.join(output, "runtime/node.exe"));

  const manifest = {
    product: "Willard Media Center",
    version,
    artifactName: `WillardMediaCenter-${version}-windows-x64.zip`,
    payloadManifest: "payload-manifest.json",
    requires: { windows: "10+", postgresql: "14+" },
    optional: { ffmpeg: "enables thumbnails, video metadata, and conversion" },
    update: { manifestPath: "release-manifest.json", atomic: true },
  };
  await writeFile(path.join(output, "version.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writePayloadManifest(output, version);
  console.log(`Windows release staged at ${output}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});