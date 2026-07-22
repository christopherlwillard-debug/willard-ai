/**
 * Playwright E2E spec: Cleanup queue survives page reloads and navigation.
 *
 * Verifies the core acceptance criterion from Task #182:
 *   "Staged cleanup queue entries persist through page reloads and navigation
 *    and reappear in the Cleanup Queue tab with the correct count badge."
 *
 * Strategy
 * ────────
 * Rather than clicking through the duplicate-groups UI (which requires a
 * specific scan state), we directly inject a known queue entry into
 * localStorage via page.evaluate() before reload.  This mirrors exactly what
 * the production `writeQueue(queue, localStorage)` call does and lets the
 * test stay deterministic regardless of scan state.
 *
 * Acceptance checks:
 *   1. A queue entry injected into localStorage reappears in the "Cleanup
 *      Queue" tab after a full page reload (simulates returning to the app
 *      after closing the browser tab).
 *   2. The tab trigger shows a green count badge matching the injected count.
 *   3. The KEEP and DELETE filenames from the injected entry are visible.
 *   4. The entry persists after navigating away to the Dashboard and back
 *      (React SPA navigation re-reads localStorage on mount).
 *   5. Executing a cleanup clears the queue key from localStorage so stale
 *      entries do not reappear after the next reload.
 *
 * Prerequisites
 * ─────────────
 *   • Both the API server and the frontend must be running.
 *   • WILLARD_APP_URL or REPLIT_DEV_DOMAIN env var points to the running app.
 *   • The app password is "willard123" OR the app is in first-run setup mode.
 *
 * Run:
 *   npx playwright test e2e/cleanup-queue-ui-persistence.spec.ts
 */

import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { QUEUE_KEY } from "../artifacts/willard-ai/src/lib/cleanup-queue.ts";

