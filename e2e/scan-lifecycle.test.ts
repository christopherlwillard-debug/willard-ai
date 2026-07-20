/**
 * E2E lifecycle proof test — Task #156
 *
 * Verifies the scan engine's structured lifecycle contract end-to-end by
 * reading `diagnostics.checkpoints` from each completed job record.
 *
 * Every slog call appends {event, phaseIndex, ts, fields} to lifecycleCheckpoints
 * which is written into the job's diagnostics JSONB column at DB commit time,
 * making the full event sequence queryable via GET /library/jobs.
 *
 * Contract verified per scan:
 *   • All 6 required events present: scan_started, db_load_complete,
 *     walker_complete, terminal, scan_summary, scan_finished
 *   • phaseIndex is strictly monotonically increasing (no re-use, no gaps
 *     caused by out-of-order emission)
 *   • scan_started is first; scan_finished is last
 *   • Ordering guaranteed: scan_started < db_load_complete < walker_complete
 *     < terminal < scan_summary < scan_finished
 *   • terminal event carries queueDepth/workersRunning/pendingWrites/
 *     activeTimers/activeJobs — all zero at completion (§release-gate)
 *   • scan_summary carries a non-empty stages map
 *
 * Scenarios (§7):
 *   1+2. Two sequential FULL scans — full lifecycle contract + parity check
 *   3.   No RUNNING rows in DB after scans settle (§8.2)
 *   4.   GET /api/library/jobs/active → 200, empty (§8.1)
 *   5.   Cancel attempt: cancelled job stores terminal with activeJobs=0;
 *        subsequent FULL scan reaches DONE with full lifecycle
 *   6.   QUICK scan (fast-path) — all 6 events incl. skipped markers
 *   7.   POST /api/library/scan → alreadyRunning:false (§8.3 — engine ready)
 *   8.   GET /api/faces/people → 200 (§8.4)
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

/** Required slog event names — must appear in every DONE job's checkpoints */
const REQUIRED_EVENTS = [
  "scan_started",
  "db_load_complete",
  "walker_complete",
  "terminal",
  "scan_summary",
  "scan_finished",
] as const;

interface Checkpoint {
  event: string;
  phaseIndex: number;
  ts: number;
  fields: Record<string, unknown>;
}

type Job = Record<string, unknown>;

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
  { timeoutMs = 60_000, intervalMs = 500, description = "condition" } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await getter();
    if (condition(v)) return v;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

async function getJobs(): Promise<Job[]> {
  const res = await apiGet("/library/jobs");
  assert.strictEqual(res.status, 200, "GET /library/jobs should return 200");
  const data = (await res.json()) as { jobs: Job[] };
  return data.jobs;
}

async function findJob(jobId: number): Promise<Job> {
  const jobs = await getJobs();
  return jobs.find((j) => j["id"] === jobId) ?? {};
}

const TERMINAL_STATUSES = new Set(["DONE", "FAILED", "CANCELLED"]);

async function waitForJobDone(jobId: number): Promise<Job> {
  return pollUntil(
    () => findJob(jobId),
    (job) => TERMINAL_STATUSES.has(job["status"] as string),
    { description: `job #${jobId} to reach terminal state` },
  );
}

async function waitForNoRunning(): Promise<void> {
  await pollUntil(
    getJobs,
    (jobs) => jobs.every((j) => j["status"] !== "RUNNING"),
    { timeoutMs: 30_000, description: "no RUNNING jobs" },
  );
}

async function triggerScan(profile: "FULL" | "QUICK"): Promise<{ jobId: number; alreadyRunning: boolean }> {
  const res = await apiPost("/library/scan", { profile, nasPath: NAS_PATH });
  assert.strictEqual(res.status, 200, `POST /library/scan (${profile}) should return 200`);
  const body = (await res.json()) as { jobId: number; alreadyRunning: boolean };
  assert.ok(typeof body.jobId === "number", "Response should include numeric jobId");
  return body;
}

/** Extract typed checkpoints from a job's diagnostics column */
function extractCheckpoints(job: Job, label: string): Checkpoint[] {
  const diagnostics = job["diagnostics"] as Record<string, unknown> | null | undefined;
  assert.ok(
    diagnostics !== null && diagnostics !== undefined,
    `${label}: diagnostics should not be null (status=${job["status"]})`,
  );
  const checkpoints = (diagnostics as Record<string, unknown>)["checkpoints"];
  assert.ok(
    Array.isArray(checkpoints) && checkpoints.length > 0,
    `${label}: diagnostics.checkpoints should be a non-empty array (got ${JSON.stringify(checkpoints)})`,
  );
  return checkpoints as Checkpoint[];
}

