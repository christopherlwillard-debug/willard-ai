import { spawn } from "node:child_process";

const appURL =
  process.env.WILLARD_APP_URL ??
  (process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : null);

async function checkService(name, url, timeoutMs = 120_000) {
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

  throw new Error(`${name} readiness failed at ${url} (${lastFailure}).`);
}

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
