/**
 * E2E lifecycle proof test — Task #156
 *
 * Verifies the scan engine's structured lifecycle contract end-to-end by
 * reading `diagnostics.checkpoints` from each completed job record. This
 * gives byte-level proof that every required slog event fired in the correct
 * order without relying on parsing free-form log text.
 *
 * Contract verified per scan:
 *   • All 6 required events present: scan_started, db_load_complete,
 *     walker_complete, terminal, scan_summary, scan_finished
 *   • phaseIndex is strictly monotonically increasing (no re-use, no gaps
 *     caused by out-of-order emission)
 *   • scan_started is first; scan_finished is last
 *   • terminal event carries queueDepth/workersRunning/pendingWrites/
 *     activeTimers/activeJobs — all zero at completion
 *   • scan_summary carries a non-empty stages map
 *
 * Additional scenarios:
 *   • Two sequential FULL scans produce identical checkpoint event sets
 *     and identical terminal resource shapes (zero on both)
 *   • Cancelled scan leaves no locks; a subsequent FULL scan reaches DONE
 *   • GET /api/library/jobs/active returns 200 and reflects settled state
 *   • GET /api/optimize/scan returns 200 (optimize pipeline reachable)
 *   • GET /api/faces/people returns 200
 *   • No RUNNING rows in the DB-backed jobs list after all scans settle
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

/** Required slog event names — these must appear in every DONE job's checkpoints */
const REQUIRED_EVENTS = [
  "scan_started",
  "db_load_complete",
  "walker_complete",
  "terminal",
  "scan_summary",
  "scan_finished",
] as const;

type RequiredEvent = typeof REQUIRED_EVENTS[number];

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

async function triggerScan(profile: "FULL" | "QUICK"): Promise<number> {
  const res = await apiPost("/library/scan", { profile, nasPath: NAS_PATH });
  assert.strictEqual(res.status, 200, `POST /library/scan (${profile}) should return 200`);
  const body = (await res.json()) as { jobId: number; alreadyRunning: boolean };
  assert.ok(typeof body.jobId === "number", "Response should include numeric jobId");
  return body.jobId;
}

