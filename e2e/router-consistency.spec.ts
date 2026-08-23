/**
 * Playwright smoke coverage for the wouter migration.
 *
 * It proves that Archives can hand an archive path to Operations Center
 * through the URL and that Organize reads the query parameter into its form.
 *
 * Run:
 *   npx playwright test e2e/router-consistency.spec.ts
 */
import { test, expect, type Page } from "@playwright/test";

const archivePath = "/test-media/backups/photos.zip";

async function mockRouterApis(page: Page): Promise<void> {
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { setup: false, authenticated: true } }),
  );
  await page.route("**/api/settings", (route) =>
    route.fulfill({ json: { nasPath: "/test-media" } }),
  );
  await page.route("**/api/system/environment", (route) =>
    route.fulfill({ json: { isLocal: false } }),
  );
  await page.route("**/api/archives?*", (route) =>
    route.fulfill({
      json: {
        archives: [
          {
            id: 41,
            path: archivePath,
            filename: "photos.zip",
            folder: "/test-media/backups",
            sizeBytes: 4096,
            modifiedAt: "2026-01-01T00:00:00.000Z",
            peekStatus: "pending",
            category: "Photo Archive",
            containedFileCount: null,
            estimatedExtractionSize: null,
            isPasswordProtected: false,
            hasNestedArchives: false,
            photoCount: null,
            videoCount: null,
            documentCount: null,
          },
        ],
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
}

test("Archives navigates to Organize and preserves the extract path", async ({
  page,
}) => {
  await mockRouterApis(page);
  await page.goto("/archives");

  await expect(
    page.getByRole("heading", { name: "ARCHIVE_INDEX" }),
  ).toBeVisible();
  await page.getByTitle("Extract this archive via Operations Center").click();

  await expect(page).toHaveURL(/\/organize\?extract=/);
  await expect(
    page.getByRole("heading", { name: "OPERATIONS_CENTER" }),
  ).toBeVisible();
  await expect(page.getByLabel("Full path on NAS")).toHaveValue(archivePath);
});