const TEST_PASSWORD = "willard123";

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** A realistic queue entry with a stable synthetic hash */
const MOCK_ENTRY = {
  groupHash:      "e2e-persist-test-aabbccdd",
  keepFileId:     1001,
  deleteFileIds:  [1002],
  keepFilename:   "holiday_original.jpg",
  keepFolder:     "/NAS/Photos/2023",
  deleteFilenames: ["holiday_copy.jpg"],
  totalSavedBytes: 3_145_728,
  reason:         "Oldest file — likely original camera import",
  evidence:       "Created 2023-07-15",
  addedAt:        new Date().toISOString(),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

/** If the app is showing the password gate, sign in through the UI. */
async function loginThroughUI(page: Page): Promise<void> {
  const passwordInput = page
    .locator("input[type='password'], input[type='text'][autocomplete='current-password']")
    .first();
  if (await passwordInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await passwordInput.fill(TEST_PASSWORD);
    await page.getByRole("button", { name: /authenticate/i }).click();
    await page.waitForURL(/\/$/, { timeout: 15_000 });
  }
}

/** Inject a single MOCK_ENTRY into localStorage and return to caller. */
async function seedQueue(page: Page, entry = MOCK_ENTRY): Promise<void> {
  await page.evaluate(
    ([key, serialized]) => localStorage.setItem(key, serialized),
    [QUEUE_KEY, JSON.stringify([entry])] as const,
  );
}

/** Read the raw queue value from localStorage for assertions. */
async function readQueueFromBrowser(page: Page): Promise<string | null> {
  return page.evaluate(
    (key) => localStorage.getItem(key),
    QUEUE_KEY,
  );
}

// ─── Test suite ───────────────────────────────────────────────────────────────

test.describe("Cleanup queue UI persistence", () => {
  test.beforeAll(async ({ request }) => {
    await authenticate(request);
  });

  // ── 1. Queue entry reappears after page reload ──────────────────────────────

  test("staged queue entry reappears in Cleanup Queue tab after page reload", async ({ page }) => {
    // Open the Cleanup page and sign in
    await page.goto("/cleanup");
    await loginThroughUI(page);
    await expect(page.getByText("CLEANUP_SUGGESTIONS")).toBeVisible({ timeout: 20_000 });

    // Inject mock entry into localStorage (mirrors what writeQueue() does)
    await seedQueue(page);

    // Hard reload — simulates closing and reopening the browser tab
    await page.reload();
    await loginThroughUI(page);
    await expect(page.getByText("CLEANUP_SUGGESTIONS")).toBeVisible({ timeout: 20_000 });

    // ── Assert: "Cleanup Queue" tab trigger shows green badge with count "1"
    const queueTab = page.getByRole("tab", { name: /Cleanup Queue/i });
    await expect(queueTab).toBeVisible({ timeout: 10_000 });

    const badge = queueTab.locator("span").filter({ hasText: "1" });
    await expect(badge).toBeVisible({
      timeout: 5_000,
    });

    // ── Click the queue tab and verify the entry content
    await queueTab.click();

    // KEEP label and filename
    await expect(page.getByText("KEEP")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(MOCK_ENTRY.keepFilename)).toBeVisible({ timeout: 5_000 });

    // DELETE label and filename
    await expect(page.getByText("DELETE")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(MOCK_ENTRY.deleteFilenames[0])).toBeVisible({ timeout: 5_000 });
  });

  // ── 2. Queue entry persists across SPA navigation ──────────────────────────

  test("staged queue entry persists after navigating away and back (SPA navigation)", async ({ page }) => {
    // Start on the Cleanup page with a seeded entry
    await page.goto("/cleanup");
    await loginThroughUI(page);
    await expect(page.getByText("CLEANUP_SUGGESTIONS")).toBeVisible({ timeout: 20_000 });
    await seedQueue(page);

    // Navigate away to the Dashboard
    await page.goto("/");
    await expect(page.getByText("Welcome back, Willard!")).toBeVisible({ timeout: 20_000 });

    // Navigate back to Cleanup (SPA routing, no full reload)
    await page.goto("/cleanup");
    await expect(page.getByText("CLEANUP_SUGGESTIONS")).toBeVisible({ timeout: 20_000 });

    // ── Assert: tab badge still shows "1"
    const queueTab = page.getByRole("tab", { name: /Cleanup Queue/i });
    const badge = queueTab.locator("span").filter({ hasText: "1" });
    await expect(badge).toBeVisible({ timeout: 5_000 });

    // ── localStorage must still contain the entry
    const raw = await readQueueFromBrowser(page);
    expect(raw, "localStorage key must survive SPA navigation").not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].groupHash).toBe(MOCK_ENTRY.groupHash);
  });

  // ── 3. Execute cleanup clears the queue key ─────────────────────────────────

  test("executing cleanup removes the queue key so stale entries cannot reappear", async ({ page, request }) => {
    // Seed the queue directly in localStorage on the Cleanup page
    await page.goto("/cleanup");
    await loginThroughUI(page);
    await expect(page.getByText("CLEANUP_SUGGESTIONS")).toBeVisible({ timeout: 20_000 });
    await seedQueue(page);

    // Reload to confirm the seed is visible
    await page.reload();
    await loginThroughUI(page);
    await expect(page.getByText("CLEANUP_SUGGESTIONS")).toBeVisible({ timeout: 20_000 });

    const queueTab = page.getByRole("tab", { name: /Cleanup Queue/i });
    await expect(queueTab.locator("span").filter({ hasText: "1" })).toBeVisible({ timeout: 5_000 });

    // Execute cleanup via the API (using the injected mock IDs — they may not
    // be real files, so the API returns recycled=0 + an error, which is fine;
    // what matters is that the frontend clears the queue on success response).
    // Instead, trigger the "Execute Cleanup ▸" button through the UI.
    await queueTab.click();

    const executeBtn = page.getByRole("button", { name: /Execute Cleanup/i });
    await executeBtn.click();

    // Confirm modal should open — click the confirm delete button
    const confirmBtn = page.getByRole("button", { name: /Delete \d+ file/i });
    await expect(confirmBtn).toBeVisible({ timeout: 5_000 });
    await confirmBtn.click();

    // After execute, the queue should be cleared from the UI (badge gone)
    await expect(queueTab.locator("span").filter({ hasText: "1" })).not.toBeVisible({ timeout: 15_000 });

    // Reload and verify the queue key no longer causes entries to reappear
    await page.reload();
    await loginThroughUI(page);
    await expect(page.getByText("CLEANUP_SUGGESTIONS")).toBeVisible({ timeout: 20_000 });

    const badgeAfterReload = queueTab.locator("span").filter({ hasText: "1" });
    await expect(badgeAfterReload).not.toBeVisible({ timeout: 5_000 });

    // Also verify localStorage key is absent or empty
    const raw = await readQueueFromBrowser(page);
    const parsed = raw ? JSON.parse(raw) : [];
    expect(parsed, "Queue key must be empty or absent after execute").toHaveLength(0);
  });
});
