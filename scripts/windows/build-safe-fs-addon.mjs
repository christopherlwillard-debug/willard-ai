import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const apiRoot = path.join(root, "artifacts", "api-server");
const addonDirectory = path.join(apiRoot, "native", "windows-safe-fs");

if (process.platform !== "win32") {
  console.log("Skipping the Windows-only safe-filesystem addon build.");
  process.exit(0);
}

const require = createRequire(path.join(apiRoot, "package.json"));
const nodeGypCli = require.resolve("node-gyp/bin/node-gyp.js");
const child = spawn(process.execPath, [nodeGypCli, "rebuild"], {
  cwd: addonDirectory,
  stdio: "inherit",
  windowsHide: true,
});

child.once("error", (error) => {
  console.error(`Unable to start node-gyp: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`The Windows safe-filesystem build stopped with signal ${signal}.`);
    process.exitCode = 1;
  } else if (code !== 0) {
    process.exitCode = code ?? 1;
  }
});
