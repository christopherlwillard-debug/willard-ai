/**
 * Playwright regression coverage for the immersive media viewer.
 *
 * The authentication and media endpoints are mocked so this suite is
 * deterministic and does not depend on rate limits or whichever files are
 * currently in the development library.
 *
 * Run:
 *   npx playwright test e2e/media-viewer.spec.ts
 */

import { test, expect, type Page } from "@playwright/test";

const TEST_PASSWORD = "willard123";

const png1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function mediaFile(id: number, name: string, favorite = false) {
  return {
    id,
    nasPath: "/test-media",
    relativePath: name,
    name,
    extension: "jpg",
    mimeType: "image/jpeg",
    mediaType: "photo",
    sizeBytes: 1024,
    modifiedAt: "2026-01-01T00:00:00.000Z",
    width: 1,
    height: 1,
    orientation: null,
    durationSeconds: null,
    thumbnailPath: null,
    indexedAt: "2026-01-01T00:00:00.000Z",
    dateTaken: "2026-01-01T00:00:00.000Z",
    cameraMake: null,
    cameraModel: null,
    lens: null,
    iso: null,
    aperture: null,
    exposure: null,
    focalLength: null,
    flash: null,
    colorProfile: null,
    gpsLatitude: null,
    gpsLongitude: null,
    placeName: null,
    videoCodec: null,
    videoBitrate: null,
    fps: null,
    audioCodec: null,
    dateCreated: null,
    pageCount: null,
    pdfAuthor: null,
    pdfTitle: null,
    pdfSubject: null,
    pdfKeywords: null,
    favorite,
    favoritedAt: favorite ? "2026-01-02T00:00:00.000Z" : null,
    tags: [],
  };
}

type BrowserDiagnostics = {
  requests: Array<{ method: string; path: string; queryKeys: string[] }>;
  responses: Array<Promise<{
    method: string;
    path: string;
    status: number;
    contentType: string;
    payload?: unknown;
  }>>;
  requestFailures: string[];
  consoleErrors: string[];
  pageErrors: string[];
};

const diagnosticsByPage = new WeakMap<Page, BrowserDiagnostics>();

function summarizePayload(pathname: string, payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const body = payload as Record<string, unknown>;
  if (pathname.endsWith("/api/media/files")) {
    const files = Array.isArray(body.files) ? body.files : [];
    const fixtureFiles = files.every((item) => {
      if (!item || typeof item !== "object") return false;
      const file = item as Record<string, unknown>;
      return file.id === 901 || file.id === 902;
    });
    return {
      fileCount: files.length,
      ...(fixtureFiles
        ? {
            files: files.map((item) => {
              const file = item as Record<string, unknown>;
              return {
                id: file.id,
                name: file.name,
                mediaType: file.mediaType,
                thumbnailPath: file.thumbnailPath,
              };
            }),
          }
        : { fixtureFiles: false }),
      total: body.total,
      page: body.page,
      limit: body.limit,
    };
  }
  if (pathname.endsWith("/api/healthz")) return { ok: body.ok };
  if (/\/api\/media\/files\/\d+\/favorite$/.test(pathname)) return { ok: body.ok };
  if (/\/api\/media\/files\/\d+\/detail$/.test(pathname)) {
    const ai = body.ai && typeof body.ai === "object" ? body.ai as Record<string, unknown> : {};
    return { ai: { analyzed: ai.analyzed, description: ai.description } };
  }
  if (/\/api\/media\/files\/\d+\/rename$/.test(pathname)) return { ok: body.ok };
  return { keys: Object.keys(body).sort() };
}

function captureBrowserDiagnostics(page: Page): void {
  const diagnostics: BrowserDiagnostics = {
    requests: [],
    responses: [],
    requestFailures: [],
    consoleErrors: [],
    pageErrors: [],
  };
  diagnosticsByPage.set(page, diagnostics);

  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.includes("/api/")) return;
    diagnostics.requests.push({
      method: request.method(),
      path: url.pathname,
      queryKeys: [...url.searchParams.keys()].sort(),
    });
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (!url.pathname.includes("/api/")) return;
    const request = response.request();
    const contentType = response.headers()["content-type"] ?? "";
    const shouldSummarizePayload =
      url.pathname.endsWith("/api/healthz") ||
      url.pathname.endsWith("/api/media/files") ||
      /\/api\/media\/files\/\d+\/(detail|favorite|rename)$/.test(url.pathname);
    diagnostics.responses.push(
      (shouldSummarizePayload
        ? response.json().then((payload) => summarizePayload(url.pathname, payload)).catch(() => undefined)
        : Promise.resolve(undefined)
      ).then((payload) => ({
        method: request.method(),
        path: url.pathname,
        status: response.status(),
        contentType,
        ...(payload === undefined ? {} : { payload }),
      })),
    );
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.includes("/api/")) return;
    diagnostics.requestFailures.push(
      `${request.method()} ${url.pathname}: ${request.failure()?.errorText ?? "unknown failure"}`,
    );
  });
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
}

test.afterEach(async ({ page }, testInfo) => {
  const diagnostics = diagnosticsByPage.get(page);
  if (!diagnostics) return;
  const report = {
    requests: diagnostics.requests,
    responses: await Promise.all(diagnostics.responses),
    requestFailures: diagnostics.requestFailures,
    consoleErrors: diagnostics.consoleErrors,
    pageErrors: diagnostics.pageErrors,
  };
  await testInfo.attach("browser-network-console.json", {
    body: Buffer.from(JSON.stringify(report, null, 2)),
    contentType: "application/json",
  });
  console.log(`[media-viewer-browser-diagnostics] ${JSON.stringify(report)}`);
});

