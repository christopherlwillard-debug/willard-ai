/**
 * Browser contracts for workflows that must continue working across routed
 * artifact deployments and temporary browser/server disconnects.
 *
 * Run:
 *   npx playwright test e2e/routed-workflows.spec.ts
 *
 * On NixOS/Replit, replit.nix provides a compatible system Chromium and
 * playwright.config.ts selects it automatically. No LD_LIBRARY_PATH setup is
 * required. Set PLAYWRIGHT_EXECUTABLE_PATH only when using another browser.
 */
import { test, expect, type Page } from "@playwright/test";

const archivePath = "/test-media/backups/photos.zip";
const basePath = (process.env.WILLARD_ARTIFACT_BASE_PATH ?? "/").replace(/\/+$/, "") || "";

function routePath(path: string): string {
  return `${basePath}${path}`;
}

async function mockAuth(page: Page, authenticated = true): Promise<void> {
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { setup: false, authenticated } }),
  );
}

async function mockShell(page: Page): Promise<void> {
  await page.route("**/api/settings", (route) =>
    route.fulfill({ json: { nasPath: "/test-media" } }),
  );
  await page.route("**/api/system/environment", (route) =>
    route.fulfill({ json: { isLocal: false } }),
  );
}

test.describe("routed workflow recovery", () => {
  test("uses the artifact base path for routed pages and API calls", async ({ page }) => {
    await mockAuth(page);
    await mockShell(page);
    const requestedUrls: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/")) requestedUrls.push(new URL(request.url()).pathname);
    });
    await page.route("**/api/archives?*", (route) =>
      route.fulfill({ json: { archives: [], total: 0 } }),
    );

    await page.goto(routePath("/archives"));
    await expect(page.getByRole("heading", { name: "ARCHIVE_INDEX" })).toBeVisible();
    await expect.poll(() => requestedUrls.some((pathname) =>
      pathname === `${basePath}/api/archives` || pathname.startsWith(`${basePath}/api/archives?`),
    )).toBeTruthy();
    await expect(page).toHaveURL(new RegExp(`${basePath.replace("/", "\\/")}\\/archives$`));
  });

  test("hands archive extraction from Archives to Organize", async ({ page }) => {
    await mockAuth(page);
    await mockShell(page);
    await page.route("**/api/archives?*", (route) =>
      route.fulfill({
        json: {
          archives: [{
            id: 41, path: archivePath, filename: "photos.zip",
            folder: "/test-media/backups", sizeBytes: 4096,
            modifiedAt: "2026-01-01T00:00:00.000Z", peekStatus: "pending",
            category: "Photo Archive", containedFileCount: null,
            estimatedExtractionSize: null, isPasswordProtected: false,
            hasNestedArchives: false, photoCount: null, videoCount: null,
            documentCount: null,
          }],
          total: 1,
        },
      }),
    );
    await page.route("**/api/organize/jobs?*", (route) =>
      route.fulfill({ json: { jobs: [] } }),
    );
    await page.route("**/api/organize/recovery", (route) =>
      route.fulfill({ json: { interrupted: [] } }),
    );

    await page.goto(routePath("/archives"));
    await page.getByTitle("Extract this archive via Operations Center").click();
    await expect(page).toHaveURL(new RegExp(`${basePath.replace("/", "\\/")}\\/organize\\?extract=`));
    await expect(page.getByLabel("Full path on NAS")).toHaveValue(archivePath);
  });

  test("shows saved conversion progress after an EventSource disconnect", async ({ page }) => {
    await mockAuth(page);
    await mockShell(page);
    let statusPolls = 0;
    await page.route("**/api/optimize/conversions/recent", (route) => route.fulfill({
      json: [{
        id: 77, status: "failed", approvedExts: ["jpg"], backupDir: null,
        nasPath: "/test-media", totalFiles: 1, processedFiles: 1,
        succeededFiles: 1, failedFiles: 0, skippedFiles: 0, error: "Connection interrupted",
        createdAt: "2026-01-01T00:00:00.000Z", completedAt: null,
      }],
    }));
    await page.route("**/api/optimize/jobs/77/execute", (route) =>
      route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }),
    );
    await page.route("**/api/optimize/jobs/77", (route) => {
      statusPolls += 1;
      return route.fulfill({
        json: {
          id: 77, status: statusPolls > 1 ? "awaiting_action" : "running",
          totalFiles: 1, processedFiles: 1, succeededFiles: 1,
          failedFiles: 0, skippedFiles: 0, error: null,
        },
      });
    });

    await page.goto(routePath("/optimize"));
    await expect(page.getByText(/Connection interrupted — tracking saved progress/)).toBeVisible();
    await expect.poll(() => statusPolls).toBeGreaterThan(0);
  });

  test("offers retry when the authentication service is unavailable", async ({ page }) => {
    let attempts = 0;
    await page.route("**/api/auth/status", (route) => {
      attempts += 1;
      if (attempts === 1) return route.abort("failed");
      return route.fulfill({ json: { setup: false, authenticated: true } });
    });

    await page.goto(routePath("/"));
    await expect(page.getByText("AUTHENTICATION UNAVAILABLE")).toBeVisible();
    await page.getByRole("button", { name: "RETRY_CONNECTION" }).click();
    await expect.poll(() => attempts).toBeGreaterThan(1);
    await expect(page.getByText("AUTHENTICATION UNAVAILABLE")).not.toBeVisible();
  });

  test("gives failed media loads a retry and original-file escape hatch", async ({ page }) => {
    await mockAuth(page);
    await mockShell(page);
    const file = {
      id: 901, nasPath: "/test-media", relativePath: "missing.jpg", name: "missing.jpg",
      extension: "jpg", mimeType: "image/jpeg", mediaType: "photo", sizeBytes: 1024,
      modifiedAt: "2026-01-01T00:00:00.000Z", width: 1, height: 1, orientation: null,
      durationSeconds: null, thumbnailPath: null, indexedAt: "2026-01-01T00:00:00.000Z",
      dateTaken: null, cameraMake: null, cameraModel: null, lens: null, iso: null,
      aperture: null, exposure: null, focalLength: null, flash: null, colorProfile: null,
      gpsLatitude: null, gpsLongitude: null, placeName: null, videoCodec: null,
      videoBitrate: null, fps: null, audioCodec: null, dateCreated: null, pageCount: null,
      pdfAuthor: null, pdfTitle: null, pdfSubject: null, pdfKeywords: null, favorite: false,
      favoritedAt: null, tags: [],
    };
    await page.route("**/api/media/folders", (route) => route.fulfill({ json: { tree: [] } }));
    await page.route("**/api/media/tags", (route) => route.fulfill({ json: { tags: [] } }));
    await page.route("**/api/media/files?*", (route) =>
      route.fulfill({ json: { files: [file], total: 1, page: 1, limit: 60 } }),
    );
    await page.route("**/api/library/jobs/active", (route) => route.fulfill({ json: null }));
    await page.route("**/api/library/jobs?*", (route) => route.fulfill({ json: { jobs: [] } }));
    await page.route("**/api/library/seq", (route) => route.fulfill({ json: { seq: 1, total: 1 } }));
    await page.route("**/api/media/thumbnail/*", (route) => route.fulfill({ status: 404 }));
    await page.route("**/api/media/file/*/stream*", (route) => route.fulfill({ status: 404 }));

    await page.goto(routePath("/media"));
    await page.locator("img[alt='missing.jpg']").click();
    await expect(page.getByText("Could not load image")).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry loading" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open original" })).toHaveAttribute(
      "href",
      new RegExp(`${basePath.replace("/", "\\/")}\\/api\\/media\\/file\\/901\\/stream$`),
    );
  });
});