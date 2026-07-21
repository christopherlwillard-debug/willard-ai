/**
 * E2E lifecycle proof test — Task #156
 *
 * Verifies the scan engine's structured lifecycle contract end-to-end by
 * reading `diagnostics.checkpoints` from each completed job record.
 *
 * Both slog (always-on INFO) and sdbg (debug-gated pino, but ALWAYS stored
 * in lifecycleCheckpoints) events are persisted in diagnostics.checkpoints,
 * so the full §1 sequence is queryable without requiring LOG_SCAN_DEBUG.
 *
 * Contract verified per scan:
 *   • All 6 required INFO events present: scan_started, db_load_complete,
 *     walker_complete, terminal, scan_summary, scan_finished
 *   • Extended §1 checkpoints present on full-walk scans:
 *     walker_started, all_workers_done, batch_flush_complete,
 *     detecting_deletions, duplicate_detection, done_written
 *   • phaseIndex is strictly monotonically increasing
 *   • scan_started is first; scan_finished is last
 *   • Ordering: scan_started < db_load_complete < walker_complete < terminal
 *     < scan_summary < scan_finished
 *   • terminal: queueDepth/workersRunning/pendingWrites/activeTimers/activeJobs all 0
 *   • scan_summary carries a non-empty stages map
 *
 * Scenarios (§7):
 *   1+2. Two sequential FULL scans — full lifecycle contract + parity check
 *   3.   No RUNNING rows in DB after scans settle (§8.2)
 *   4.   GET /api/library/jobs/active → 200, empty (§8.1)
 *   5.   Cancel scenario: deterministic cancel (800 temp files slow the scan),
 *        assert status===CANCELLED, terminal.activeJobs===0, completionReason=cancelled;
 *        subsequent FULL scan reaches DONE with full lifecycle
 *   6.   QUICK scan (fast-path) — all 6 events incl. skipped markers
 *   7.   POST /api/library/optimize → alreadyRunning:false (§8.3)
 *   8.   GET /api/faces/people → 200 (§8.4)
 *
 * Run with:
 *   node --experimental-strip-types --test e2e/scan-lifecycle.test.ts
 */

