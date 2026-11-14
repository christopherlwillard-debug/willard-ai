import { existsSync } from "node:fs";

export function resolvePnpmInvocation({
  npmExecPath = process.env.npm_execpath,
  nodeExecutable = process.execPath,
  platform = process.platform,
  fileExists = existsSync,
} = {}) {
  if (
    typeof npmExecPath === "string"
    && /\.(?:cjs|mjs|js)$/i.test(npmExecPath)
    && fileExists(npmExecPath)
  ) {
    return {
      command: nodeExecutable,
      argsPrefix: [npmExecPath],
      shell: false,
    };
  }

  return {
    command: "pnpm",
    argsPrefix: [],
    // Windows exposes pnpm as a .cmd shim when the JavaScript entrypoint is unavailable.
    shell: platform === "win32",
  };
}
