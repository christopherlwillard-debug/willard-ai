import { expect, test, type Page } from "@playwright/test";

const basePath = (process.env.WILLARD_ARTIFACT_BASE_PATH ?? "/").replace(/\/+$/, "");

function appPath(path: string): string {
  return `${basePath}${path}`;
}

type HealthJob = {
  id: number;
  jobType: string;
  status: string;
  processed: number;
  total: number | null;
  phase: string | null;
  message: string | null;
  summary: Record<string, unknown> | null;
  error: string | null;
  actions?: string[];
};

function job(
  id: number,
  jobType: string,
  status: string,
  overrides: Partial<HealthJob> = {},
): HealthJob {
  return {
    id,
    jobType,
    status,
    processed: 0,
    total: null,
    phase: "queued",
    message: `${jobType.toLowerCase().replaceAll("_", " ")} is starting`,
    summary: null,
    error: null,
    ...overrides,
  };
}

function report(activeJob: HealthJob | null = null) {
  return {
    checkedAt: "2026-11-14T12:00:00.000Z",
    libraryPath: "/test-media",
    indexedFiles: 20,
    hasReport: true,
    activeJob,
    recoverableCleanup: null,
    status: "attention",
    issues: {
      missingFiles: 0,
      orphanedIndexRecords: 0,
      missingThumbnails: 1,
      orphanedThumbnails: 0,
      emptyFolders: 0,
      brokenMetadataReferences: 0,
      unusedCacheBytes: 0,
      unusedCacheFiles: 0,
    },
  };
}

