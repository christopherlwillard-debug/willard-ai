/**
 * E2E integration test: completed scan diagnostics remain readable from the
 * persisted library_jobs record.
 *
 * Run with:
 *   node --experimental-strip-types --test e2e/diagnostics-persistence.test.ts
 *
 * The API server must be running. Set WILLARD_API_URL to its base URL, or the
 * test falls back to the Replit development domain and then localhost:3000.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const REPLIT_BASE = process.env["REPLIT_DEV_DOMAIN"]
  ? `https://${process.env["REPLIT_DEV_DOMAIN"]}`
  : undefined;
const API_BASE = process.env["WILLARD_API_URL"] ?? REPLIT_BASE ?? "http://localhost:3000";
const NAS_PATH = process.env["WILLARD_NAS_PATH"] ?? `${process.cwd()}/test-media`;
const TEST_PASSWORD = "willard123";

let sessionCookie = "";
let originalNasPath = "";
let settingsSnapshotTaken = false;

function authHeaders(): Record<string, string> {
  return sessionCookie ? { Cookie: sessionCookie } : {};
}

function captureSessionCookie(response: Response): void {
  const setCookie = response.headers.get("set-cookie");
  const match = setCookie?.match(/willard\.sid=[^;]+/);
  if (match) sessionCookie = match[0];
}

async function apiGet(route: string): Promise<Response> {
  const response = await fetch(`${API_BASE}/api${route}`, { headers: authHeaders() });
  captureSessionCookie(response);
  return response;
}

async function apiPost(route: string, body: Record<string, unknown>): Promise<Response> {
  const response = await fetch(`${API_BASE}/api${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  captureSessionCookie(response);
  return response;
}

async function apiPut(route: string, body: Record<string, unknown>): Promise<Response> {
  const response = await fetch(`${API_BASE}/api${route}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  captureSessionCookie(response);
  return response;
}

async function pollUntil<T>(
  getter: () => Promise<T>,
  condition: (value: T) => boolean,
  timeoutMs = 90_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await getter();
    if (condition(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for scan completion`);
}

interface LibraryJobStatus {
  status?: string;
}

interface ScanDiagnostics {
  walkTimeMs: number;
  throughputFilesPerSec: number;
  peakConcurrency: number;
}

interface ScanRecord {
  id: number;
  diagnostics: ScanDiagnostics | null;
  startedAt: string | null;
  finishedAt: string | null;
}

test("completed scan diagnostics survive the scan lifecycle and remain queryable", async () => {
  const statusResponse = await fetch(`${API_BASE}/api/auth/status`);
  assert.equal(statusResponse.status, 200, "Auth status endpoint should be reachable");
  const authStatus = await statusResponse.json() as { setup: boolean };

  const authResponse = authStatus.setup
    ? await apiPost("/auth/setup", { password: TEST_PASSWORD })
    : await apiPost("/auth/login", { password: TEST_PASSWORD });
  assert.ok(authResponse.ok, `Authentication failed with status ${authResponse.status}`);
  // Consume the response before making the first protected request. This
  // allows the session store write triggered by login/setup to finish.
  await authResponse.text();
  assert.ok(sessionCookie, "Authentication should provide a session cookie");

  const originalSettingsResponse = await apiGet("/settings");
  assert.ok(originalSettingsResponse.ok, "Settings should be readable before the test");
  const originalSettings = await originalSettingsResponse.json() as { nasPath?: string | null };
  originalNasPath = originalSettings.nasPath ?? "";
  settingsSnapshotTaken = true;

  try {
    const settingsResponse = await apiPut("/settings", { nasPath: NAS_PATH });
    assert.ok(settingsResponse.ok, `Could not set test NAS path: ${await settingsResponse.text()}`);

    const scanResponse = await apiPost("/library/scan", { profile: "FULL" });
    assert.ok(
      scanResponse.status === 202 || scanResponse.status === 200,
      `Scan trigger returned ${scanResponse.status}: ${await scanResponse.text()}`,
    );

    await pollUntil(async () => {
      const response = await apiGet("/library/jobs/active");
      assert.equal(response.status, 200, "Scan status endpoint should return 200");
      return response.json() as Promise<LibraryJobStatus | null>;
    }, (status) => status?.status !== "RUNNING");

    const diagnosticsResponse = await apiGet("/diagnostics/scans");
    assert.equal(diagnosticsResponse.status, 200, "Diagnostics endpoint should return 200");
    const body = await diagnosticsResponse.json() as { scans: ScanRecord[] };
    assert.ok(Array.isArray(body.scans), "Diagnostics response should contain a scans array");

    const completedScan = body.scans.find((scan) =>
      scan.diagnostics !== null
      && scan.startedAt !== null
      && scan.finishedAt !== null,
    );
    assert.ok(completedScan, "A completed scan with persisted diagnostics should be returned");
    assert.equal(typeof completedScan.diagnostics.walkTimeMs, "number");
    assert.equal(typeof completedScan.diagnostics.throughputFilesPerSec, "number");
    assert.equal(typeof completedScan.diagnostics.peakConcurrency, "number");
    assert.ok(completedScan.diagnostics.walkTimeMs >= 0, "walkTimeMs should be non-negative");
    assert.ok(completedScan.diagnostics.throughputFilesPerSec >= 0, "throughput should be non-negative");
    assert.ok(completedScan.diagnostics.peakConcurrency >= 0, "peakConcurrency should be non-negative");
  } finally {
    if (settingsSnapshotTaken) {
      const restoreResponse = await apiPut("/settings", { nasPath: originalNasPath });
      assert.ok(restoreResponse.ok, `Could not restore NAS path: ${await restoreResponse.text()}`);
    }
  }
});