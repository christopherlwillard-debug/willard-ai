/**
 * Cleanup duplicate-page scan-state coverage.
 *
 * The responses below mirror the API contracts consumed by Cleanup. Routing
 * them at the browser boundary keeps each state deterministic while still
 * exercising the generated client hooks, polling behavior, and real button
 * request.
 */
import { test, expect, type Page } from "@playwright/test";

type ScanState = "never" | "running" | "completed";

async function mockCleanupApi(page: Page, state: ScanState): Promise<{ scanRequests: string[] }> {
  let currentState = state;
  const scanRequests: string[] = [];

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === "/api/auth/status") {
      return route.fulfill({ json: { setup: false, authenticated: true } });
    }
    if (path === "/api/settings") {
      return route.fulfill({ json: { nasPath: "/media", watcherEnabled: true } });
    }
    if (path === "/api/system/environment") {
      return route.fulfill({ json: { isLocal: false } });
    }
    if (path === "/api/library/jobs/active") {
      const running = currentState === "running";
      return route.fulfill({
        json: running
          ? {
              jobId: 901,
              jobType: "SCAN",
              status: "RUNNING",
              phase: "Analyzing duplicate candidates",
              profile: "FULL",
              progress: 30,
              filesProcessed: 37,
              filesTotal: 120,
              currentPath: "",
              currentFileStartedAt: null,
              etaSeconds: 10,
              speed: 3,
              counters: {},
              summary: null,
            }
          : {
              jobId: 901,
              jobType: "SCAN",
              status: currentState === "completed" ? "DONE" : "FAILED",
              phase: "finalizing",
              profile: "FULL",
              progress: 100,
              filesProcessed: 120,
              filesTotal: 120,
              currentPath: "",
              currentFileStartedAt: null,
              etaSeconds: 0,
              speed: 0,
              counters: {},
              summary: null,
            },
      });
    }
    if (path === "/api/library/jobs/history") {
      return route.fulfill({ json: { jobs: currentState === "completed" ? [{
        id: 901,
        status: "DONE",
        processedFiles: 120,
        totalFiles: 120,
        startedAt: "2026-08-23T19:00:00.000Z",
        finishedAt: "2026-08-23T20:00:00.000Z",
        error: null,
      }] : [] } });
    }
    if (path === "/api/library/scan" && request.method() === "POST") {
      scanRequests.push(path);
      currentState = "running";
      return route.fulfill({
        status: 202,
        json: { jobId: 901, alreadyRunning: false },
      });
    }
    if (path === "/api/cleanup/duplicates") {
      return route.fulfill({ json: { groups: [], totalGroups: 0, totalWastedBytes: 0 } });
    }
    if (path === "/api/cleanup/summary") {
      return route.fulfill({
        json: {
          duplicateGroups: 0,
          duplicateWastedBytes: 0,
          largeFileCount: 0,
          largeFilesBytes: 0,
          oldFileCount: 0,
          emptyFolderCount: 0,
        },
      });
    }
    if (path === "/api/cleanup/history") {
      return route.fulfill({ json: { sessions: [] } });
    }
    if (path === "/api/cleanup/trash") {
      return route.fulfill({ json: { items: [] } });
    }
    if (path === "/api/cleanup/large-files") {
      return route.fulfill({ json: { files: [], total: 0 } });
    }
    if (path === "/api/cleanup/old-files") {
      return route.fulfill({ json: { files: [], total: 0 } });
    }
    if (path === "/api/cleanup/empty-folders") {
      return route.fulfill({ json: { folders: [] } });
    }
    if (path === "/api/archives") {
      return route.fulfill({ json: { archives: [] } });
    }

    return route.fulfill({ json: {} });
  });

  return { scanRequests };
}

async function openCleanup(page: Page, state: ScanState): Promise<{ scanRequests: string[] }> {
  const fixture = await mockCleanupApi(page, state);
  await page.goto("/cleanup");
  return fixture;
}

test("never-scanned page explains the scan and starts it through POST /api/library/scan", async ({ page }) => {
  const { scanRequests } = await openCleanup(page, "never");

  await expect(page.getByRole("heading", { name: "Run a scan first" })).toBeVisible();
  await expect(page.getByText("identical and visually similar files")).toBeVisible();

  await page.getByRole("button", { name: "Run a scan" }).click();
  await expect.poll(() => scanRequests.length).toBe(1);
  await expect(page.getByText("Scan in progress")).toBeVisible();
});

test("in-progress scan shows its current stage and scanned-file count", async ({ page }) => {
  await openCleanup(page, "running");

  await expect(page.getByRole("heading", { name: "Scan in progress" })).toBeVisible();
  await expect(page.getByText("Analyzing duplicate candidates")).toBeVisible();
  await expect(page.getByText("37 files scanned of 120")).toBeVisible();
});

test("completed scan with no groups shows the clear-library state", async ({ page }) => {
  await openCleanup(page, "completed");

  await expect(page.getByRole("heading", { name: "No duplicates found" })).toBeVisible();
  await expect(page.getByText("Your library is clear of duplicate file groups.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Run a scan first" })).not.toBeVisible();
});