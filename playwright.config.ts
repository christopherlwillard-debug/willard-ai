import { defineConfig, devices } from "@playwright/test";
import { execFileSync } from "node:child_process";

const REPLIT_BASE = process.env["REPLIT_DEV_DOMAIN"]
  ? `https://${process.env["REPLIT_DEV_DOMAIN"]}`
  : undefined;

const baseURL =
  process.env["WILLARD_APP_URL"] ?? REPLIT_BASE ?? "http://localhost:5000";
const usesExternalApp = Boolean(
  process.env["WILLARD_APP_URL"] || process.env["REPLIT_DEV_DOMAIN"],
);
const shouldStartLocalServices = !usesExternalApp && (
  process.env["CI"] !== "true" || process.env["WILLARD_START_LOCAL_SERVERS"] === "true"
);
const localWebURL = "http://127.0.0.1:5000";
const localApiHealthURL = "http://127.0.0.1:8080/api/healthz";
const localApiCommand = process.platform === "win32"
  ? "set PORT=8080&& pnpm --filter @workspace/api-server run dev"
  : "PORT=8080 pnpm --filter @workspace/api-server run dev";

function findLocalChromium(): string | undefined {
  const configuredPath = process.env["PLAYWRIGHT_EXECUTABLE_PATH"];
  if (configuredPath) return configuredPath;
  if (process.platform !== "linux") return undefined;

  try {
    return (
      execFileSync("which", ["chromium"], { encoding: "utf8" }).trim() ||
      undefined
    );
  } catch {
    // Standard CI environments can continue using Playwright's bundled browser.
    return undefined;
  }
}

const executablePath = findLocalChromium();

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: "line",
  use: {
    baseURL: usesExternalApp ? baseURL : localWebURL,
    headless: true,
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
    ignoreHTTPSErrors: true,
    screenshot: "only-on-failure",
    video: "off",
  },
  // Local routed checks need both sides of the Vite proxy. Reuse services
  // started from the Replit workflow, but start them for a fresh shell run.
  // External and CI runs supply their own app URL/processes.
  ...(shouldStartLocalServices
    ? {
        webServer: [
          {
            command: localApiCommand,
            url: localApiHealthURL,
            name: "API server",
            timeout: 120_000,
            reuseExistingServer: true,
          },
          {
            command: "pnpm --filter @workspace/willard-ai run dev",
            url: localWebURL,
            name: "web app",
            timeout: 120_000,
            reuseExistingServer: true,
          },
        ],
      }
    : {}),
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
