import { test, expect, type Page } from "@playwright/test";

const TEST_PASSWORD = "willard123";
const png1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function loginThroughUI(page: Page): Promise<void> {
  const password = page.locator("input[autocomplete='current-password']");
  if (await password.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await password.fill(TEST_PASSWORD);
    await page.getByRole("button", { name: /authenticate/i }).click();
    await expect(password).not.toBeVisible({ timeout: 15_000 });
  }
}

test("renders photo search results with thumbnails and photo icons", async ({ page }) => {
  let thumbnailRequests = 0;
  await page.route("**/api/search/ai-status", (route) =>
    route.fulfill({ json: { pending: 0, analyzedCount: 1, totalCount: 1 } }),
  );
  await page.route("**/api/search/history", (route) => route.fulfill({ json: { history: [] } }));
  await page.route("**/api/search/saved", (route) => route.fulfill({ json: { saved: [] } }));
  await page.route("**/api/search/ai", async (route) => {
    await route.fulfill({
      json: {
        query: "sunset",
        intent: {
          semanticQuery: null, keywords: ["sunset"], mediaTypes: ["image"],
          dateFrom: null, dateTo: null, objects: [], exclude: [], favoriteOnly: false,
          docTypes: [], location: null,
        },
        results: [{
          id: 701, name: "sunset.jpg", relativePath: "sunset.jpg", mediaType: "photo",
          sizeBytes: 1024, thumbnailPath: null, dateTaken: null, favorite: false,
          description: null, confidence: "likely", score: 1.2, reasons: ["Name contains sunset"],
        }],
        suggestions: [],
      },
    });
  });
  await page.route("**/api/media/thumbnail/701", async (route) => {
    thumbnailRequests++;
    await route.fulfill({ status: 200, contentType: "image/png", body: png1x1 });
  });

  await page.goto("/search");
  await loginThroughUI(page);
  await page.getByTestId("input-search").fill("sunset");
  await page.getByTestId("button-search").click();

  const card = page.getByTestId("card-result-701");
  await expect(card).toBeVisible();
  await expect(card.locator("img[alt='sunset.jpg']")).toBeVisible();
  await expect(card.locator("svg").first()).toBeVisible();
  await expect.poll(() => thumbnailRequests).toBeGreaterThan(0);
});