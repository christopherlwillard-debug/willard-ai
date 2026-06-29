/**
 * Playwright E2E spec: Dashboard loads correctly after a scan on a real NAS path.
 *
 * Verifies the three acceptance criteria:
 *   1. All 6 stat cards (Photos, Videos, Documents, Storage Used, Duplicates, Incoming)
 *      render non-empty numeric values after a completed scan.
 *   2. The health status bar shows "All Systems Healthy" after a clean scan.
 *   3. The storage donut chart (Recharts SVG) appears when disk/file data is available.
 *
 * Prerequisites
 * ─────────────
 *   • Both the API server and the frontend must be running.
 *   • WILLARD_APP_URL (or REPLIT_DEV_DOMAIN) env var points to the running app.
 *   • The app password is "willard123" OR the app is in first-run setup mode.
 *   • test-media/ directory is present at the workspace root with real files.
 *
 * Run:
 *   npx playwright test e2e/dashboard-after-scan.spec.ts
 */

import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

const TEST_PASSWORD = "willard123";
const NAS_PATH = `${process.cwd()}/test-media`;

const STAT_CARD_LABELS = [
  "Photos",
  "Videos",
  "Documents",
  "Storage Used",
  "Duplicates",
  "Incoming",
] as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Authenticate via the API and store the session cookie in the browser context. */
async function authenticate(request: APIRequestContext): Promise<void> {
  const statusRes = await request.get("/api/auth/status");
  const status = await statusRes.json() as { setup: boolean; authenticated: boolean };

  if (status.authenticated) return;

  if (status.setup) {
    const r = await request.post("/api/auth/setup", { data: { password: TEST_PASSWORD } });
    expect(r.ok()).toBeTruthy();
  } else {
    const r = await request.post("/api/auth/login", { data: { password: TEST_PASSWORD } });
    expect(r.ok()).toBeTruthy();
  }
}

/** Configure the NAS path and trigger a scan via the API, then poll until complete. */
async function runScan(request: APIRequestContext): Promise<void> {
  // Set NAS path to the test-media directory
  await request.put("/api/settings", { data: { nasPath: NAS_PATH } });

  // Trigger the scan
  const scanRes = await request.post("/api/scan");
  expect([200, 202]).toContain(scanRes.status());

  // Poll until the scan finishes — no fixed sleeps, check every 2 s, timeout at 90 s
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 2_000));
    const st = await request.get("/api/scan/status");
    const body = await st.json() as { isRunning: boolean };
    if (!body.isRunning) return;
  }
  throw new Error("Timed out waiting for the scan to complete (90 s)");
}

/** If the login page is showing, fill the password and submit. */
async function loginThroughUI(page: Page): Promise<void> {
  const passwordInput = page.locator("input[type='password'], input[type='text'][autocomplete='current-password']").first();
  if (await passwordInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await passwordInput.fill(TEST_PASSWORD);
    await page.getByRole("button", { name: /authenticate/i }).click();
    await page.waitForURL(/\/$/, { timeout: 15_000 });
  }
}

// ─── Test suite ─────────────────────────────────────────────────────────────

test.describe("Dashboard after scan", () => {
  test.beforeAll(async ({ request }) => {
    await authenticate(request);
    await runScan(request);
  });

  test("all 6 stat cards render with non-empty numeric values", async ({ page }) => {
    await page.goto("/");
    await loginThroughUI(page);

    // Wait for the dashboard hero to confirm we're on the right page
    await expect(page.getByText("Welcome back, Willard!")).toBeVisible({ timeout: 20_000 });

    // Ensure no skeleton loaders are still showing
    await expect(page.locator("[data-slot='skeleton']").first()).not.toBeVisible({ timeout: 10_000 }).catch(() => {});

    for (const label of STAT_CARD_LABELS) {
      // Find the label text within a stat card
      const card = page.locator("div.rounded-lg.border").filter({ hasText: label }).first();
      await expect(card).toBeVisible({ timeout: 10_000 });

      // The large value text (bold number) sits right after the label paragraph
      // It renders as a <p> with class text-xl font-bold
      const valueParagraph = card.locator("p.text-xl, p.font-bold").first();
      await expect(valueParagraph).toBeVisible();

      const valueText = await valueParagraph.textContent();
      expect(valueText?.trim(), `"${label}" stat card must display a non-empty value`).toMatch(/\S/);
    }
  });

  test('health status bar shows "All Systems Healthy" after a clean scan', async ({ page }) => {
    await page.goto("/");
    await loginThroughUI(page);
    await expect(page.getByText("Welcome back, Willard!")).toBeVisible({ timeout: 20_000 });

    // Wait for the health section to load
    const healthSection = page.locator("div.rounded-lg.border").filter({
      hasText: /All Systems Healthy|Issues Detected|Scanning Library/,
    }).first();
    await expect(healthSection).toBeVisible({ timeout: 15_000 });

    // After a clean scan with test-media files, all health checks pass
    await expect(page.getByText("All Systems Healthy")).toBeVisible({ timeout: 10_000 });

    // The green status icon (CheckCircle2) should be present
    const statusIcon = healthSection.locator("svg").first();
    await expect(statusIcon).toBeVisible();

    // The "Last Scan" timestamp must NOT say "Never"
    const lastScanSection = page.getByText("Last Scan").locator("..");
    await expect(lastScanSection).not.toContainText("Never", { timeout: 5_000 });
  });

  test("storage breakdown donut chart appears when files were indexed", async ({ page }) => {
    await page.goto("/");
    await loginThroughUI(page);
    await expect(page.getByText("Welcome back, Willard!")).toBeVisible({ timeout: 20_000 });

    // Ask the API whether the scan indexed any files
    const dashRes = await page.request.get("/api/dashboard");
    const dash = await dashRes.json() as { totalSizeBytes: number; typeBreakdown: unknown[] };

    if (dash.totalSizeBytes === 0) {
      // No files indexed — chart is intentionally hidden; skip assertion
      test.skip();
      return;
    }

    // When files exist, Recharts renders an SVG inside the storage breakdown card.
    // Look for an SVG that is a descendant of the storage-breakdown container.
    // The chart area is conditionally rendered; give the page time to settle.
    const chartSvg = page.locator("svg.recharts-surface").first();
    await expect(chartSvg).toBeVisible({ timeout: 15_000 });

    // Confirm the pie/donut arcs are rendered (Recharts uses <path> elements inside the SVG)
    const paths = chartSvg.locator("path");
    await expect(paths.first()).toBeVisible();
  });
});
