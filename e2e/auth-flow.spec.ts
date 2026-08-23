/**
 * Playwright E2E coverage for the complete Willard AI authentication flow.
 *
 * The first-run and recovery assertions execute when the test database has no
 * password yet. On an already-initialized development database, the suite
 * still verifies the login wall, wrong-password rejection, session persistence,
 * and logout without changing the user's password.
 *
 * Run:
 *   npx playwright test e2e/auth-flow.spec.ts
 */

import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

const INITIAL_PASSWORD = "willard123";
const RECOVERED_PASSWORD = "willard-recovered-2026";

type AuthStatus = { setup: boolean; authenticated: boolean };

async function authStatus(request: APIRequestContext): Promise<AuthStatus> {
  const response = await request.get("/api/auth/status");
  expect(response.ok()).toBeTruthy();
  return await response.json() as AuthStatus;
}

async function loginThroughUi(page: Page, password: string): Promise<void> {
  await page.locator("input[autocomplete='current-password']").fill(password);
  await page.getByRole("button", { name: /authenticate/i }).click();
}

async function expectLoginWall(page: Page): Promise<void> {
  await expect(page.getByText("Authentication required")).toBeVisible();
  await expect(page.locator("input[autocomplete='current-password']")).toBeVisible();
  await expect(page.getByRole("button", { name: /authenticate/i })).toBeVisible();
}

test("first-run setup, login, persistence, logout, and recovery", async ({ page, request }) => {
  const initialStatus = await authStatus(request);
  await page.goto("/");

  let recoveryKey: string | null = null;

  if (initialStatus.setup) {
    await expect(page.getByText("First-run setup")).toBeVisible();
    await page.locator("input[autocomplete='new-password']").fill(INITIAL_PASSWORD);
    await page.getByRole("button", { name: /create_password/i }).click();

    const recoveryKeyElement = page.locator("[data-testid='recovery-key']");
    await expect(recoveryKeyElement).toBeVisible();
    recoveryKey = await recoveryKeyElement.textContent();
    expect(recoveryKey).toMatch(/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/);

    await page.getByRole("checkbox", { name: /saved my recovery key/i }).check();
    await page.getByRole("button", { name: /enter_app/i }).click();
    await expect(page.getByRole("button", { name: /^logout$/i })).toBeVisible();
  } else {
    await expectLoginWall(page);

    await loginThroughUi(page, "definitely-wrong-password");
    await expect(page.getByText("Incorrect password.")).toBeVisible();
    await expectLoginWall(page);

    await loginThroughUi(page, INITIAL_PASSWORD);
    await expect(page.getByRole("button", { name: /^logout$/i })).toBeVisible();
  }

  // A hard reload must retain the server-side session cookie.
  await page.reload();
  await expect(page.getByRole("button", { name: /^logout$/i })).toBeVisible();
  await expect(page.getByText("Authentication required")).not.toBeVisible();

  // Logout must destroy the session and restore the login wall.
  await page.getByRole("button", { name: /^logout$/i }).click();
  await expectLoginWall(page);
  const loggedOutStatus = await authStatus(request);
  expect(loggedOutStatus.authenticated).toBe(false);

  if (!recoveryKey) {
    test.info().annotations.push({
      type: "note",
      description: "Recovery assertions require a first-run database so the one-time key is available.",
    });
    return;
  }

  // Wrong passwords must be rejected even after first-run setup.
  await loginThroughUi(page, "definitely-wrong-password");
  await expect(page.getByText("Incorrect password.")).toBeVisible();
  await expectLoginWall(page);

  await loginThroughUi(page, INITIAL_PASSWORD);
  await expect(page.getByRole("button", { name: /^logout$/i })).toBeVisible();
  await page.getByRole("button", { name: /^logout$/i }).click();
  await expectLoginWall(page);

  // Recovery must establish a session and replace the old password.
  await page.getByRole("button", { name: /forgot password/i }).click();
  await page.locator("input[autocomplete='off']").fill(recoveryKey);
  await page.locator("input[autocomplete='new-password']").fill(RECOVERED_PASSWORD);
  await page.getByRole("button", { name: /reset_password/i }).click();
  await expect(page.getByRole("button", { name: /^logout$/i })).toBeVisible();

  await page.getByRole("button", { name: /^logout$/i }).click();
  await expectLoginWall(page);
  await loginThroughUi(page, INITIAL_PASSWORD);
  await expect(page.getByText("Incorrect password.")).toBeVisible();
  await expectLoginWall(page);

  await loginThroughUi(page, RECOVERED_PASSWORD);
  await expect(page.getByRole("button", { name: /^logout$/i })).toBeVisible();
});