async function loginThroughUI(page: Page): Promise<void> {
  const password = page.locator("input[autocomplete='current-password']");
  await expect(password).toBeVisible({ timeout: 15_000 });
  await password.fill(TEST_PASSWORD);
  await page.getByRole("button", { name: /authenticate/i }).click();
  await expect(password).not.toBeVisible({ timeout: 15_000 });
}

async function dismissDevelopmentBanner(page: Page): Promise<void> {
  await page.addStyleTag({
    content: "#replit-dev-banner { display: none !important; pointer-events: none !important; }",
  });
}

async function mockLibrary(page: Page): Promise<void> {
  const files = [mediaFile(901, "sunset.jpg"), mediaFile(902, "beach.jpg")];

  await page.route("**/api/healthz", (route) =>
    route.fulfill({ status: 200, json: { ok: true } }),
  );
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { setup: false, authenticated: true } }),
  );
  await page.route("**/api/media/folders", (route) =>
    route.fulfill({ json: { tree: [] } }),
  );
  await page.route("**/api/media/tags", (route) =>
    route.fulfill({ json: { tags: [] } }),
  );
  await page.route("**/api/settings", (route) =>
    route.fulfill({ json: { nasPath: "/test-media" } }),
  );
  await page.route("**/api/system/environment", (route) =>
    route.fulfill({ json: { isLocal: true } }),
  );
  await page.route("**/api/settings/logo*", (route) =>
    route.fulfill({ status: 404, body: "" }),
  );
  await page.route("**/api/collections", (route) =>
    route.fulfill({ json: { collections: [] } }),
  );
  await page.route("**/api/media/files?*", (route) =>
    route.fulfill({ json: { files, total: files.length, page: 1, limit: 60 } }),
  );
  await page.route("**/api/library/jobs/active", (route) =>
    route.fulfill({ json: null }),
  );
  await page.route("**/api/library/jobs?*", (route) =>
    route.fulfill({ json: { jobs: [] } }),
  );
  await page.route("**/api/library/jobs/history", (route) =>
    route.fulfill({ json: { jobs: [] } }),
  );
  await page.route("**/api/library/jobs/events", (route) =>
    route.fulfill({ json: { events: [] } }),
  );
  await page.route("**/api/library/seq", (route) =>
    route.fulfill({ json: { seq: 1, total: files.length } }),
  );
  await page.route("**/api/media/thumbnail/*", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: png1x1 }),
  );
  await page.route("**/api/media/file/*/stream", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: png1x1 }),
  );
  await page.route("**/api/media/files/*/detail", (route) =>
    route.fulfill({ json: { ai: { analyzed: false, description: null } } }),
  );
  await page.route("**/api/media/files/*/favorite", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await page.route("**/api/media/files/*/rename", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await page.route("**/api/media/files/*", (route) => {
    if (route.request().method() === "DELETE") {
      return route.fulfill({ json: { ok: true } });
    }
    return route.continue();
  });
}

test.describe("Media viewer", () => {
  test("supports navigation, info, favorites, rename validation, filmstrip, and safe delete cancel", async ({ page }) => {
    captureBrowserDiagnostics(page);
    await mockLibrary(page);
    await page.goto("/media");
    await dismissDevelopmentBanner(page);

    const sunsetCard = page.getByRole("button", { name: "Open sunset.jpg" });
    await expect(sunsetCard).toBeVisible({ timeout: 20_000 });
    await sunsetCard.click();

    const viewer = page.getByRole("dialog");
    await expect(viewer).toHaveAttribute("aria-label", "Viewing sunset.jpg");

    // Keyboard navigation and info panel toggle.
    await page.keyboard.press("ArrowRight");
    await expect(viewer).toHaveAttribute("aria-label", "Viewing beach.jpg");
    await page.keyboard.press("i");
    await expect(viewer.getByText("Info", { exact: true })).toBeVisible();
    await page.keyboard.press("i");
    await expect(viewer.getByText("Info", { exact: true })).not.toBeVisible();

    // Favorite changes the button state in the open viewer.
    const favoriteButton = viewer.getByTitle("Add favorite");
    await favoriteButton.click();
    await expect(viewer.getByTitle("Remove favorite")).toBeVisible();

    // The filmstrip can navigate back to the first file.
    await viewer.locator("button").filter({ has: page.locator("img[alt='sunset.jpg']") }).click();
    await expect(viewer).toHaveAttribute("aria-label", "Viewing sunset.jpg");

    // Rename validates blank input and closes cleanly on Escape.
    await viewer.getByTitle("Rename").click();
    const renameDialog = page.getByText("Rename file", { exact: true }).locator("..");
    await expect(renameDialog).toBeVisible();
    const renameInput = renameDialog.locator("input");
    await renameInput.fill("");
    await expect(renameDialog.getByRole("button", { name: "Rename", exact: true })).toBeDisabled();
    await renameInput.press("Escape");
    await expect(renameDialog).not.toBeVisible();
    await expect(viewer).toBeVisible();

    // Delete confirmation names the current file; Cancel leaves the viewer open.
    await page.mouse.move(500, 100);
    await expect(viewer.getByTitle("Remove from library")).toBeVisible();
    await viewer.getByTitle("Remove from library").click();
    const deleteDialog = page.getByText("Remove from library?", { exact: true }).locator("../..");
    await expect(deleteDialog).toBeVisible();
    await expect(deleteDialog.locator("span.font-mono")).toHaveText("sunset.jpg");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByText("Remove from library?", { exact: true })).not.toBeVisible();
    await expect(viewer).toHaveAttribute("aria-label", "Viewing sunset.jpg");

    // Escape closes the immersive viewer without deleting the file.
    await page.keyboard.press("Escape");
    await expect(viewer).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Open sunset.jpg" })).toBeVisible();
  });
});