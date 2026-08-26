/**
 * Browser contract for optimization recommendations in the dashboard attention
 * center. Dismissals should apply to one recommendation identity only.
 *
 * Run:
 *   npx playwright test e2e/dashboard-attention-center.spec.ts
 */
import { test, expect, type Page } from "@playwright/test";

const basePath = (process.env.WILLARD_ARTIFACT_BASE_PATH ?? "/").replace(/\/+$/, "") || "";

function routePath(path: string): string {
  return `${basePath}${path}`;
}

async function mockDashboardDependencies(page: Page): Promise<() => void> {
  let optimization = {
    available: true,
    safeFiles: 3,
    estimatedSavingsBytes: 12_000_000,
    formatCount: 1,
    recommendationKey: "ARCHIVE|raw-off|jpg:3:12000000",
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (pathname.endsWith("/api/auth/status")) {
      return route.fulfill({ json: { setup: false, authenticated: true } });
    }
    if (pathname.endsWith("/api/healthz")) {
      return route.fulfill({ json: { ok: true } });
    }
    if (pathname.endsWith("/api/settings")) {
      return route.fulfill({ json: { nasPath: "/test-media", watcherEnabled: true } });
    }
    if (pathname.endsWith("/api/system/environment")) {
      return route.fulfill({ json: { isLocal: false } });
    }
    if (pathname.endsWith("/api/dashboard")) {
      return route.fulfill({
        json: {
          totalFiles: 3,
          totalSizeBytes: 12_000_000,
          archiveCount: 0,
          documentCount: 0,
          duplicateCount: 0,
          duplicateSizeBytes: 0,
          incomingCount: 0,
          isScanning: false,
          lastScanAt: "2026-01-01T00:00:00.000Z",
          typeBreakdown: [{ fileType: "image", count: 3, sizeBytes: 12_000_000 }],
          diskTotal: null,
          diskUsed: null,
          diskFree: null,
          libraryOnline: true,
          libraryPath: "/test-media",
          libraryMessage: null,
        },
      });
    }
    if (pathname.endsWith("/api/media/files")) {
      return route.fulfill({ json: { files: [], total: 0, page: 1, limit: 8 } });
    }
    if (pathname.endsWith("/api/health/status")) {
      return route.fulfill({
        json: { database: true, thumbnailsOk: true, missingFiles: 0, corruptFiles: 0 },
      });
    }
    if (pathname.endsWith("/api/scan/status")) {
      return route.fulfill({ json: { isRunning: false, lastFailed: false } });
    }
    if (pathname.endsWith("/api/archives")) {
      return route.fulfill({ json: { archives: [], total: 0 } });
    }
    if (pathname.endsWith("/api/optimize/status")) {
      return route.fulfill({ json: optimization });
    }
    if (pathname.endsWith("/api/optimize/scan")) {
      return route.fulfill({
        json: {
          scannedAt: "2026-01-01T00:00:00.000Z",
          nasPath: "/test-media",
          totalFiles: optimization.safeFiles,
          totalBytes: optimization.estimatedSavingsBytes,
          totalSavingsBytes: optimization.estimatedSavingsBytes,
          groups: [{
            extension: "jpg",
            fileCount: optimization.safeFiles,
            totalBytes: optimization.estimatedSavingsBytes,
            category: "image",
            status: "convert",
            classification: "safe",
            method: "Re-encode as optimized JPEG",
            targetFormat: "JPEG",
            targetExt: "jpg",
            qualityLoss: "minimal",
            qualityStars: 5,
            qualityLabel: "Imperceptibly different",
            compatibilityLabel: "Excellent",
            estimatedSavingsBytes: optimization.estimatedSavingsBytes,
            estimatedSavingsRatio: 0.2,
            reason: "Routine JPEG optimization",
            explainerText: "Routine JPEG optimization",
            sampleFiles: [],
          }],
          fromCache: true,
        },
      });
    }
    if (pathname.endsWith("/api/optimize/jobs")) {
      return route.fulfill({ json: [] });
    }
    if (pathname.endsWith("/api/library/jobs/active")) {
      return route.fulfill({ json: null });
    }
    if (pathname.endsWith("/api/library/jobs")) {
      return route.fulfill({ json: { jobs: [] } });
    }

    // The dashboard has a few optional background requests. Keep those
    // deterministic without allowing a real mutation to reach the API.
    return route.fulfill({ json: {} });
  });

  // Return the state transition to the test without making the application
  // aware that the recommendation is being changed.
  return () => {
    optimization = {
      ...optimization,
      safeFiles: 4,
      estimatedSavingsBytes: 16_000_000,
      recommendationKey: "ARCHIVE|raw-off|jpg:4:16000000",
    };
  };
}

test("dismissed optimization opportunities return for a new recommendation", async ({ page }) => {
  let conversionStarts = 0;
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      (pathname.endsWith("/api/optimize/jobs") || pathname.includes("/api/optimize/jobs/"))
    ) {
      conversionStarts += 1;
    }
  });

  const changeOptimizationRecommendation = await mockDashboardDependencies(page);
  await page.goto(routePath("/"));

  const firstCard = page.locator("div.group").filter({ hasText: "3 files can be optimized" });
  await expect(firstCard).toBeVisible();
  await expect(firstCard.getByRole("link", { name: "Review" })).toHaveAttribute(
    "href",
    routePath("/optimize"),
  );

  await firstCard.getByRole("button", { name: "Dismiss 3 files can be optimized" }).click();
  await expect(firstCard).not.toBeVisible();

  // A reload verifies that the dismissal is remembered for the same identity.
  await page.reload();
  await expect(page.getByText("3 files can be optimized")).not.toBeVisible();

  changeOptimizationRecommendation();

  // A new identity must not inherit the old dismissal.
  await page.reload();
  const newCard = page.locator("div.group").filter({ hasText: "4 files can be optimized" });
  await expect(newCard).toBeVisible();
  await expect(newCard.getByRole("link", { name: "Review" })).toHaveAttribute(
    "href",
    routePath("/optimize"),
  );

  await newCard.getByRole("link", { name: "Review" }).click();
  await expect(page).toHaveURL(new RegExp(`${routePath("/optimize").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  expect(conversionStarts, "Reviewing a recommendation must not start a conversion").toBe(0);
});