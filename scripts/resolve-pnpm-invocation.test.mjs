import assert from "node:assert/strict";
import test from "node:test";
import { resolvePnpmInvocation } from "./resolve-pnpm-invocation.mjs";

test("uses the package manager JavaScript entrypoint without a shell on Windows", () => {
  const npmExecPath = "C:\\Program Files\\nodejs\\node_modules\\pnpm\\bin\\pnpm.cjs";
  assert.deepEqual(
    resolvePnpmInvocation({
      npmExecPath,
      nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
      fileExists: (candidate) => candidate === npmExecPath,
    }),
    {
      command: "C:\\Program Files\\nodejs\\node.exe",
      argsPrefix: [npmExecPath],
      shell: false,
    },
  );
});

test("uses the Windows command shell for the pnpm shim fallback", () => {
  assert.deepEqual(
    resolvePnpmInvocation({
      npmExecPath: undefined,
      platform: "win32",
      fileExists: () => false,
    }),
    {
      command: "pnpm",
      argsPrefix: [],
      shell: true,
    },
  );
});

test("keeps the POSIX pnpm invocation shell-free", () => {
  assert.deepEqual(
    resolvePnpmInvocation({
      npmExecPath: undefined,
      platform: "linux",
      fileExists: () => false,
    }),
    {
      command: "pnpm",
      argsPrefix: [],
      shell: false,
    },
  );
});

test("does not execute a non-JavaScript npm_execpath value", () => {
  assert.deepEqual(
    resolvePnpmInvocation({
      npmExecPath: "C:\\tools\\pnpm.cmd",
      platform: "win32",
      fileExists: () => true,
    }),
    {
      command: "pnpm",
      argsPrefix: [],
      shell: true,
    },
  );
});