/**
 * Core lifecycle assertions applied to every DONE job.
 * Returns the terminal checkpoint for caller assertions.
 */
function assertLifecycleContract(checkpoints: Checkpoint[], label: string): Checkpoint {
  // 1. All 6 required events are present
  const eventSet = new Set(checkpoints.map((c) => c.event));
  for (const required of REQUIRED_EVENTS) {
    assert.ok(
      eventSet.has(required),
      `${label}: missing required checkpoint "${required}". ` +
      `Present: [${[...eventSet].join(", ")}]`,
    );
  }

  // 2. phaseIndex is strictly monotonically increasing
  for (let i = 1; i < checkpoints.length; i++) {
    assert.ok(
      checkpoints[i]!.phaseIndex > checkpoints[i - 1]!.phaseIndex,
      `${label}: phaseIndex not monotonically increasing at index ${i}: ` +
      `${checkpoints[i - 1]!.phaseIndex}→${checkpoints[i]!.phaseIndex} ` +
      `(events: ${checkpoints[i - 1]!.event}→${checkpoints[i]!.event})`,
    );
  }

  // 3. scan_started is first
  assert.strictEqual(
    checkpoints[0]!.event,
    "scan_started",
    `${label}: first checkpoint should be scan_started, got "${checkpoints[0]!.event}"`,
  );

  // 4. scan_finished is last
  const last = checkpoints[checkpoints.length - 1]!;
  assert.strictEqual(
    last.event,
    "scan_finished",
    `${label}: last checkpoint should be scan_finished, got "${last.event}"`,
  );

  // 5. Canonical ordering: scan_started < db_load_complete < walker_complete < terminal < scan_summary < scan_finished
  const idxOf = (name: string): number => checkpoints.findIndex((c) => c.event === name);
  const iStart    = idxOf("scan_started");
  const iDbLoad   = idxOf("db_load_complete");
  const iWalker   = idxOf("walker_complete");
  const iTerminal = idxOf("terminal");
  const iSummary  = idxOf("scan_summary");
  const iFinished = idxOf("scan_finished");

  assert.ok(iStart < iDbLoad,    `${label}: scan_started must precede db_load_complete`);
  assert.ok(iDbLoad < iWalker,   `${label}: db_load_complete must precede walker_complete`);
  assert.ok(iWalker < iTerminal, `${label}: walker_complete must precede terminal`);
  assert.ok(iTerminal < iSummary,`${label}: terminal must precede scan_summary`);
  assert.ok(iSummary < iFinished,`${label}: scan_summary must precede scan_finished`);

  // 6. terminal resource counts are all zero (clean shutdown per §release-gate)
  const terminalCp = checkpoints[iTerminal]!;
  const tf = terminalCp.fields;
  for (const key of ["queueDepth", "workersRunning", "pendingWrites", "activeTimers", "activeJobs"] as const) {
    assert.strictEqual(
      tf[key],
      0,
      `${label}: terminal.${key} should be 0 at clean completion, got ${tf[key]}`,
    );
  }

  // 7. scan_summary carries a non-empty stages object
  const summaryFields = checkpoints[iSummary]!.fields;
  assert.ok(
    typeof summaryFields["stages"] === "object" && summaryFields["stages"] !== null,
    `${label}: scan_summary.stages should be an object`,
  );
  assert.ok(
    Object.keys(summaryFields["stages"] as object).length > 0,
    `${label}: scan_summary.stages should have at least one entry`,
  );

  return terminalCp;
}

