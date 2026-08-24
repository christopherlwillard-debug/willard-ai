import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const appURL =
  process.env.WILLARD_APP_URL ??
  (process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : null);

const logDir =
  process.env.WILLARD_STARTUP_LOG_DIR ?? join(process.cwd(), "logs");

const serviceLogPaths = {
  "Web app": process.env.WILLARD_WEB_LOG
    ? [process.env.WILLARD_WEB_LOG]
    : [join(logDir, "web.log"), join(logDir, "web-error.log")],
  "API server": process.env.WILLARD_API_LOG
    ? [process.env.WILLARD_API_LOG]
    : [join(logDir, "api.log"), join(logDir, "api-error.log")],
};

export async function recentStartupOutput(name, paths = serviceLogPaths[name]) {
  const logPaths = paths ?? [];
  const outputs = [];

  for (const logPath of logPaths) {
    try {
      const output = await readFile(logPath, "utf8");
      const lines = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length > 0) outputs.push(...lines.slice(-8));
    } catch {
      // A service may only write stdout or stderr, so a missing companion log
      // is expected.
    }
  }

  if (outputs.length === 0) return null;

  // Startup failures are normally near the end of the service logs. Keep the
  // routed-check failure actionable without flooding the workflow output.
  return outputs.join("\n").slice(-2_000);
}

export async function checkService(
  name,
  url,
  timeoutMs = 120_000,
  options = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "no response";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status >= 200 && response.status < 400) return;
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const startupOutput = await recentStartupOutput(name, options.logPaths);
  const outputSuffix = startupOutput
    ? ` Startup output:\n${startupOutput}`
    : "";
  throw new Error(
    `${name} readiness failed at ${url} (${lastFailure}).${outputSuffix}`,
  );
}

export async function runRoutedWorkflows() {
  if (appURL) {
    const base = appURL.replace(/\/+$/, "");
    try {
      await Promise.all([
        checkService("Web app", `${base}/`),
        checkService("API server", `${base}/api/healthz`),
      ]);
    } catch (error) {
      console.error(
        `[routed-browser-checks] ${error instanceof Error ? error.message : error}`,
      );
      process.exit(1);
    }
  }

  const test = spawn(
    "pnpm",
    ["exec", "playwright", "test", "e2e/routed-workflows.spec.ts"],
    {
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );

  test.on("error", (error) => {
    console.error(
      `[routed-browser-checks] Could not start Playwright: ${error.message}`,
    );
    process.exitCode = 1;
  });

  test.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await runRoutedWorkflows();
}
