/**
 * Playwright regression coverage for the immersive media viewer.
 *
 * The media endpoints are mocked after the real authentication gate so this
 * suite is deterministic and does not depend on whichever files are currently
 * in the development library.
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
  };
}

async function loginThroughUI(page: Page): Promise<void> {
  const password = page.locator("input[autocomplete='current-password']");
  if (await password.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await password.fill(TEST_PASSWORD);
    await page.getByRole("button", { name: /authenticate/i }).click();
    await expect(password).not.toBeVisible({ timeout: 15_000 });
  }
}

async function mockLibrary(page: Page): Promise<void> {
  const files = [mediaFile(901, "sunset.jpg"), mediaFile(902, "beach.jpg")];

  await page.route("**/api/media/folders", (route) =>
    route.fulfill({ json: { tree: [] } }),
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
  await page.route("**/api/library/seq", (route) =>
    route.fulfill({ json: { seq: 1, total: files.length } }),
  );
  await page.route("**/api/media/thumbnail/*", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: png1x1 }),
  );
  await page.route("**/api/media/file/*/stream", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: png1x1 }),
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
    await mockLibrary(page);
    await page.goto("/media");
    await loginThroughUI(page);

    await expect(page.locator("img[alt='sunset.jpg']").first()).toBeVisible({ timeout: 20_000 });
    await page.locator("img[alt='sunset.jpg']").first().click();

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
    await expect(page.getByText("Rename file", { exact: true })).toBeVisible();
    const renameInput = page.locator("input").last();
    await renameInput.fill("");
    await expect(page.getByRole("button", { name: "Rename", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(page.getByText("Rename file", { exact: true })).not.toBeVisible();

    // Delete confirmation names the current file; Cancel leaves the viewer open.
    await viewer.getByTitle("Remove from library").click();
    await expect(page.getByText("Remove from library?", { exact: true })).toBeVisible();
    await expect(page.getByText("sunset.jpg", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByText("Remove from library?", { exact: true })).not.toBeVisible();
    await expect(viewer).toHaveAttribute("aria-label", "Viewing sunset.jpg");

    // Escape closes the immersive viewer without deleting the file.
    await page.keyboard.press("Escape");
    await expect(viewer).not.toBeVisible();
    await expect(page.locator("img[alt='sunset.jpg']").first()).toBeVisible();
  });
});