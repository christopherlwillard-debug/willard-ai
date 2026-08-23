/**
 * Playwright regression coverage for DB-first media loading and incremental
 * library updates during a scan.
 *
 * The API responses are deterministic so this test does not depend on the
 * current contents of the development library.
 *
 * Run:
 *   npx playwright test e2e/media-live-library.spec.ts
 */
import { test, expect, type Page } from "@playwright/test";

const png1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function mediaFile(id: number, name: string) {
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
    favorite: false,
    favoritedAt: null,
  };
}

async function mockMediaApis(page: Page): Promise<{
  startScan: () => Promise<void>;
}> {
  const initialFile = mediaFile(901, "already-indexed.jpg");
  const newFile = mediaFile(902, "arrived-during-scan.jpg");
  let scanRunning = false;
  let newFileVisible = false;
  let seqCalls = 0;

  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { setup: false, authenticated: true } }),
  );
  await page.route("**/api/media/folders", (route) =>
    route.fulfill({ json: { tree: [] } }),
  );
  await page.route("**/api/media/files?*", (route) =>
    route.fulfill({
      json: {
        files: newFileVisible ? [initialFile, newFile] : [initialFile],
        total: newFileVisible ? 2 : 1,
        page: 1,
        limit: 60,
      },
    }),
  );
  await page.route("**/api/library/jobs/active", (route) =>
    route.fulfill({
      json: scanRunning
        ? {
            jobId: 501,
            jobType: "SCAN",
            status: "RUNNING",
            phase: "walking",
            profile: "QUICK",
            progress: 40,
            filesProcessed: 1,
            filesTotal: 2,
            currentPath: "arrived-during-scan.jpg",
            currentFileStartedAt: Date.now(),
            etaSeconds: 1,
            speed: 1,
            counters: {
              new: 0,
              modified: 0,
              moved: 0,
              unchanged: 1,
              deleted: 0,
              hashed: 0,
              thumbnails: 0,
              thumbnailsFailed: 0,
              skipped: 0,
              reanalyzed: 0,
            },
            summary: null,
          }
        : null,
    }),
  );
  await page.route("**/api/library/jobs?*", (route) =>
    route.fulfill({ json: { jobs: [] } }),
  );
  await page.route("**/api/library/jobs/events", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body: 'event: jobs\ndata: {"jobs":[],"lastCompleted":null}\n\n',
    }),
  );
  await page.route("**/api/library/seq", (route) => {
    seqCalls++;
    if (scanRunning && seqCalls >= 2) newFileVisible = true;
    return route.fulfill({
      json: {
        seq: newFileVisible ? 2 : 1,
        total: newFileVisible ? 2 : 1,
      },
    });
  });
  await page.route("**/api/library/scan", async (route) => {
    scanRunning = true;
    await route.fulfill({
      status: 202,
      json: { jobId: 501, status: "RUNNING" },
    });
  });
  await page.route("**/api/media/thumbnail/*", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: png1x1 }),
  );

  return {
    startScan: async () => {
      await page.getByRole("button", { name: "Scan Library" }).click();
    },
  };
}

test("loads indexed files immediately and refreshes the grid during a scan", async ({
  page,
}) => {
  const navigationUrls: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigationUrls.push(frame.url());
  });

  const { startScan } = await mockMediaApis(page);
  await page.goto("/media");

  // DB-first loading: an existing file is visible without waiting for a scan
  // and the library area is not left on its full-page loading spinner.
  await expect(page.locator("img[alt='already-indexed.jpg']")).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.locator("[data-testid='media-library-scroll'] svg.animate-spin"),
  ).toHaveCount(0);

  await startScan();

  // The existing grid stays visible while the active scan advertises syncing.
  await expect(page.getByText("Syncing…", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator("img[alt='already-indexed.jpg']")).toBeVisible();

  // The sequence poll changes, invalidating media-files. The new card appears
  // without a page reload or navigation.
  await expect(page.locator("img[alt='arrived-during-scan.jpg']")).toBeVisible({
    timeout: 10_000,
  });
  expect(navigationUrls).toHaveLength(1);
});