async function mockSignedInShell(page: Page): Promise<void> {
  // Keep the browser inside the signed-in UI state while the dedicated API
  // integration test covers real authentication and PostgreSQL persistence.
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { setup: false, authenticated: true } }),
  );
  await page.route("**/api/healthz", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await page.route("**/api/settings", (route) =>
    route.fulfill({ json: { nasPath: "/test-media" } }),
  );
  await page.route("**/api/settings/logo*", (route) =>
    route.fulfill({ status: 404, body: "" }),
  );
  await page.route("**/api/system/environment", (route) =>
    route.fulfill({ json: { isLocal: false } }),
  );
  await page.route("**/api/library/jobs/active", (route) =>
    route.fulfill({ json: null }),
  );
  await page.route("**/api/library/jobs/history", (route) =>
    route.fulfill({ json: { jobs: [] } }),
  );
  await page.route("**/api/library/jobs/events*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body: `retry: 30000\nevent: jobs\ndata: ${JSON.stringify({
        streamId: "health-center-e2e",
        sequence: 1,
        jobs: [],
        lastCompleted: null,
      })}\n\n`,
    }),
  );
}

async function blockUnexpectedApiRequests(page: Page, specificPatterns: RegExp[]) {
  const unexpected: string[] = [];
  const commonPatterns = [
    /^GET \/api\/auth\/status$/,
    /^GET \/api\/healthz$/,
    /^GET \/api\/settings$/,
    /^GET \/api\/settings\/logo(?:\?.*)?$/,
    /^GET \/api\/system\/environment$/,
    /^GET \/api\/library\/jobs\/(?:active|history|events)(?:\?.*)?$/,
  ];
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const apiIndex = url.pathname.lastIndexOf("/api/");
    const apiPath = apiIndex >= 0 ? url.pathname.slice(apiIndex) : url.pathname;
    const key = `${route.request().method()} ${apiPath}${url.search}`;
    if ([...commonPatterns, ...specificPatterns].some((pattern) => pattern.test(key))) {
      return route.fallback();
    }
    unexpected.push(key);
    return route.fulfill({ status: 500, json: { error: `Unexpected Health Center test request: ${key}` } });
  });
  return unexpected;
}

async function openHealthCenter(page: Page): Promise<void> {
  await page.goto(appPath("/health"));
  await expect(page.getByRole("heading", { name: "Health Center" })).toBeVisible();
}

test.describe("Health Center durable jobs", () => {
  test("reattaches to a running scan after reload and displays persisted progress", async ({ page }) => {
    await mockSignedInShell(page);
    let healthStatusReads = 0;
    let scanStarts = 0;
    let jobReads = 0;
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.route("**/api/media/health/scan", (route) => {
      scanStarts++;
      return route.fulfill({
        status: 202,
        json: { job: job(101, "HEALTH_SCAN", "RUNNING") },
      });
    });
    await page.route("**/api/media/health/jobs/101", (route) => {
      jobReads++;
      return route.fulfill({
        json: {
          job: job(101, "HEALTH_SCAN", "RUNNING", {
            processed: 7,
            total: 20,
            phase: "catalog",
            message: "Checked 7 of 20 indexed files",
          }),
        },
      });
    });
    await page.route("**/api/media/health", (route) => {
      healthStatusReads++;
      return route.fulfill({
        json: report(job(101, "HEALTH_SCAN", "RUNNING", {
          processed: 4,
          total: 20,
          phase: "catalog",
          message: "Checked 4 of 20 indexed files",
        })),
      });
    });
    const unexpected = await blockUnexpectedApiRequests(page, [
      /^GET \/api\/media\/health$/,
      /^GET \/api\/media\/health\/jobs\/101$/,
    ]);

    await openHealthCenter(page);
    await expect(page.getByText("Task #101")).toBeVisible();
    await expect(page.getByText("7 / 20")).toBeVisible();
    expect(scanStarts, "an existing scan must be reattached, not restarted").toBe(0);
    const readsBeforeReload = healthStatusReads;

    await page.reload();
    await expect(page.getByRole("heading", { name: "Health Center" })).toBeVisible();
    await expect(page.getByText("Task #101")).toBeVisible();
    await expect(page.getByText("7 / 20")).toBeVisible();
    expect(healthStatusReads).toBeGreaterThan(readsBeforeReload);
    expect(jobReads).toBeGreaterThanOrEqual(2);
    expect(scanStarts, "reload must not start a duplicate scan").toBe(0);
    expect(unexpected).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("shows and tracks a cleanup follow-up job through successful completion", async ({ page }) => {
    await mockSignedInShell(page);
    let parentPolls = 0;
    let childPolls = 0;
    let allowChildCompletion = false;
    const trackedIds: number[] = [];

    await page.route("**/api/media/health", (route) =>
      route.fulfill({ json: report() }),
    );
    await page.route("**/api/media/cleanup", async (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({ actions: ["missingThumbnails"] });
      return route.fulfill({
        status: 202,
        json: {
          alreadyRunning: false,
          job: job(202, "HEALTH_CLEANUP", "RUNNING", {
            processed: 0,
            total: 1,
            phase: "queued",
            message: "Cleanup queued",
            actions: ["missingThumbnails"],
          }),
        },
      });
    });
    await page.route("**/api/media/health/scan", (route) =>
      route.fulfill({
        status: 202,
        json: { job: job(204, "HEALTH_SCAN", "RUNNING", { message: "Verifying the library" }) },
      }),
    );
    await page.route("**/api/media/health/jobs/*", (route) => {
      const id = Number(new URL(route.request().url()).pathname.split("/").at(-1));
      trackedIds.push(id);
      if (id === 202) {
        parentPolls++;
        const parentJob = parentPolls === 1
          ? job(202, "HEALTH_CLEANUP", "RUNNING", {
              processed: 1,
              total: 1,
              phase: "cleanup",
              message: "Cleanup step completed",
              actions: ["missingThumbnails"],
            })
          : parentPolls === 2
            ? job(202, "HEALTH_CLEANUP", "DONE", {
                processed: 1,
                total: 1,
                phase: "complete",
                message: "Cleanup completed; starting thumbnail work",
                actions: ["missingThumbnails"],
                summary: {
                  followUpPending: true,
                  followUpRequest: { jobType: "THUMBNAILS", rebuildThumbnails: false },
                },
              })
            : job(202, "HEALTH_CLEANUP", "DONE", {
                processed: 1,
                total: 1,
                phase: "complete",
                message: "Cleanup completed",
                actions: ["missingThumbnails"],
                summary: {
                  followUpPending: false,
                  followUpJobId: 203,
                  followUpJobType: "THUMBNAILS",
                },
              });
        return route.fulfill({ json: { job: parentJob } });
      }
      if (id === 203) {
        childPolls++;
        const childJob = allowChildCompletion
          ? job(203, "THUMBNAILS", "DONE", {
              processed: 1,
              total: 1,
              phase: "complete",
              message: "Thumbnail rebuild completed",
            })
          : job(203, "THUMBNAILS", "RUNNING", {
              processed: 0,
              total: 1,
              phase: "thumbnails",
              message: "Rebuilding missing thumbnails",
            });
        return route.fulfill({ json: { job: childJob } });
      }
      if (id === 204) {
        return route.fulfill({
          json: {
            job: job(204, "HEALTH_SCAN", "DONE", {
              phase: "complete",
              summary: { healthReport: report() },
            }),
          },
        });
      }
      return route.fulfill({ status: 404, json: { error: `Unexpected job ${id}` } });
    });
    const unexpected = await blockUnexpectedApiRequests(page, [
      /^GET \/api\/media\/health$/,
      /^POST \/api\/media\/cleanup$/,
      /^POST \/api\/media\/health\/scan$/,
      /^GET \/api\/media\/health\/jobs\/\d+$/,
    ]);

    await openHealthCenter(page);
    const rebuildCheckbox = page.getByRole("checkbox", { name: "Regenerate missing thumbnails" });
    await rebuildCheckbox.check();
    await page.getByRole("button", { name: "Run Cleanup" }).click();

    await expect(page.getByText("Task #203")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Rebuilding missing thumbnails")).toBeVisible();
    await expect(rebuildCheckbox).toBeChecked();
    expect(parentPolls).toBeGreaterThanOrEqual(3);
    expect(trackedIds).toContain(203);

    allowChildCompletion = true;
    await expect(page.getByText("Cleanup and its follow-up task completed.")).toBeVisible({ timeout: 10_000 });
    await expect(rebuildCheckbox).not.toBeChecked();
    expect(childPolls).toBeGreaterThanOrEqual(2);
    expect(unexpected).toEqual([]);
  });

  test("keeps cleanup selections and shows actionable status after a partial failure", async ({ page }) => {
    await mockSignedInShell(page);
    const actionableError = "One folder could not be checked. Reconnect the NAS and retry cleanup.";

    await page.route("**/api/media/health", (route) =>
      route.fulfill({ json: report() }),
    );
    await page.route("**/api/media/cleanup", (route) =>
      route.fulfill({
        status: 202,
        json: {
          alreadyRunning: false,
          job: job(301, "HEALTH_CLEANUP", "RUNNING", {
            phase: "queued",
            message: "Cleanup queued",
            actions: ["emptyFolders"],
          }),
        },
      }),
    );
    await page.route("**/api/media/health/jobs/301", (route) =>
      route.fulfill({
        json: {
          job: job(301, "HEALTH_CLEANUP", "FAILED", {
            processed: 1,
            total: 2,
            phase: "interrupted",
            message: "Cleanup stopped after a partial result",
            error: actionableError,
            actions: ["emptyFolders"],
            summary: { partial: true, failedItems: 1 },
          }),
        },
      }),
    );
    await page.route("**/api/media/health/scan", (route) =>
      route.fulfill({
        status: 202,
        json: { job: job(302, "HEALTH_SCAN", "RUNNING", { message: "Refreshing the report" }) },
      }),
    );
    await page.route("**/api/media/health/jobs/302", (route) =>
      route.fulfill({
        json: {
          job: job(302, "HEALTH_SCAN", "DONE", {
            phase: "complete",
            summary: { healthReport: report() },
          }),
        },
      }),
    );
    const unexpected = await blockUnexpectedApiRequests(page, [
      /^GET \/api\/media\/health$/,
      /^POST \/api\/media\/cleanup$/,
      /^POST \/api\/media\/health\/scan$/,
      /^GET \/api\/media\/health\/jobs\/30[12]$/,
    ]);

    await openHealthCenter(page);
    const emptyFolderCheckbox = page.getByRole("checkbox", { name: "Remove empty folders" });
    await emptyFolderCheckbox.check();
    await page.getByRole("button", { name: "Run Cleanup" }).click();

    await expect(page.getByText(actionableError)).toBeVisible({ timeout: 10_000 });
    await expect(emptyFolderCheckbox).toBeChecked();
    await expect(page.locator('[role="status"]').filter({ hasText: actionableError })).toBeVisible();
    expect(unexpected).toEqual([]);
  });
});
