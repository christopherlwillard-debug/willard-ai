import { defineConfig, devices } from "@playwright/test";
import { execFileSync } from "node:child_process";

const REPLIT_BASE = process.env["REPLIT_DEV_DOMAIN"]
  ? `https://${process.env["REPLIT_DEV_DOMAIN"]}`
  : undefined;

const baseURL = process.env["WILLARD_APP_URL"] ?? REPLIT_BASE ?? "http://localhost:3000";

function findLocalChromium(): string | undefined {
  const configuredPath = process.env["PLAYWRIGHT_EXECUTABLE_PATH"];
  if (configuredPath) return configuredPath;
  if (process.platform !== "linux") return undefined;

  try {
    return execFileSync("which", ["chromium"], { encoding: "utf8" }).trim() || undefined;
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
    baseURL,
    headless: true,
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
    ignoreHTTPSErrors: true,
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
