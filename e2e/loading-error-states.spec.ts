import { expect, test, type Page } from "@playwright/test";

async function mockShell(page: Page, options: { collectionsError?: boolean; mediaError?: boolean; mediaDelayMs?: number } = {}) {
  let collectionRequests = 0;
  let mediaRequests = 0;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === "/api/healthz") return route.fulfill({ json: { status: "ok" } });
    if (path === "/api/auth/status") return route.fulfill({ json: { setup: false, authenticated: true } });
    if (path === "/api/settings") return route.fulfill({ json: { nasPath: "/media", watcherEnabled: true } });
    if (path === "/api/system/environment") return route.fulfill({ json: { isLocal: false } });
    if (path === "/api/library/jobs/active") return route.fulfill({ json: null });
    if (path === "/api/library/jobs/history") return route.fulfill({ json: { jobs: [] } });

    if (path === "/api/collections") {
      collectionRequests += 1;
      return options.collectionsError
        ? route.fulfill({ status: 503, json: { error: "Service unavailable" } })
        : route.fulfill({ json: { collections: [], favoritesCount: 0 } });
    }
    if (path === "/api/media/files") {
      mediaRequests += 1;
      if (options.mediaDelayMs) await new Promise((resolve) => setTimeout(resolve, options.mediaDelayMs));
      return options.mediaError
        ? route.fulfill({ status: 503, json: { error: "Service unavailable" } })
        : route.fulfill({ json: { files: [], total: 0 } });
    }
    if (path === "/api/media/folders") return route.fulfill({ json: { tree: [] } });
    if (path === "/api/media/tags") return route.fulfill({ json: { tags: [] } });

    return route.fulfill({ json: {} });
  });

  return {
    collectionRequests: () => collectionRequests,
    mediaRequests: () => mediaRequests,
  };
}

test("collections failure is distinct from an empty album list and can be retried", async ({ page }) => {
  const requests = await mockShell(page, { collectionsError: true });
  await page.goto("/collections");

  await expect(page.getByRole("alert")).toContainText("This information could not be loaded.");
  await expect(page.getByText("No albums yet.")).not.toBeVisible();

  await page.getByRole("button", { name: "Try again" }).click();
  await expect.poll(requests.collectionRequests).toBeGreaterThan(1);
});

test("successful empty responses remain an explicit empty state", async ({ page }) => {
  await mockShell(page);
  await page.goto("/collections");

  await expect(page.getByText("No albums yet.")).toBeVisible();
  await expect(page.getByRole("alert")).not.toBeVisible();
});

test("slow media responses show loading before the empty state", async ({ page }) => {
  await mockShell(page, { mediaDelayMs: 500 });
  await page.goto("/media");

  await expect(page.getByRole("status", { name: "Loading media files" })).toBeVisible();
  await expect(page.getByText("No files match your filters.")).not.toBeVisible();
});

test("media failure is distinct from empty filters and query navigation activates only its matching item", async ({ page }) => {
  const requests = await mockShell(page, { mediaError: true });
  await page.goto("/media?type=video");

  await expect(page.getByRole("alert")).toContainText("Media files could not be loaded.");
  await expect(page.getByText("No files match your filters.")).not.toBeVisible();
  await expect(page.getByTestId("link-nav-videos")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("link-nav-photos")).not.toHaveAttribute("aria-current", "page");

  await page.getByRole("button", { name: "Try again" }).click();
  await expect.poll(requests.mediaRequests).toBeGreaterThan(1);

  await page.goto("/library?type=audio");
  await expect(page.getByTestId("link-nav-music")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("link-nav-photos")).not.toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("link-nav-videos")).not.toHaveAttribute("aria-current", "page");
});