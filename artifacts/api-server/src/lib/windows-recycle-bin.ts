import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const WINDOWS_RECYCLE_BIN_TIMEOUT_MS = 30_000;
const WINDOWS_RECYCLE_BIN_MAX_OUTPUT_BYTES = 64 * 1024;

const POWERSHELL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName Microsoft.VisualBasic",
  "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:WILLARD_CLEANUP_TARGET, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)",
].join("; ");

export interface WindowsRecycleBinInvocation {
  command: "powershell.exe";
  args: string[];
  options: {
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
    windowsHide: true;
    env: NodeJS.ProcessEnv;
  };
}

type WindowsRecycleBinExecutor = (invocation: WindowsRecycleBinInvocation) => Promise<unknown>;

async function executePowerShell(invocation: WindowsRecycleBinInvocation): Promise<void> {
  await execFileAsync(invocation.command, invocation.args, invocation.options);
}

function describePowerShellFailure(error: unknown): string {
  const failure = error as {
    code?: unknown;
    stderr?: unknown;
    message?: unknown;
  };
  if (failure?.code === "ETIMEDOUT") {
    return `PowerShell did not finish within ${WINDOWS_RECYCLE_BIN_TIMEOUT_MS} ms`;
  }
  const stderr = typeof failure?.stderr === "string" ? failure.stderr.trim() : "";
  const message = typeof failure?.message === "string" ? failure.message : String(error);
  return (stderr || message || "Unknown PowerShell failure").slice(0, 500);
}

/**
 * Build a bounded, noninteractive PowerShell invocation for the Windows
 * Recycle Bin. The path is supplied through the child environment so quotes,
 * metacharacters, and Unicode in a legitimate filename cannot become code.
 */
export function createWindowsRecycleBinMover(
  execute: WindowsRecycleBinExecutor = executePowerShell,
): (filePath: string) => Promise<void> {
  return async (filePath: string): Promise<void> => {
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new Error("A file path is required for the Windows Recycle Bin");
    }

    const invocation: WindowsRecycleBinInvocation = {
      command: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_SCRIPT],
      options: {
        encoding: "utf8",
        timeout: WINDOWS_RECYCLE_BIN_TIMEOUT_MS,
        maxBuffer: WINDOWS_RECYCLE_BIN_MAX_OUTPUT_BYTES,
        windowsHide: true,
        env: {
          ...process.env,
          WILLARD_CLEANUP_TARGET: filePath,
        },
      },
    };

    try {
      await execute(invocation);
    } catch (error) {
      throw new Error(`Windows Recycle Bin operation failed: ${describePowerShellFailure(error)}`, {
        cause: error,
      });
    }
  };
}

export const sendToWindowsRecycleBin = createWindowsRecycleBinMover();