/** Extract typed checkpoints from a DONE job's diagnostics column */
function extractCheckpoints(job: Job, label: string): Checkpoint[] {
  const diagnostics = job["diagnostics"] as Record<string, unknown> | null | undefined;
  assert.ok(
    diagnostics !== null && diagnostics !== undefined,
    `${label}: diagnostics should not be null`,
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
 * Returns the terminal checkpoint for further caller assertions.
 */
function assertLifecycleContract(checkpoints: Checkpoint[], label: string): Checkpoint {
  // ── 1. All 6 required events are present ─────────────────────────────────
  const eventSet = new Set(checkpoints.map((c) => c.event));
  for (const required of REQUIRED_EVENTS) {
    assert.ok(
      eventSet.has(required),
      `${label}: missing required checkpoint "${required}". Present: [${[...eventSet].join(", ")}]`,
    );
  }

  // ── 2. phaseIndex is strictly monotonically increasing ───────────────────
  for (let i = 1; i < checkpoints.length; i++) {
    assert.ok(
      checkpoints[i]!.phaseIndex > checkpoints[i - 1]!.phaseIndex,
      `${label}: phaseIndex not monotonically increasing at index ${i}: ` +
      `${checkpoints[i - 1]!.phaseIndex} → ${checkpoints[i]!.phaseIndex} ` +
      `(events: ${checkpoints[i - 1]!.event} → ${checkpoints[i]!.event})`,
    );
  }

  // ── 3. scan_started is the first event ───────────────────────────────────
  assert.strictEqual(
    checkpoints[0]!.event,
    "scan_started",
    `${label}: first checkpoint should be scan_started, got "${checkpoints[0]!.event}"`,
  );

  // ── 4. scan_finished is the last event ───────────────────────────────────
  const last = checkpoints[checkpoints.length - 1]!;
  assert.strictEqual(
    last.event,
    "scan_finished",
    `${label}: last checkpoint should be scan_finished, got "${last.event}"`,
  );

  // ── 5. Ordering: db_load_complete after scan_started; walker_complete after db_load ─
  const idxOf = (name: string): number => checkpoints.findIndex((c) => c.event === name);
  const iStart    = idxOf("scan_started");
  const iDbLoad   = idxOf("db_load_complete");
  const iWalker   = idxOf("walker_complete");
  const iTerminal = idxOf("terminal");
  const iSummary  = idxOf("scan_summary");
  const iFinished = idxOf("scan_finished");

  assert.ok(iStart < iDbLoad,   `${label}: scan_started must precede db_load_complete`);
  assert.ok(iDbLoad < iWalker,  `${label}: db_load_complete must precede walker_complete`);
  assert.ok(iWalker < iTerminal,`${label}: walker_complete must precede terminal`);
  assert.ok(iTerminal < iSummary,`${label}: terminal must precede scan_summary`);
  assert.ok(iSummary < iFinished,`${label}: scan_summary must precede scan_finished`);

  // ── 6. terminal resource counts are all zero (clean shutdown) ────────────
  const terminalCp = checkpoints[iTerminal]!;
  const tf = terminalCp.fields;
  for (const key of ["queueDepth", "workersRunning", "pendingWrites", "activeTimers", "activeJobs"] as const) {
    assert.strictEqual(
      tf[key],
      0,
      `${label}: terminal.${key} should be 0 at clean completion, got ${tf[key]}`,
    );
  }

  // ── 7. scan_summary carries a non-empty stages object ────────────────────
  const summaryFields = checkpoints[iSummary]!.fields;
  assert.ok(
    typeof summaryFields["stages"] === "object" && summaryFields["stages"] !== null,
    `${label}: scan_summary.stages should be an object`,
  );
  const stages = summaryFields["stages"] as Record<string, unknown>;
  assert.ok(
    Object.keys(stages).length > 0,
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

  // ── Test 1 & 2: Two sequential FULL scans — lifecycle contract + parity ──
  test("1+2. Sequential FULL scans: lifecycle contract holds on both; terminal resources zero on both", async () => {
    const id1 = await triggerScan("FULL");
    const job1 = await waitForJobDone(id1);
    assert.strictEqual(job1["status"], "DONE", `First FULL scan #${id1} should be DONE`);
    assert.ok(job1["finishedAt"], `First FULL scan #${id1} should have finishedAt`);
    const cp1 = extractCheckpoints(job1, `First FULL #${id1}`);
    const terminal1 = assertLifecycleContract(cp1, `First FULL #${id1}`);

    const id2 = await triggerScan("FULL");
    const job2 = await waitForJobDone(id2);
    assert.strictEqual(job2["status"], "DONE", `Second FULL scan #${id2} should be DONE`);
    assert.ok(job2["finishedAt"], `Second FULL scan #${id2} should have finishedAt`);
    assert.ok(!isNaN(Date.parse(job2["finishedAt"] as string)),
      `Second FULL scan finishedAt "${job2["finishedAt"]}" should be a parseable date`);
    const cp2 = extractCheckpoints(job2, `Second FULL #${id2}`);
    const terminal2 = assertLifecycleContract(cp2, `Second FULL #${id2}`);

    // ── Parity: both scans emit the same event set ────────────────────────
    const events1 = cp1.map((c) => c.event);
    const events2 = cp2.map((c) => c.event);
    assert.deepStrictEqual(
      events1,
      events2,
      `Sequential FULL scan checkpoint event sequences should match.\n` +
      `Scan 1: [${events1.join(", ")}]\nScan 2: [${events2.join(", ")}]`,
    );

    // ── Parity: terminal resource shape is identical (all zero) ──────────
    for (const key of ["queueDepth", "workersRunning", "pendingWrites", "activeTimers", "activeJobs"] as const) {
      assert.strictEqual(
        terminal1.fields[key],
        terminal2.fields[key],
        `Terminal ${key} should be the same across sequential scans (${terminal1.fields[key]} vs ${terminal2.fields[key]})`,
      );
    }

    // ── DB consistency: diagnostics object present on both jobs ──────────
    assert.ok(
      typeof job1["diagnostics"] === "object" && job1["diagnostics"] !== null,
      `First FULL scan should have non-null diagnostics`,
    );
    assert.ok(
      typeof job2["diagnostics"] === "object" && job2["diagnostics"] !== null,
      `Second FULL scan should have non-null diagnostics`,
    );
  });

  // ── Test 3: No RUNNING rows after scans settle ────────────────────────────
  test("3. No RUNNING jobs in DB-backed job list after sequential scans complete", async () => {
    const jobs = await getJobs();
    const running = jobs.filter((j) => j["status"] === "RUNNING");
    assert.strictEqual(running.length, 0,
      `Expected 0 RUNNING jobs, found ${running.length}: ` +
      JSON.stringify(running.map((j) => ({ id: j["id"], status: j["status"] }))));
  });

  // ── Test 4: Active-job endpoint ───────────────────────────────────────────
  test("4. GET /api/library/jobs/active returns 200 with settled state", async () => {
    const res = await apiGet("/library/jobs/active");
    assert.strictEqual(res.status, 200,
      `GET /api/library/jobs/active should return 200, got ${res.status}`);
    const body = (await res.json()) as unknown;
    assert.ok(
      Array.isArray(body) || (typeof body === "object" && body !== null),
      "Active-jobs response should be an array or object",
    );
  });

  // ── Test 5: Cancel + subsequent scan — no lock leak ──────────────────────
  test("5. After cancel attempt, subsequent FULL scan reaches DONE with full lifecycle", async () => {
    const cancelId = await triggerScan("FULL");
    void fetch(`${API_BASE}/api/library/jobs/${cancelId}/cancel`, {
      method: "POST",
      headers: authHeaders(),
    });
    await waitForJobDone(cancelId);
    await waitForNoRunning();

    const freshId = await triggerScan("FULL");
    const freshJob = await waitForJobDone(freshId);
    assert.strictEqual(freshJob["status"], "DONE",
      `Post-cancel FULL scan #${freshId} should be DONE`);
    const cp = extractCheckpoints(freshJob, `Post-cancel FULL #${freshId}`);
    assertLifecycleContract(cp, `Post-cancel FULL #${freshId}`);
  });

  // ── Test 6: QUICK scan — fast-path emits all 6 events ───────────────────
  test("6. QUICK (fast-path) scan emits all 6 lifecycle events with correct ordering", async () => {
    const jobId = await triggerScan("QUICK");
    const job = await waitForJobDone(jobId);
    assert.strictEqual(job["status"], "DONE",
      `QUICK scan #${jobId} should be DONE, got: ${job["status"]}`);
    const cp = extractCheckpoints(job, `QUICK #${jobId}`);
    assertLifecycleContract(cp, `QUICK #${jobId}`);

    // Fast-path specific: db_load_complete and walker_complete should be skipped
    const dbLoadCp = cp.find((c) => c.event === "db_load_complete");
    const walkerCp  = cp.find((c) => c.event === "walker_complete");
    if (dbLoadCp && walkerCp) {
      // Fast-path (dir-cache hit): skipped=true on both
      if (dbLoadCp.fields["skipped"] === true) {
        assert.strictEqual(walkerCp.fields["skipped"], true,
          "Fast-path: if db_load_complete is skipped, walker_complete should also be skipped");
      }
    }
  });

  // ── Test 7: Optimize pipeline reachable ───────────────────────────────────
  test("7. GET /api/optimize/scan returns 200 after scans complete", async () => {
    const res = await apiGet("/optimize/scan");
    assert.strictEqual(res.status, 200,
      `GET /api/optimize/scan should return 200, got ${res.status}`);
    const body = (await res.json()) as unknown;
    assert.ok(typeof body === "object" && body !== null,
      "Optimize-scan response should be an object");
  });

  // ── Test 8: People endpoint ───────────────────────────────────────────────
  test("8. GET /api/faces/people returns HTTP 200", async () => {
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
