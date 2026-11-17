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

function mediaFile(id: number, name: string, favorite = false, mediaType: "photo" | "video" = "photo") {
  return {
    id,
    nasPath: "/test-media",
    relativePath: name,
    name,
    extension: mediaType === "video" ? "mp4" : "jpg",
    mimeType: mediaType === "video" ? "video/mp4" : "image/jpeg",
    mediaType,
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

async function mockLibrary(page: Page): Promise<{ mediaTypeRequests: string[] }> {
  const files = [
    mediaFile(901, "sunset.jpg"),
    mediaFile(902, "beach.jpg"),
    mediaFile(903, "trail.mp4", false, "video"),
  ];
  const mediaTypeRequests: string[] = [];

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
  await page.route("**/api/media/files?*", (route) => {
    const mediaType = new URL(route.request().url()).searchParams.get("mediaType") ?? "all";
    mediaTypeRequests.push(mediaType);
    const filteredFiles = mediaType === "all"
      ? files
      : files.filter((file) => file.mediaType === mediaType);
    return route.fulfill({ json: { files: filteredFiles, total: filteredFiles.length, page: 1, limit: 60 } });
  });
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
  return { mediaTypeRequests };
}

test.describe("Media viewer", () => {
  test("photo and video navigation keeps URL, results, tabs, and sidebar in sync", async ({ page }) => {
    const { mediaTypeRequests } = await mockLibrary(page);
    const photoLink = page.getByTestId("link-nav-photos");
    const videoLink = page.getByTestId("link-nav-videos");
    const photoTab = page.getByRole("button", { name: "Photos", exact: true });
    const videoTab = page.getByRole("button", { name: "Videos", exact: true });

    async function expectPhotosSelected() {
      await expect(page).toHaveURL(/\/media\?type=photo$/);
      await expect(photoTab).toHaveAttribute("aria-pressed", "true");
      await expect(videoTab).toHaveAttribute("aria-pressed", "false");
      await expect(photoLink).toHaveAttribute("aria-current", "page");
      await expect(videoLink).not.toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("button", { name: "Open sunset.jpg" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Open beach.jpg" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Open trail.mp4" })).not.toBeVisible();
      await expect.poll(() => mediaTypeRequests.includes("photo")).toBe(true);
    }

    async function expectVideosSelected() {
      await expect(page).toHaveURL(/\/media\?type=video$/);
      await expect(videoTab).toHaveAttribute("aria-pressed", "true");
      await expect(photoTab).toHaveAttribute("aria-pressed", "false");
      await expect(videoLink).toHaveAttribute("aria-current", "page");
      await expect(photoLink).not.toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("button", { name: "Open trail.mp4" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Open sunset.jpg" })).not.toBeVisible();
      await expect(page.getByRole("button", { name: "Open beach.jpg" })).not.toBeVisible();
      await expect.poll(() => mediaTypeRequests.includes("video")).toBe(true);
    }

    await page.goto("/media?type=photo");
    await dismissDevelopmentBanner(page);
    await expectPhotosSelected();

    await videoLink.click();
    await expectVideosSelected();

    await page.goBack();
    await expectPhotosSelected();
    await page.goForward();
    await expectVideosSelected();

    await page.goto("/media?type=photo");
    await expectPhotosSelected();
    await page.goto("/media?type=video");
    await expectVideosSelected();
  });

  test("supports navigation, info, favorites, rename validation, filmstrip, and safe delete cancel", async ({ page }) => {
    await mockLibrary(page);
    await page.goto("/media");
    await dismissDevelopmentBanner(page);

    const firstCard = page.getByRole("button", { name: "Open sunset.jpg" });
    const firstThumbnail = firstCard.locator("img");
    await expect(firstThumbnail).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => firstThumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);
    await firstCard.click();

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
    await expect(page.locator("img[alt='sunset.jpg']").first()).toBeVisible();
  });
});