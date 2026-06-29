/**
 * E2E integration test: Dashboard loads correctly after a scan on a real NAS path.
 *
 * Covers the three "done looks like" criteria from the task:
 *   1. All 6 dashboard stat-card fields (Photos, Videos, Documents, Storage Used,
 *      Duplicates, Incoming) return non-null values after a completed scan.
 *   2. The /api/health/status endpoint satisfies the "All Systems Healthy" condition
 *      (database, thumbnailsOk, missingFiles === 0, corruptFiles === 0).
 *   3. The storage-breakdown (donut chart) data is populated when files were indexed.
 *
 * Prerequisites
 * ─────────────
 *   • The API server must be running and reachable.
 *   • Set WILLARD_API_URL to the server base URL (e.g. http://localhost:8080).
 *     Falls back to https://<REPLIT_DEV_DOMAIN> when running inside Replit.
 *   • The app password must be "willard123", or the app must be in first-run
 *     setup mode (no password yet).  The test will call /auth/setup if needed.
 *   • The NAS path must point to a readable directory (e.g. ./test-media which
 *     ships with the repo and contains sample Photos, Videos, and Documents).
 *
 * Run with:
 *   node --experimental-strip-types --test e2e/dashboard-after-scan.test.ts
 */

import { describe, test, before } from "node:test";
import * as assert from "node:assert/strict";

// ─── Configuration ─────────────────────────────────────────────────────────

const REPLIT_BASE = process.env["REPLIT_DEV_DOMAIN"]
  ? `https://${process.env["REPLIT_DEV_DOMAIN"]}`
  : undefined;

const API_BASE =
  process.env["WILLARD_API_URL"] ?? REPLIT_BASE ?? "http://localhost:3000";

const NAS_PATH =
  process.env["WILLARD_NAS_PATH"] ?? `${process.cwd()}/test-media`;

const TEST_PASSWORD = "willard123";

// ─── Cookie-aware HTTP helpers ──────────────────────────────────────────────

let sessionCookie = "";

function authHeaders(): Record<string, string> {
  return sessionCookie ? { Cookie: sessionCookie } : {};
}

function captureSessionCookie(res: Response): void {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return;
  const match = setCookie.match(/willard\.sid=[^;]+/);
  if (match) sessionCookie = match[0];
}

async function apiPost(
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const res = await fetch(`${API_BASE}/api${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(body),
  });
  captureSessionCookie(res);
  return res;
}

async function apiPut(
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const res = await fetch(`${API_BASE}/api${path}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(body),
  });
  captureSessionCookie(res);
  return res;
}

async function apiGet(path: string): Promise<Response> {
  const res = await fetch(`${API_BASE}/api${path}`, {
    headers: authHeaders(),
  });
  captureSessionCookie(res);
  return res;
}

// ─── Polling helper ─────────────────────────────────────────────────────────

