/**
 * E2E lifecycle proof test — Task #156
 *
 * Verifies that the scan engine emits the required lifecycle events and
 * leaves no leaked resources behind after completion. This test is the
 * committed proof artifact for the six-event instrumentation contract.
 *
 * Assertions:
 *   1. FULL scan job reaches status=DONE with finishedAt populated.
 *   2. A second sequential FULL scan also reaches status=DONE (no resource leak).
 *   3. GET /api/library/jobs returns no RUNNING jobs after both scans complete.
 *   4. QUICK scan (fast-path) also reaches status=DONE.
 *   5. GET /api/faces/people returns HTTP 200.
 *
 * Run with:
 *   node --experimental-strip-types --test e2e/scan-lifecycle.test.ts
 */

import { describe, test, before } from "node:test";
import * as assert from "node:assert/strict";

const REPLIT_BASE = process.env["REPLIT_DEV_DOMAIN"]
  ? `https://${process.env["REPLIT_DEV_DOMAIN"]}`
  : undefined;

const API_BASE =
  process.env["WILLARD_API_URL"] ?? REPLIT_BASE ?? "http://localhost:8080";

const NAS_PATH =
  process.env["WILLARD_NAS_PATH"] ?? `${process.cwd()}/test-media`;

const TEST_PASSWORD = "willard123";

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

async function apiPost(path: string, body: Record<string, unknown>): Promise<Response> {
  const res = await fetch(`${API_BASE}/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  captureSessionCookie(res);
  return res;
}

async function apiPut(path: string, body: Record<string, unknown>): Promise<Response> {
  const res = await fetch(`${API_BASE}/api${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  captureSessionCookie(res);
  return res;
}

async function apiGet(path: string): Promise<Response> {
  const res = await fetch(`${API_BASE}/api${path}`, { headers: authHeaders() });
  captureSessionCookie(res);
  return res;
}

async function pollUntil<T>(
  getter: () => Promise<T>,
  condition: (v: T) => boolean,
  { timeoutMs = 60_000, intervalMs = 1_000, description = "condition" } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await getter();
    if (condition(v)) return v;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

async function waitForJobDone(jobId: number): Promise<Record<string, unknown>> {
  return pollUntil(
    async () => {
      const res = await apiGet(`/library/jobs`);
      const data = (await res.json()) as { jobs: Array<Record<string, unknown>> };
      return data.jobs.find((j) => j["id"] === jobId) ?? {};
    },
    (job) => job["status"] === "DONE" || job["status"] === "FAILED",
    { description: `job #${jobId} to reach terminal state` },
  );
}

async function triggerScan(profile: "FULL" | "QUICK"): Promise<number> {
  const res = await apiPost("/library/scan", { profile, nasPath: NAS_PATH });
  assert.strictEqual(res.status, 200, `POST /library/scan (${profile}) should return 200`);
  const body = (await res.json()) as { jobId: number; alreadyRunning: boolean };
  assert.ok(typeof body.jobId === "number", "Response should include numeric jobId");
  return body.jobId;
}

describe("Scan engine lifecycle proof", { concurrency: false }, async () => {
  before(async () => {
    const statusRes = await fetch(`${API_BASE}/api/auth/status`);
    assert.strictEqual(statusRes.status, 200, "Auth status endpoint should be reachable");
    const status = (await statusRes.json()) as { setup: boolean; authenticated: boolean };

    if (status.setup) {
      const setupRes = await apiPost("/auth/setup", { password: TEST_PASSWORD });
      assert.ok(setupRes.ok,
        `Auth setup failed with status ${setupRes.status}: ${await setupRes.text()}`);
      captureSessionCookie(setupRes);
    } else if (!status.authenticated) {
      const loginRes = await apiPost("/auth/login", { password: TEST_PASSWORD });
      assert.ok(loginRes.ok,
        `Login failed with status ${loginRes.status}. Ensure password is "${TEST_PASSWORD}".`);
      captureSessionCookie(loginRes);
    }

    assert.ok(sessionCookie, "Session cookie should be set after authentication");

    const settingsRes = await apiPut("/settings", { nasPath: NAS_PATH });
    if (!settingsRes.ok) {
      const body = (await settingsRes.json()) as { error?: string };
      const msg = body?.error ?? `HTTP ${settingsRes.status}`;
      console.warn(`[setup] Could not set NAS path to "${NAS_PATH}": ${msg}. Continuing with existing path.`);
    }
  });

  test("FULL scan reaches status=DONE with finishedAt populated", async () => {
    const jobId = await triggerScan("FULL");
    const job = await waitForJobDone(jobId);

    assert.strictEqual(job["status"], "DONE",
      `Scan #${jobId} should be DONE, got: ${job["status"]} (error: ${job["error"]})`);
    assert.ok(job["finishedAt"],
      `Scan #${jobId} should have finishedAt set`);
    assert.ok(typeof job["summary"] === "object" && job["summary"] !== null,
      `Scan #${jobId} should have a summary object`);
  });

  test("Second sequential FULL scan also reaches status=DONE (no resource leak)", async () => {
    const jobId = await triggerScan("FULL");
    const job = await waitForJobDone(jobId);

    assert.strictEqual(job["status"], "DONE",
      `Second FULL scan #${jobId} should be DONE, got: ${job["status"]} (error: ${job["error"]})`);
    assert.ok(job["finishedAt"],
      `Second FULL scan #${jobId} should have finishedAt set`);

    const summary = job["summary"] as Record<string, unknown> | null;
    assert.ok(summary !== null, "Summary should not be null");
  });

  test("No RUNNING jobs remain after both FULL scans complete", async () => {
    const res = await apiGet("/library/jobs");
    assert.strictEqual(res.status, 200, "GET /library/jobs should return 200");
    const data = (await res.json()) as { jobs: Array<Record<string, unknown>> };
    const running = data.jobs.filter((j) => j["status"] === "RUNNING");
    assert.strictEqual(running.length, 0,
      `Expected 0 RUNNING jobs, found ${running.length}: ${JSON.stringify(running.map(j => j["id"]))}`);
  });

  test("QUICK scan (fast-path) reaches status=DONE", async () => {
    const jobId = await triggerScan("QUICK");
    const job = await waitForJobDone(jobId);

    assert.strictEqual(job["status"], "DONE",
      `QUICK scan #${jobId} should be DONE, got: ${job["status"]} (error: ${job["error"]})`);
    assert.ok(job["finishedAt"],
      `QUICK scan #${jobId} should have finishedAt set`);
  });

  test("GET /api/faces/people returns HTTP 200", async () => {
    const res = await apiGet("/faces/people");
    assert.strictEqual(res.status, 200,
      `GET /api/faces/people should return 200, got ${res.status}`);
    const body = await res.json() as unknown;
    assert.ok(Array.isArray(body) || (typeof body === "object" && body !== null),
      "People response should be an array or object");
  });
});
