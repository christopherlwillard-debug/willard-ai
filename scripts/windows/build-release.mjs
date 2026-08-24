import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.resolve(process.env.WILLARD_RELEASE_DIR || path.join(root, "build", "windows"));
const version = process.env.WILLARD_VERSION || "0.1.0";
const nodeRuntime = process.env.WILLARD_NODE_RUNTIME;

async function copy(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

async function main() {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error("WILLARD_VERSION must be MAJOR.MINOR.PATCH.");
  if (!nodeRuntime) throw new Error("Set WILLARD_NODE_RUNTIME to a directory containing the Windows node.exe runtime.");
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });

  await run("pnpm", ["--filter", "@workspace/willard-ai", "run", "build"], { cwd: root, stdio: "inherit" });
  await run("pnpm", ["--filter", "@workspace/api-server", "run", "build"], { cwd: root, stdio: "inherit" });
  await run("pnpm", ["--filter", "@workspace/api-server", "deploy", "--prod", "--legacy", path.join(output, "api-runtime")], { cwd: root, stdio: "inherit" });

  await copy(path.join(root, "artifacts/willard-ai/dist/public"), path.join(output, "web"));
  await copy(path.join(root, "artifacts/api-server/dist"), path.join(output, "api-runtime/dist"));
  await copy(path.join(root, "setup-db.cjs"), path.join(output, "api-runtime/setup-db.cjs"));
  await copy(path.join(root, "desktop/release-contract.mjs"), path.join(output, "desktop/release-contract.mjs"));
  await copy(path.join(root, "desktop/desktop-web-server.mjs"), path.join(output, "desktop/desktop-web-server.mjs"));
  await copy(path.join(root, "desktop/WillardMediaCenter.ps1"), path.join(output, "desktop/WillardMediaCenter.ps1"));
  await copy(path.join(root, "installer/willard.ico"), path.join(output, "icons/willard.ico"));
  await copy(nodeRuntime, path.join(output, "runtime"));

  const manifest = {
    product: "Willard Media Center",
    version,
    artifactName: `WillardMediaCenter-${version}-windows-x64.zip`,
    builtAt: new Date().toISOString(),
    requires: { windows: "10+", postgresql: "14+" },
    optional: { ffmpeg: "enables thumbnails, video metadata, and conversion" },
    update: { manifestPath: "release-manifest.json", atomic: true },
  };
  await writeFile(path.join(output, "version.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Windows release staged at ${output}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});