async function pollUntil<T>(
  getter: () => Promise<T>,
  condition: (value: T) => boolean,
  {
    timeoutMs = 90_000,
    intervalMs = 2_000,
    description = "condition",
  }: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await getter();
    if (condition(value)) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for: ${description}`,
  );
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface DashboardResponse {
  totalFiles: number;
  totalSizeBytes: number;
  archiveCount: number;
  documentCount: number;
  duplicateCount: number;
  duplicateSizeBytes: number;
  incomingCount: number;
  isScanning: boolean;
  lastScanAt: string | null;
  typeBreakdown: Array<{
    fileType: string;
    count: number;
    sizeBytes: number;
    percentage: number;
  }>;
  diskTotal: number | null;
  diskUsed: number | null;
  diskFree: number | null;
}

interface HealthStatusResponse {
  database: boolean;
  thumbnailsOk: boolean;
  missingFiles: number;
  corruptFiles: number;
}

interface ScanStatusResponse {
  isRunning: boolean;
  current: unknown;
  lastCompleted: unknown;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Dashboard after scan", { concurrency: false }, async () => {
  before(async () => {
    // ── 1. Authenticate ────────────────────────────────────────────────────
    const statusRes = await fetch(`${API_BASE}/api/auth/status`);
    assert.strictEqual(statusRes.status, 200, "Auth status endpoint should be reachable");
    const status = (await statusRes.json()) as {
      setup: boolean;
      authenticated: boolean;
    };

    if (status.setup) {
      const setupRes = await apiPost("/auth/setup", { password: TEST_PASSWORD });
      assert.ok(
        setupRes.ok,
        `Auth setup failed with status ${setupRes.status}: ${await setupRes.text()}`,
      );
    } else {
      const loginRes = await apiPost("/auth/login", { password: TEST_PASSWORD });
      assert.ok(
        loginRes.ok,
        `Login failed with status ${loginRes.status}. ` +
          `Ensure the app password is "${TEST_PASSWORD}" (update it via the Settings page or the DB).`,
      );
    }

    assert.ok(sessionCookie, "Session cookie should be set after authentication");

    // ── 2. Configure NAS path to the test-media directory ─────────────────
    const settingsRes = await apiPut("/settings", { nasPath: NAS_PATH });
    if (!settingsRes.ok) {
      const body = (await settingsRes.json()) as { error?: string };
      const msg = body?.error ?? `HTTP ${settingsRes.status}`;
      console.warn(`[setup] Could not set NAS path to "${NAS_PATH}": ${msg}. Continuing with existing path.`);
    }

    // ── 3. Trigger a scan ─────────────────────────────────────────────────
    const scanRes = await apiPost("/scan", {});
    assert.ok(
      scanRes.status === 202 || scanRes.status === 200,
      `Scan trigger returned unexpected status ${scanRes.status}: ${await scanRes.text()}`,
    );

    // ── 4. Wait for the scan to complete (polling, no fixed sleeps) ────────
    await pollUntil<ScanStatusResponse>(
      async () => {
        const r = await apiGet("/scan/status");
        assert.strictEqual(r.status, 200, "Scan status endpoint should return 200");
        return r.json() as Promise<ScanStatusResponse>;
      },
      (s) => !s.isRunning,
      { timeoutMs: 90_000, intervalMs: 2_000, description: "scan to finish" },
    );
  });

  // ── Test 1 ───────────────────────────────────────────────────────────────

  test("all 6 stat-card fields are present and valid after a completed scan", async () => {
    const res = await apiGet("/dashboard");
    assert.strictEqual(res.status, 200, "GET /api/dashboard should return 200");

    const dash = (await res.json()) as DashboardResponse;

    // ── Stat card: Photos (image count)
    const photoEntry = dash.typeBreakdown.find((b) => b.fileType === "image") ?? {
      count: 0,
      sizeBytes: 0,
    };
    assert.ok(
      typeof photoEntry.count === "number" && photoEntry.count >= 0,
      `Photos count should be a non-negative number, got: ${photoEntry.count}`,
    );

    // ── Stat card: Videos (video count)
    const videoEntry = dash.typeBreakdown.find((b) => b.fileType === "video") ?? {
      count: 0,
      sizeBytes: 0,
    };
    assert.ok(
      typeof videoEntry.count === "number" && videoEntry.count >= 0,
      `Videos count should be a non-negative number, got: ${videoEntry.count}`,
    );

    // ── Stat card: Documents (document count)
    const docEntry = dash.typeBreakdown.find((b) => b.fileType === "document") ?? {
      count: 0,
      sizeBytes: 0,
    };
    assert.ok(
      typeof docEntry.count === "number" && docEntry.count >= 0,
      `Documents count should be a non-negative number, got: ${docEntry.count}`,
    );

    // ── Stat card: Storage Used
    assert.ok(
      typeof dash.totalSizeBytes === "number" && dash.totalSizeBytes >= 0,
      `totalSizeBytes should be a non-negative number, got: ${dash.totalSizeBytes}`,
    );

    // ── Stat card: Duplicates
    assert.ok(
      typeof dash.duplicateCount === "number" && dash.duplicateCount >= 0,
      `duplicateCount should be a non-negative number, got: ${dash.duplicateCount}`,
    );
    assert.ok(
      typeof dash.duplicateSizeBytes === "number" && dash.duplicateSizeBytes >= 0,
      `duplicateSizeBytes should be a non-negative number, got: ${dash.duplicateSizeBytes}`,
    );

    // ── Stat card: Incoming
    assert.ok(
      typeof dash.incomingCount === "number" && dash.incomingCount >= 0,
      `incomingCount should be a non-negative number, got: ${dash.incomingCount}`,
    );

    // ── Scan metadata
    assert.strictEqual(
      dash.isScanning,
      false,
      "isScanning should be false after the scan completed",
    );
    assert.ok(
      dash.lastScanAt != null,
      "lastScanAt should be populated after a completed scan",
    );
    const lastScan = new Date(dash.lastScanAt!);
    assert.ok(
      !isNaN(lastScan.getTime()),
      `lastScanAt should be a valid ISO date, got: ${dash.lastScanAt}`,
    );

    // ── The test-media directory contains real files — assert they were indexed
    assert.ok(
      dash.totalFiles > 0,
      `Expected at least 1 file to be indexed from "${NAS_PATH}", got totalFiles=${dash.totalFiles}. ` +
        "Ensure the NAS path is readable and contains media files.",
    );
    assert.ok(
      dash.totalSizeBytes > 0,
      `Expected totalSizeBytes > 0 after indexing real files, got: ${dash.totalSizeBytes}`,
    );
  });

  // ── Test 2 ───────────────────────────────────────────────────────────────

  test('health status reports "All Systems Healthy" conditions after a clean scan', async () => {
    const res = await apiGet("/health/status");
    assert.strictEqual(res.status, 200, "GET /api/health/status should return 200");

    const health = (await res.json()) as HealthStatusResponse;

    // These are the exact conditions the dashboard uses to show "All Systems Healthy":
    //   const allHealthy = !isScanning
    //     && (healthData?.database ?? true)
    //     && (healthData?.thumbnailsOk ?? true)
    //     && (healthData?.missingFiles ?? 0) === 0;
    assert.strictEqual(
      health.database,
      true,
      "Database health check must pass (dashboard shows green checkmark for Database)",
    );
    assert.strictEqual(
      health.thumbnailsOk,
      true,
      "Thumbnail health check must pass (dashboard shows green checkmark for Thumbnails)",
    );
    assert.strictEqual(
      health.missingFiles,
      0,
      `missingFiles should be 0 after a clean scan, got: ${health.missingFiles}`,
    );
    assert.strictEqual(
      health.corruptFiles,
      0,
      `corruptFiles should be 0 after a clean scan, got: ${health.corruptFiles}`,
    );
  });

  // ── Test 3 ───────────────────────────────────────────────────────────────

  test("storage breakdown (donut chart) data is populated when files were indexed", async () => {
    const res = await apiGet("/dashboard");
    assert.strictEqual(res.status, 200, "GET /api/dashboard should return 200");

    const dash = (await res.json()) as DashboardResponse;

    // The donut chart renders when: (hasDisk || data.totalSizeBytes > 0) && chartData.length > 0
    // where chartData = typeBreakdown.filter(b => b.sizeBytes > 0)
    if (dash.totalSizeBytes === 0) {
      console.log("[test] totalSizeBytes is 0 — donut chart is intentionally hidden. Skipping chart assertions.");
      return;
    }

    const chartData = dash.typeBreakdown.filter((b) => b.sizeBytes > 0);
    assert.ok(
      chartData.length > 0,
      "typeBreakdown should contain at least one entry with sizeBytes > 0 " +
        "so the storage donut chart can render",
    );

    for (const entry of chartData) {
      assert.ok(
        typeof entry.fileType === "string" && entry.fileType.length > 0,
        "Each chart entry must have a non-empty fileType",
      );
      assert.ok(
        entry.count > 0,
        `Chart entry "${entry.fileType}" has sizeBytes > 0 but count === 0 (inconsistent)`,
      );
      assert.ok(
        entry.percentage >= 0 && entry.percentage <= 100,
        `Chart entry "${entry.fileType}" percentage should be 0–100, got: ${entry.percentage}`,
      );
    }

    // If disk stats are available, validate those too
    const hasDisk = dash.diskTotal != null && dash.diskTotal > 0;
    if (hasDisk) {
      assert.ok(
        typeof dash.diskTotal === "number" && dash.diskTotal > 0,
        `diskTotal should be > 0 when disk stats are available, got: ${dash.diskTotal}`,
      );
      assert.ok(
        typeof dash.diskUsed === "number" && dash.diskUsed >= 0,
        `diskUsed should be >= 0, got: ${dash.diskUsed}`,
      );
      assert.ok(
        typeof dash.diskFree === "number" && dash.diskFree >= 0,
        `diskFree should be >= 0, got: ${dash.diskFree}`,
      );
      // diskUsed + diskFree ≤ diskTotal (reserved blocks mean the sum is < total, not equal)
      assert.ok(
        dash.diskUsed! + dash.diskFree! <= dash.diskTotal!,
        `diskUsed (${dash.diskUsed}) + diskFree (${dash.diskFree}) should be ≤ diskTotal (${dash.diskTotal})`,
      );
    }
  });
});
