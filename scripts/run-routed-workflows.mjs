import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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

const MAX_LINES_PER_LOG = 8;
const MAX_LOG_FILES = 12;
const MAX_STARTUP_OUTPUT_LENGTH = 2_000;

function normalizeLogPaths(paths) {
  if (paths == null) return [];
  return [...new Set((Array.isArray(paths) ? paths : [paths]).filter(Boolean))];
}

function rotationPattern(logName) {
  const escapedName = logName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^${escapedName}(?:\\.\\d+|[-.]\\d{8}(?:[-_.]\\d{6})?|[-.]\\d{4}[-_]\\d{2}[-_]\\d{2}(?:[T_.-]\\d{2}[-:.]\\d{2}[-:.]\\d{2}Z?)?)$`,
  );
}

async function discoverRotatedLogPaths(logPaths) {
  const candidates = new Map();

  for (const logPath of logPaths) {
    let requestedMtime = 0;
    try {
      requestedMtime = (await stat(logPath)).mtimeMs;
    } catch {
      // The requested log may not exist yet.
    }
    candidates.set(logPath, requestedMtime);
    try {
      const entries = await readdir(dirname(logPath), { withFileTypes: true });
      const logName = basename(logPath);
      const rotation = rotationPattern(logName);

      for (const entry of entries) {
        if (!entry.isFile() || !rotation.test(entry.name)) continue;
        const candidatePath = join(dirname(logPath), entry.name);
        try {
          const details = await stat(candidatePath);
          candidates.set(candidatePath, details.mtimeMs);
        } catch {
          // A rotated file may disappear between directory discovery and stat.
        }
      }
    } catch {
      // The configured directory may not exist until a service starts.
    }
  }

  const requestedPaths = new Set(logPaths);
  return [...candidates.entries()]
    .sort(([leftPath, leftTime], [rightPath, rightTime]) => {
      if (leftTime !== rightTime) return rightTime - leftTime;
      if (requestedPaths.has(leftPath) !== requestedPaths.has(rightPath)) {
        return requestedPaths.has(leftPath) ? -1 : 1;
      }
      return leftPath.localeCompare(rightPath);
    })
    .slice(0, MAX_LOG_FILES)
    .map(([logPath]) => logPath);
}

export async function recentStartupOutput(name, paths = serviceLogPaths[name]) {
  const logPaths = normalizeLogPaths(paths);
  const discoveredLogPaths = await discoverRotatedLogPaths(logPaths);
  const outputs = [];

  for (const logPath of discoveredLogPaths) {
    try {
      const output = await readFile(logPath, "utf8");
      const lines = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length > 0) {
        outputs.push(...lines.slice(-MAX_LINES_PER_LOG));
      }
    } catch {
      // A service may only write stdout or stderr, so a missing companion log
      // is expected.
    }
  }

  if (outputs.length === 0) return null;

  // Startup failures are normally near the end of the service logs. Keep the
  // routed-check failure actionable without flooding the workflow output.
  return outputs.join("\n").slice(0, MAX_STARTUP_OUTPUT_LENGTH);
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

export async function checkRoutedServices(
  base,
  {
    timeoutMs = 120_000,
    logPaths = serviceLogPaths,
    check = checkService,
  } = {},
) {
  const checks = [
    ["Web app", `${base}/`, logPaths["Web app"]],
    ["API server", `${base}/api/healthz`, logPaths["API server"]],
  ];
  const results = await Promise.allSettled(
    checks.map(([name, url, paths]) =>
      check(name, url, timeoutMs, { logPaths: paths }),
    ),
  );
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason instanceof Error
      ? result.reason.message
      : String(result.reason));
  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
}

export async function runRoutedWorkflows() {
  if (appURL) {
    const base = appURL.replace(/\/+$/, "");
    try {
      await checkRoutedServices(base);
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