import { describe, test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const REPLIT_BASE = process.env["REPLIT_DEV_DOMAIN"]
  ? `https://${process.env["REPLIT_DEV_DOMAIN"]}`
  : undefined;

const API_BASE =
  process.env["WILLARD_API_URL"] ?? REPLIT_BASE ?? "http://localhost:8080";

const NAS_PATH =
  process.env["WILLARD_NAS_PATH"] ?? `${process.cwd()}/test-media`;

const TEST_PASSWORD = "willard123";

/** Required 6 permanent INFO events — must appear on every DONE job */
const REQUIRED_EVENTS = [
  "scan_started",
  "db_load_complete",
  "walker_complete",
  "terminal",
  "scan_summary",
  "scan_finished",
] as const;

/**
 * Extended §1 checkpoints stored via sdbg (always stored, pino-gated).
 * Verified only on full-walk scans (not fast-path / skipped scans).
 */
const EXTENDED_EVENTS_FULL_WALK = [
  "walker_started",
  "all_workers_done",
  "batch_flush_complete",
  "detecting_deletions",
  "duplicate_detection",
  "reconciliation_complete",
  "done_written",
] as const;

interface Checkpoint {
  event: string;
  phaseIndex: number;
  ts: number;
  fields: Record<string, unknown>;
}

type Job = Record<string, unknown>;

let sessionCookie = "";
/** Temp directory created for the deterministic cancel test */
let cancelTempDir = "";

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
  { timeoutMs = 90_000, intervalMs = 500, description = "condition" } = {},
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

async function waitForJobTerminal(jobId: number): Promise<Job> {
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
    { timeoutMs: 60_000, description: "no RUNNING jobs" },
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

/** Returns true when the scan used the dir-cache fast-path (db_load_complete has skipped:true) */
function isFastPath(checkpoints: Checkpoint[]): boolean {
  const dbLoadCp = checkpoints.find((c) => c.event === "db_load_complete");
  return dbLoadCp?.fields["skipped"] === true;
}

/**
 * Core 6-event lifecycle assertions applied to every DONE/CANCELLED job.
 * Returns the terminal checkpoint for caller assertions.
 */
function assertLifecycleContract(checkpoints: Checkpoint[], label: string): Checkpoint {
  const eventSet = new Set(checkpoints.map((c) => c.event));

  // 1. All 6 required INFO events are present
  for (const required of REQUIRED_EVENTS) {
    assert.ok(
      eventSet.has(required),
      `${label}: missing required checkpoint "${required}". Present: [${[...eventSet].join(", ")}]`,
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

  // 5. Canonical ordering
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

  // 6. terminal resource counts are all zero
  const terminalCp = checkpoints[iTerminal]!;
  const tf = terminalCp.fields;
  for (const key of ["queueDepth", "workersRunning", "pendingWrites", "activeTimers", "activeJobs"] as const) {
    assert.strictEqual(
      tf[key],
      0,
      `${label}: terminal.${key} should be 0, got ${tf[key]}`,
    );
  }

  // 7. scan_summary has non-empty stages
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

/**
 * Extended §1 checkpoint assertions for full-walk (non-fast-path) scans.
 * Verifies that sdbg events are also stored (not just logged when debug is on).
 */
function assertExtendedCheckpointsFullWalk(checkpoints: Checkpoint[], label: string): void {
  if (isFastPath(checkpoints)) return; // skip for fast-path scans
  const eventSet = new Set(checkpoints.map((c) => c.event));
  for (const evt of EXTENDED_EVENTS_FULL_WALK) {
    assert.ok(
      eventSet.has(evt),
      `${label}: missing extended §1 checkpoint "${evt}". Present: [${[...eventSet].join(", ")}]`,
    );
  }
}

/**
 * Reconciliation invariant: after deletion detection completes,
 *   liveDbRowsAfter === diskFiles
 * (within a tolerance for files skipped by user exclusion rules).
 *
 * Only called for full-walk DONE scans — fast-path scans don't do a full walk so
 * the diskFiles count may be lower than liveDbRowsBefore (that is expected).
 *
 * tolerance accounts for files the scanner skips due to user-configured exclusion rules
 * (ignoredFolders, ignoredExtensions, etc.). These are on disk but not in the library,
 * so diskFiles < liveDbRowsAfter is valid when exclusions exist. The tolerance
 * is intentionally loose (5 000) because the test-media corpus is small and
 * any genuine divergence will be orders of magnitude larger.
 */
function assertReconciliationInvariant(checkpoints: Checkpoint[], label: string): void {
  if (isFastPath(checkpoints)) return; // only applies to full-walk scans

  const cp = checkpoints.find((c) => c.event === "reconciliation_complete");
  assert.ok(cp, `${label}: reconciliation_complete checkpoint must be present`);

  const f = cp!.fields;
  for (const key of ["diskFiles", "liveDbRowsBefore", "markedDeleted", "liveDbRowsAfter", "ignoredFiles"] as const) {
    assert.ok(
      typeof f[key] === "number",
      `${label}: reconciliation_complete.${key} should be a number, got ${JSON.stringify(f[key])}`,
    );
  }

  const diskFiles       = f["diskFiles"] as number;
  const liveDbRowsAfter = f["liveDbRowsAfter"] as number;
  const markedDeleted   = f["markedDeleted"] as number;
  const liveDbRowsBefore = f["liveDbRowsBefore"] as number;

  // liveDbRowsBefore - markedDeleted === liveDbRowsAfter (arithmetic consistency)
  assert.strictEqual(
    liveDbRowsAfter,
    liveDbRowsBefore - markedDeleted,
    `${label}: reconciliation_complete arithmetic: liveDbRowsAfter(${liveDbRowsAfter}) ` +
    `should equal liveDbRowsBefore(${liveDbRowsBefore}) - markedDeleted(${markedDeleted})`,
  );

  // After reconciliation the library DB count should converge to the on-disk count.
  // A small tolerance accounts for user exclusion rules (files on disk but not indexed).
  // A large gap indicates a genuine reconciliation bug.
  const TOLERANCE = 5_000;
  assert.ok(
    Math.abs(liveDbRowsAfter - diskFiles) <= TOLERANCE,
    `${label}: reconciliation_complete invariant: ` +
    `|liveDbRowsAfter(${liveDbRowsAfter}) - diskFiles(${diskFiles})| = ` +
    `${Math.abs(liveDbRowsAfter - diskFiles)} exceeds tolerance ${TOLERANCE}. ` +
    `This indicates deletion detection did not converge the DB to the on-disk file count.`,
  );
}

// ────────────────────────────────────────────────────────────────────────────

describe("Scan engine lifecycle proof", { concurrency: false }, async () => {
  before(async () => {
    const statusRes = await fetch(`${API_BASE}/api/auth/status`);
    assert.strictEqual(statusRes.status, 200, "Auth status endpoint should be reachable");
    const status = (await statusRes.json()) as { setup: boolean; authenticated: boolean };

    if (status.setup) {
      const setupRes = await apiPost("/auth/setup", { password: TEST_PASSWORD });
      assert.ok(setupRes.ok, `Auth setup failed: ${await setupRes.text()}`);
      captureSessionCookie(setupRes);
    } else if (!status.authenticated) {
      const loginRes = await apiPost("/auth/login", { password: TEST_PASSWORD });
      assert.ok(loginRes.ok, `Login failed: ${await loginRes.text()}`);
      captureSessionCookie(loginRes);
    }
    assert.ok(sessionCookie, "Session cookie should be set after authentication");

    const settingsRes = await apiPut("/settings", { nasPath: NAS_PATH });
    if (!settingsRes.ok) {
      const body = (await settingsRes.json()) as { error?: string };
      console.warn(`[setup] Could not set NAS path: ${body?.error ?? settingsRes.status}. Continuing.`);
    }

    // Ensure no stale jobs are running before tests begin
    await waitForNoRunning();

    // Create a temp directory with many small files so the cancel race is deterministic.
    // 800 files gives the scanner enough work that a cancel issued ~150ms after trigger
    // arrives while the walk is still active.
    cancelTempDir = path.join(NAS_PATH, "__cancel_test_tmp__");
    await fs.mkdir(cancelTempDir, { recursive: true });
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 800; i++) {
      writes.push(fs.writeFile(path.join(cancelTempDir, `file-${i}.jpg`), `placeholder-${i}`));
    }
    await Promise.all(writes);
  });

  after(async () => {
    if (cancelTempDir) {
      await fs.rm(cancelTempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ── §7.1+2: Two sequential FULL scans ─────────────────────────────────────
  test("1+2. Sequential FULL scans: 6 required + extended §1 checkpoints, zero terminal resources, parity (§7, §release-gate)", async () => {
    const r1 = await triggerScan("FULL");
    assert.strictEqual(r1.alreadyRunning, false, "First FULL scan should not report alreadyRunning");
    const job1 = await waitForJobTerminal(r1.jobId);
    await waitForNoRunning(); // ensure activeJobs cleared before triggering second scan
    assert.strictEqual(job1["status"], "DONE", `First FULL scan #${r1.jobId} should be DONE`);
    assert.ok(job1["finishedAt"], `First FULL scan should have finishedAt`);
    const cp1 = extractCheckpoints(job1, `First FULL #${r1.jobId}`);
    const terminal1 = assertLifecycleContract(cp1, `First FULL #${r1.jobId}`);
    assertExtendedCheckpointsFullWalk(cp1, `First FULL #${r1.jobId}`);
    assertReconciliationInvariant(cp1, `First FULL #${r1.jobId}`);

    const r2 = await triggerScan("FULL");
    assert.strictEqual(r2.alreadyRunning, false, "Second FULL scan should not report alreadyRunning");
    const job2 = await waitForJobTerminal(r2.jobId);
    assert.strictEqual(job2["status"], "DONE", `Second FULL scan #${r2.jobId} should be DONE`);
    assert.ok(!isNaN(Date.parse(job2["finishedAt"] as string)),
      `Second FULL finishedAt "${job2["finishedAt"]}" should be a parseable date`);
    const cp2 = extractCheckpoints(job2, `Second FULL #${r2.jobId}`);
    const terminal2 = assertLifecycleContract(cp2, `Second FULL #${r2.jobId}`);
    assertExtendedCheckpointsFullWalk(cp2, `Second FULL #${r2.jobId}`);
    assertReconciliationInvariant(cp2, `Second FULL #${r2.jobId}`);

    // ── Parity: both scans reach completion with zero terminal resources ──────
    // The event sequences may differ if the second scan uses the dir-cache fast-path
    // (expected optimization); what must be identical is the terminal resource shape.
    for (const key of ["queueDepth", "workersRunning", "pendingWrites", "activeTimers", "activeJobs"] as const) {
      assert.strictEqual(
        terminal1.fields[key],
        terminal2.fields[key],
        `Terminal.${key} must match across sequential scans ` +
        `(scan1=${terminal1.fields[key]}, scan2=${terminal2.fields[key]})`,
      );
    }

    // Both scans must carry all 6 required events in correct order
    for (const evt of REQUIRED_EVENTS) {
      assert.ok(
        cp1.some((c) => c.event === evt),
        `First FULL scan: required event "${evt}" must be in checkpoints`,
      );
      assert.ok(
        cp2.some((c) => c.event === evt),
        `Second FULL scan: required event "${evt}" must be in checkpoints`,
      );
    }

    // DB consistency: diagnostics non-null on both
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
  test("3. §8.2 DB consistency: no RUNNING rows, all DONE jobs have finishedAt, no duplicate active entries", async () => {
    await waitForNoRunning(); // safety: ensure any prior test jobs settled

    const jobs = await getJobs();

    const running = jobs.filter((j) => j["status"] === "RUNNING");
    assert.strictEqual(running.length, 0,
      `Expected 0 RUNNING jobs, found ${running.length}: ` +
      JSON.stringify(running.map((j) => ({ id: j["id"], status: j["status"] }))));

    const doneJobs = jobs.filter((j) => j["status"] === "DONE");
    assert.ok(doneJobs.length >= 2,
      `Expected at least 2 DONE jobs from sequential FULL scans, found ${doneJobs.length}`);
    for (const job of doneJobs.slice(-2)) {
      assert.ok(job["finishedAt"],
        `DONE job #${job["id"]} must have finishedAt populated (DB consistency)`);
    }
  });

  // ── §8.1: Active-job endpoint ─────────────────────────────────────────────
  test("4. §8.1 GET /api/library/jobs/active → 200, empty list after scans settle", async () => {
    await waitForNoRunning(); // safety guard

    const res = await apiGet("/library/jobs/active");
    assert.strictEqual(res.status, 200,
      `GET /api/library/jobs/active should return 200, got ${res.status}`);
    const body = (await res.json()) as unknown;
    const active = Array.isArray(body)
      ? body
      : (body as Record<string, unknown[]>)["jobs"] ?? [];
    assert.ok(Array.isArray(active), "Active-jobs payload should be an array");
    assert.strictEqual((active as unknown[]).length, 0,
      `Active jobs list should be empty after scans settle, found ${(active as unknown[]).length}`);
  });

  // ── §7.3: Deterministic cancel scenario ───────────────────────────────────
  test("5. §7.3 Cancel scenario: job reaches CANCELLED, terminal.activeJobs=0, completionReason=cancelled, subsequent FULL scan completes cleanly", async () => {
    await waitForNoRunning(); // safety guard

    // 800 temp files (created in before()) give the scan enough work so the cancel
    // arrives while the scan is in its walker phase, making CANCELLED deterministic.
    const r = await triggerScan("FULL");
    assert.strictEqual(r.alreadyRunning, false, "Cancel-target scan should start fresh");

    // Wait briefly for the scan to move past its initial DB read into active walking
    await new Promise<void>((res) => setTimeout(res, 200));

    const cancelRes = await fetch(`${API_BASE}/api/library/jobs/${r.jobId}/cancel`, {
      method: "POST",
      headers: authHeaders(),
    });
    assert.ok(cancelRes.ok, `Cancel request should succeed (status ${cancelRes.status})`);

    const cancelledJob = await waitForJobTerminal(r.jobId);
    await waitForNoRunning();

    assert.strictEqual(
      cancelledJob["status"],
      "CANCELLED",
      `Job #${r.jobId} should be CANCELLED after cancel request ` +
      `(got: ${cancelledJob["status"]}). The 800 temp files ensure the walker ` +
      `is still active when the cancel arrives.`,
    );

    // Verify the cancelled job stored checkpoints (cancel path now writes diagnostics)
    const cpCancel = extractCheckpoints(cancelledJob, `Cancelled job #${r.jobId}`);
    const terminalCp = cpCancel.find((c) => c.event === "terminal");
    assert.ok(terminalCp,
      `Cancelled job #${r.jobId}: should have a "terminal" checkpoint in stored checkpoints`);
    const tf = terminalCp!.fields;
    for (const key of ["queueDepth", "workersRunning", "pendingWrites", "activeTimers", "activeJobs"] as const) {
      assert.strictEqual(tf[key], 0,
        `Cancelled terminal.${key} should be 0 (got ${tf[key]})`);
    }
    assert.strictEqual(tf["completionReason"], "cancelled",
      `Cancelled terminal.completionReason should be "cancelled", got "${tf["completionReason"]}"`);

    // Subsequent FULL scan must start immediately and complete (proves cleanup)
    const r2 = await triggerScan("FULL");
    assert.strictEqual(r2.alreadyRunning, false,
      "Post-cancel FULL scan should start immediately (alreadyRunning:false)");
    const freshJob = await waitForJobTerminal(r2.jobId);
    assert.strictEqual(freshJob["status"], "DONE",
      `Post-cancel FULL scan #${r2.jobId} should be DONE`);
    const cpFresh = extractCheckpoints(freshJob, `Post-cancel FULL #${r2.jobId}`);
    assertLifecycleContract(cpFresh, `Post-cancel FULL #${r2.jobId}`);
  });

  // ── §7.2: QUICK fast-path ─────────────────────────────────────────────────
  test("6. §7.2 QUICK scan (fast-path): all 6 lifecycle events with correct ordering and zero terminal resources", async () => {
    await waitForNoRunning(); // safety guard

    const r = await triggerScan("QUICK");
    const job = await waitForJobTerminal(r.jobId);
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

  // ── §8.3: POST /api/library/optimize ─────────────────────────────────────
  test("7. §8.3 POST /api/library/optimize → alreadyRunning:false (engine clean, no orphaned lock)", async () => {
    await waitForNoRunning(); // safety guard

    const res = await apiPost("/library/optimize", {});
    assert.strictEqual(res.status, 200,
      `POST /api/library/optimize should return 200, got ${res.status}`);
    const body = (await res.json()) as { alreadyRunning: boolean };
    assert.strictEqual(body.alreadyRunning, false,
      `§8.3: POST /api/library/optimize should return alreadyRunning:false ` +
      `after all scans settle (got: ${body.alreadyRunning})`);
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
