import { test, expect, type Page } from "@playwright/test";

const HEALTH_RESPONSES = [
  {
    status: "online",
    path: "/test-media",
    watching: true,
    indexingPaused: false,
    lastCheckAt: "2030-01-01T09:55:00.000Z",
    lastOnlineAt: "2030-01-01T09:55:00.000Z",
    reconnectedAt: null,
    activeJob: null,
    watcher: {
      mechanism: "sweep",
      state: "watching",
      sweepIntervalSeconds: 60,
      nextSweepAt: "2030-01-01T10:00:00.000Z",
      lastChangeAt: null,
    },
  },
  {
    status: "online",
    path: "/test-media",
    watching: true,
    indexingPaused: false,
    lastCheckAt: "2030-01-01T09:56:00.000Z",
    lastOnlineAt: "2030-01-01T09:56:00.000Z",
    reconnectedAt: null,
    activeJob: null,
    watcher: {
      mechanism: "sweep",
      state: "watching",
      sweepIntervalSeconds: 60,
      nextSweepAt: "2030-01-01T10:01:00.000Z",
      lastChangeAt: null,
    },
  },
  {
    status: "online",
    path: "/test-media",
    watching: true,
    indexingPaused: false,
    lastCheckAt: "2030-01-01T09:57:00.000Z",
    lastOnlineAt: "2030-01-01T09:57:00.000Z",
    reconnectedAt: null,
    activeJob: null,
    watcher: {
      mechanism: "events",
      state: "watching",
      sweepIntervalSeconds: 60,
      nextSweepAt: null,
      lastChangeAt: null,
    },
  },
] as const;

const dashboardResponse = {
  totalFiles: 0,
  totalSizeBytes: 0,
  archiveCount: 0,
  documentCount: 0,
  duplicateCount: 0,
  duplicateSizeBytes: 0,
  incomingCount: 0,
  isScanning: false,
  lastScanAt: null,
  typeBreakdown: [],
  diskTotal: null,
  diskUsed: null,
  diskFree: null,
  libraryOnline: true,
  libraryPath: "/test-media",
  libraryMessage: "Library is connected",
};

async function mockDashboardApis(page: Page): Promise<{ healthRequests: number[] }> {
  const healthRequests: number[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/api/auth/status")) {
      return route.fulfill({ json: { setup: false, authenticated: true } });
    }
    if (path.endsWith("/api/healthz")) {
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith("/api/system/environment")) {
      return route.fulfill({ json: { isLocal: false } });
    }
    if (path.endsWith("/api/settings")) {
      return route.fulfill({ json: { nasPath: "/test-media", watcherEnabled: true } });
    }
    if (path.endsWith("/api/dashboard")) {
      return route.fulfill({ json: dashboardResponse });
    }
    if (path.endsWith("/api/library/health")) {
      const responseIndex = Math.min(healthRequests.length, HEALTH_RESPONSES.length - 1);
      healthRequests.push(responseIndex);
      return route.fulfill({ json: HEALTH_RESPONSES[responseIndex] });
    }
    if (path.endsWith("/api/health/status")) {
      return route.fulfill({ json: { status: "healthy", checks: [] } });
    }
    if (path.endsWith("/api/library/jobs/active")) {
      return route.fulfill({ json: null });
    }
    if (path.endsWith("/api/library/jobs/history")) {
      return route.fulfill({ json: { jobs: [] } });
    }
    if (path.endsWith("/api/search")) {
      return route.fulfill({ json: { files: [], total: 0 } });
    }
    if (path.endsWith("/api/library/thumbnails/status")) {
      return route.fulfill({ json: { total: 0, built: 0, missing: 0 } });
    }
    if (path.endsWith("/api/library/activity")) {
      return route.fulfill({ json: { entries: [] } });
    }
    return route.fulfill({ json: {} });
  });
  return { healthRequests };
}

test("library status tooltip refreshes sweep time and suppresses it for events", async ({ page }) => {
  const { healthRequests } = await mockDashboardApis(page);
  await page.goto("/");

  const status = page.locator("[title^='Library:']");
  await expect(status).toBeVisible();
  await expect(status).toHaveAttribute("title", /Watching via periodic sweeps/);
  await expect(status).toHaveAttribute("title", /Next sweep Jan 1 10:00 AM/, { timeout: 5_000 });

  await expect.poll(() => healthRequests.length, {
    timeout: 12_000,
    message: "library health should be polled after the initial response",
  }).toBeGreaterThan(1);
  await expect(status).toHaveAttribute("title", /Next sweep Jan 1 10:01 AM/, { timeout: 5_000 });

  await expect.poll(() => healthRequests.length, {
    timeout: 12_000,
    message: "library health should report the watcher mechanism change",
  }).toBeGreaterThan(2);
  await expect(status).toHaveAttribute("title", /Library: \/test-media/);
  await expect(status).not.toHaveAttribute("title", /Watching via periodic sweeps/);
  await expect(status).not.toHaveAttribute("title", /Next sweep/);
});