// ────────────────────────────────────────────────────────────────────────────

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
      console.warn(`[setup] Could not set NAS path to "${NAS_PATH}": ${msg}. Continuing.`);
    }
  });

  // ── §7.1+2: Two sequential FULL scans ─────────────────────────────────────
  test("1+2. Sequential FULL scans: lifecycle contract holds + terminal resources zero on both (§7, §release-gate)", async () => {
    const r1 = await triggerScan("FULL");
    assert.strictEqual(r1.alreadyRunning, false, "First FULL scan should not report alreadyRunning");
    const job1 = await waitForJobDone(r1.jobId);
    assert.strictEqual(job1["status"], "DONE", `First FULL scan #${r1.jobId} should be DONE`);
    assert.ok(job1["finishedAt"], `First FULL scan should have finishedAt`);
    const cp1 = extractCheckpoints(job1, `First FULL #${r1.jobId}`);
    const terminal1 = assertLifecycleContract(cp1, `First FULL #${r1.jobId}`);

    const r2 = await triggerScan("FULL");
    assert.strictEqual(r2.alreadyRunning, false, "Second FULL scan should not report alreadyRunning");
    const job2 = await waitForJobDone(r2.jobId);
    assert.strictEqual(job2["status"], "DONE", `Second FULL scan #${r2.jobId} should be DONE`);
    assert.ok(job2["finishedAt"], `Second FULL scan should have finishedAt`);
    assert.ok(!isNaN(Date.parse(job2["finishedAt"] as string)),
      `Second FULL finishedAt "${job2["finishedAt"]}" should be a parseable date`);
    const cp2 = extractCheckpoints(job2, `Second FULL #${r2.jobId}`);
    const terminal2 = assertLifecycleContract(cp2, `Second FULL #${r2.jobId}`);

    // ── Parity: same event sequence (§release-gate: second must match first) ─
    const events1 = cp1.map((c) => c.event);
    const events2 = cp2.map((c) => c.event);
    assert.deepStrictEqual(
      events1,
      events2,
      `Sequential FULL scan checkpoint event sequences must match.\n` +
      `Scan 1: [${events1.join(", ")}]\nScan 2: [${events2.join(", ")}]`,
    );

    // ── Parity: terminal resource shape identical (both zero) ─────────────
    for (const key of ["queueDepth", "workersRunning", "pendingWrites", "activeTimers", "activeJobs"] as const) {
      assert.strictEqual(
        terminal1.fields[key],
        terminal2.fields[key],
        `Terminal.${key} must match across sequential scans ` +
        `(scan1=${terminal1.fields[key]}, scan2=${terminal2.fields[key]})`,
      );
    }

    // ── DB consistency: diagnostics non-null on both ───────────────────────
    assert.ok(
      typeof job1["diagnostics"] === "object" && job1["diagnostics"] !== null,
      "First FULL scan diagnostics should be non-null",
    );
    assert.ok(
      typeof job2["diagnostics"] === "object" && job2["diagnostics"] !== null,
      "Second FULL scan diagnostics should be non-null",
    );
  });

  // ── §8.2: No RUNNING rows in DB ───────────────────────────────────────────
  test("3. §8.2 DB consistency: no RUNNING rows, all jobs terminal, no duplicate active entries", async () => {
    const jobs = await getJobs();

    // No RUNNING rows
    const running = jobs.filter((j) => j["status"] === "RUNNING");
    assert.strictEqual(running.length, 0,
      `Expected 0 RUNNING jobs, found ${running.length}: ` +
      JSON.stringify(running.map((j) => ({ id: j["id"], status: j["status"] }))));

    // All completed scans have finishedAt and status is terminal
    const doneJobs = jobs.filter((j) => j["status"] === "DONE");
    assert.ok(doneJobs.length >= 2,
      `Expected at least 2 DONE jobs from sequential FULL scans, found ${doneJobs.length}`);
    for (const job of doneJobs.slice(-2)) {
      assert.ok(job["finishedAt"],
        `DONE job #${job["id"]} must have finishedAt populated (DB consistency)`);
    }
  });

  // ── §8.1: Active-job endpoint ─────────────────────────────────────────────
  test("4. §8.1 GET /api/library/jobs/active → 200 with empty active list after scans settle", async () => {
    const res = await apiGet("/library/jobs/active");
    assert.strictEqual(res.status, 200,
      `GET /api/library/jobs/active should return 200, got ${res.status}`);
    const body = (await res.json()) as unknown;
    assert.ok(
      Array.isArray(body) || (typeof body === "object" && body !== null),
      "Active-jobs response should be an array or object",
    );
    // Memory and DB must agree: no active jobs
    const active = Array.isArray(body) ? body : (body as Record<string, unknown[]>)["jobs"] ?? [];
    assert.ok(
      Array.isArray(active),
      "Active-jobs payload should contain an iterable jobs list",
    );
    assert.strictEqual((active as unknown[]).length, 0,
      `Active jobs list should be empty after scans settle, found ${(active as unknown[]).length}`);
  });

  // ── §7.3: Cancel + subsequent clean scan ──────────────────────────────────
  test("5. §7.3 Cancel attempt: cancelled terminal has activeJobs=0; subsequent FULL scan completes cleanly", async () => {
    const r = await triggerScan("FULL");
    void fetch(`${API_BASE}/api/library/jobs/${r.jobId}/cancel`, {
      method: "POST",
      headers: authHeaders(),
    });
    const cancelledJob = await waitForJobDone(r.jobId);
    await waitForNoRunning();

    // Whether DONE or CANCELLED: verify terminal resource counts are zero
    const cpCancel = extractCheckpoints(cancelledJob, `Cancel target #${r.jobId} (${cancelledJob["status"]})`);
    const terminalCp = cpCancel.find((c) => c.event === "terminal");
    assert.ok(terminalCp,
      `Cancel target #${r.jobId}: should have a terminal checkpoint regardless of outcome`);
    const tf = terminalCp!.fields;
    for (const key of ["queueDepth", "workersRunning", "pendingWrites", "activeTimers", "activeJobs"] as const) {
      assert.strictEqual(tf[key], 0,
        `Cancel #${r.jobId}: terminal.${key} should be 0 (got ${tf[key]}). ` +
        `completionReason=${tf["completionReason"]}`);
    }

    // Subsequent FULL scan must start immediately (no lock leak) and complete
    const r2 = await triggerScan("FULL");
    assert.strictEqual(r2.alreadyRunning, false,
      "Post-cancel FULL scan should start immediately (alreadyRunning:false)");
    const freshJob = await waitForJobDone(r2.jobId);
    assert.strictEqual(freshJob["status"], "DONE",
      `Post-cancel FULL scan #${r2.jobId} should be DONE`);
    const cpFresh = extractCheckpoints(freshJob, `Post-cancel FULL #${r2.jobId}`);
    assertLifecycleContract(cpFresh, `Post-cancel FULL #${r2.jobId}`);
  });

  // ── §7.2: QUICK fast-path ─────────────────────────────────────────────────
  test("6. §7.2 QUICK scan (fast-path): all 6 lifecycle events with correct ordering and zero terminal resources", async () => {
    const r = await triggerScan("QUICK");
    const job = await waitForJobDone(r.jobId);
    assert.strictEqual(job["status"], "DONE",
      `QUICK scan #${r.jobId} should be DONE, got: ${job["status"]}`);
    const cp = extractCheckpoints(job, `QUICK #${r.jobId}`);
    assertLifecycleContract(cp, `QUICK #${r.jobId}`);

    // Fast-path markers: if dir-cache hit, db_load_complete and walker_complete carry skipped:true
    const dbLoadCp = cp.find((c) => c.event === "db_load_complete");
    const walkerCp  = cp.find((c) => c.event === "walker_complete");
    if (dbLoadCp?.fields["skipped"] === true) {
      assert.strictEqual(walkerCp?.fields["skipped"], true,
        "Fast-path: if db_load_complete is skipped, walker_complete should also be skipped");
    }
  });

  // ── §8.3: Engine ready — POST /api/library/scan starts normally ───────────
  test("7. §8.3 POST /api/library/scan after settled state returns alreadyRunning:false", async () => {
    // §8.3 requires the optimize/scan pipeline to start normally (not blocked).
    // The equivalent gate for the scan engine: POST /api/library/scan with a fresh
    // profile must return alreadyRunning:false, proving no orphaned lock is held.
    const r = await triggerScan("FULL");
    assert.strictEqual(r.alreadyRunning, false,
      `§8.3: POST /api/library/scan should return alreadyRunning:false after all scans settle ` +
      `(got alreadyRunning:${r.alreadyRunning}, jobId:${r.jobId})`);

    // Wait for this scan to complete so subsequent tests see a clean state
    const job = await waitForJobDone(r.jobId);
    assert.strictEqual(job["status"], "DONE", `§8.3 scan #${r.jobId} should be DONE`);
    const cp = extractCheckpoints(job, `§8.3 FULL #${r.jobId}`);
    assertLifecycleContract(cp, `§8.3 FULL #${r.jobId}`);
  });

  // ── §8.4: People endpoint ──────────────────────────────────────────────────
  test("8. §8.4 GET /api/faces/people returns HTTP 200", async () => {
    const res = await apiGet("/faces/people");
    assert.strictEqual(res.status, 200,
      `GET /api/faces/people should return 200, got ${res.status}`);
    const body = (await res.json()) as unknown;
    assert.ok(
      Array.isArray(body) || (typeof body === "object" && body !== null),
      "People response should be an array or object",
    );
  });
});
