/**
 * Production origin boundary contract.
 *
 * Run this against the published app with:
 *   WILLARD_APP_URL=https://<published-domain> npx playwright test e2e/origin-boundary.spec.ts
 *
 * The origin is derived from the configured app URL; no local or production
 * hostname is embedded here. The test only mutates an authentication session.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";

const PASSWORD = process.env["WILLARD_TEST_PASSWORD"] ?? "willard123";

async function loginOrSetup(request: APIRequestContext, origin: string): Promise<void> {
  const statusResponse = await request.get("/api/auth/status", {
    headers: { Origin: origin },
  });
  expect(statusResponse.ok()).toBeTruthy();
  const status = await statusResponse.json() as { setup: boolean; authenticated: boolean };
  if (status.authenticated) return;

  const endpoint = status.setup ? "/api/auth/setup" : "/api/auth/login";
  const response = await request.post(endpoint, {
    headers: { Origin: origin },
    data: { password: PASSWORD },
  });
  expect(response.ok()).toBeTruthy();
  expect(response.headers()["access-control-allow-origin"]).toBe(origin);
}

test("configured published origin has credentialed state access", async ({ request }, testInfo) => {
  const configuredUrl = testInfo.project.use.baseURL;
  expect(configuredUrl, "Set WILLARD_APP_URL to the published app URL for this contract").toBeTruthy();
  const trustedOrigin = new URL(configuredUrl!).origin;

  await loginOrSetup(request, trustedOrigin);
  const logout = await request.post("/api/auth/logout", {
    headers: { Origin: trustedOrigin },
  });

  expect(logout.status()).toBe(200);
  expect(logout.headers()["access-control-allow-origin"]).toBe(trustedOrigin);
  expect(logout.headers()["access-control-allow-credentials"]).toBe("true");
});

test("unrelated origin gets no credentialed CORS or state-changing access", async ({ request }, testInfo) => {
  const configuredUrl = testInfo.project.use.baseURL;
  expect(configuredUrl, "Set WILLARD_APP_URL to the published app URL for this contract").toBeTruthy();
  const trustedOrigin = new URL(configuredUrl!).origin;
  const unrelatedOrigin = "https://origin-boundary.invalid";

  await loginOrSetup(request, trustedOrigin);
  const response = await request.post("/api/auth/logout", {
    headers: { Origin: unrelatedOrigin },
  });

  expect(response.status()).toBe(403);
  expect(await response.json()).toEqual({ error: "Untrusted request origin." });
  expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
  expect(response.headers()["access-control-allow-credentials"]).toBeUndefined();

  // The rejected request must not have destroyed the authenticated session.
  const stillAuthenticated = await request.get("/api/auth/status", {
    headers: { Origin: trustedOrigin },
  });
  expect(stillAuthenticated.ok()).toBeTruthy();
  expect((await stillAuthenticated.json()).authenticated).toBe(true);
});