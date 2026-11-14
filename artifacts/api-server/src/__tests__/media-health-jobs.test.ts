import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { appSettingsTable, db, libraryJobsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { requireDisposableAuditApiUrl, requireDisposableTestRoot } from "./integration-test-safety.ts";

const API_BASE = requireDisposableAuditApiUrl();
const PASSWORD = "willard123";
let cookie = "";
let nasPath = "";
let fixturePath = "";
let jobId: number | null = null;
let cleanupRetryJobId: number | null = null;

async function request(route: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("Cookie", cookie);
  const response = await fetch(`${API_BASE}/api${route}`, { ...init, headers });
  const setCookie = response.headers.get("set-cookie")?.match(/willard\.sid=[^;]+/);
  if (setCookie) cookie = setCookie[0];
  return response;
}

before(async () => {
  const [settings] = await db.select({ nasPath: appSettingsTable.nasPath })
    .from(appSettingsTable).limit(1);
  assert.ok(settings?.nasPath, "The disposable audit library must be configured.");
  nasPath = settings.nasPath!;
  fixturePath = path.join(nasPath, `.health-job-${randomUUID()}`);
  await fs.mkdir(fixturePath, { recursive: true });
  await fs.writeFile(path.join(fixturePath, "probe.txt"), "health scan fixture");

  const login = await request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(login.status, 200, await login.text());
});

after(async () => {
  if (jobId !== null) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await request(`/media/health/jobs/${jobId}`);
      if (!response.ok) break;
      const body = await response.json() as { job?: { status?: string } };
      if (body.job?.status !== "RUNNING") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (cleanupRetryJobId !== null) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await request(`/media/health/jobs/${cleanupRetryJobId}`);
      if (!response.ok) break;
      const body = await response.json() as { job?: { status?: string } };
      if (body.job?.status !== "RUNNING") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (fixturePath) await fs.rm(fixturePath, { recursive: true, force: true });
});

test("Health Center scan is a durable background job that reconnects and stores its result", async () => {
  assert.equal(path.resolve(nasPath), path.resolve(requireDisposableTestRoot(), "library"));

  const initialStatus = await request("/media/health");
  assert.equal(initialStatus.status, 200);
  const initial = await initialStatus.json() as { hasReport?: boolean; activeJob?: unknown };
  assert.equal(initial.hasReport, false, "GET must return cached state instead of scanning inside the request");
  assert.equal(initial.activeJob, null);

  const start = await request("/media/health/scan", { method: "POST" });
  assert.equal(start.status, 202, `Unexpected health scan response: HTTP ${start.status}`);
  const started = await start.json() as {
    job?: { id?: number; jobType?: string; status?: string; phase?: string; diagnostics?: unknown };
  };
  assert.ok(Number.isSafeInteger(started.job?.id));
  jobId = started.job!.id!;
  assert.equal(started.job?.jobType, "HEALTH_SCAN");
  assert.equal(started.job?.status, "RUNNING");
  assert.equal("diagnostics" in (started.job ?? {}), false, "worker ownership tokens must not be exposed to clients");

  let completed: { id: number; status: string; summary?: Record<string, unknown>; error?: string } | undefined;
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await request(`/media/health/jobs/${jobId}`);
    assert.equal(response.status, 200, `Health job lookup failed: HTTP ${response.status}`);
    const body = await response.json() as { job: typeof completed };
    completed = body.job;
    if (completed?.status !== "RUNNING") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(completed?.status, "DONE", completed?.error ?? "Health worker did not finish.");
  const report = completed?.summary?.healthReport as { libraryPath?: string; issues?: { missingFiles?: number } } | undefined;
  assert.equal(report?.libraryPath, nasPath);
  assert.equal(typeof report?.issues?.missingFiles, "number");

  const status = await request("/media/health");
  assert.equal(status.status, 200);
  const cached = await status.json() as { hasReport?: boolean; libraryPath?: string; activeJob?: unknown };
  assert.equal(cached.hasReport, true);
  assert.equal(cached.libraryPath, nasPath);
  assert.equal(cached.activeJob, null);
});

test("interrupted Health Center cleanup retains actions and offers a safe retry after reload", async () => {
  const emptyFolder = path.join(fixturePath, "empty-folder");
  await fs.mkdir(emptyFolder);
  const start = await request("/media/cleanup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actions: ["emptyFolders"] }),
  });
  const startText = await start.text();
  assert.equal(start.status, 202, startText);
  const started = JSON.parse(startText) as { job?: { id?: number; actions?: string[] } };
  assert.ok(Number.isSafeInteger(started.job?.id));
  const originalJobId = started.job!.id!;
  jobId = originalJobId;

  let completed: { status?: string; actions?: string[]; phase?: string } | undefined;
  for (let attempt = 0; attempt < 300; attempt++) {
    const response = await request(`/media/health/jobs/${originalJobId}`);
    assert.equal(response.status, 200);
    const body = await response.json() as { job?: typeof completed };
    completed = body.job;
    if (completed?.status !== "RUNNING") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(completed?.status, "DONE", "The first cleanup should finish before simulating a restart");
  assert.deepEqual(completed?.actions, ["emptyFolders"]);
  assert.equal(await fs.stat(emptyFolder).then(() => true, () => false), false, "The first cleanup should remove the empty folder");

  await db.update(libraryJobsTable).set({
    status: "FAILED",
    error: "Cleanup was interrupted by a server restart.",
    finishedAt: new Date(),
    diagnostics: sql`jsonb_set(
      COALESCE(${libraryJobsTable.diagnostics}, '{}'::jsonb),
      '{healthJob}',
      COALESCE(${libraryJobsTable.diagnostics}->'healthJob', '{}'::jsonb) ||
        jsonb_build_object('restartInterrupted', true, 'retryAvailable', true, 'phase', 'interrupted'),
      true
    )`,
  }).where(eq(libraryJobsTable.id, originalJobId));

  const reloaded = await request("/media/health");
  assert.equal(reloaded.status, 200);
  const reloadedBody = await reloaded.json() as {
    recoverableCleanup?: { id?: number; actions?: string[]; retryAvailable?: boolean; processed?: number; phase?: string; message?: string };
  };
  assert.equal(reloadedBody.recoverableCleanup?.id, originalJobId);
  assert.deepEqual(reloadedBody.recoverableCleanup?.actions, ["emptyFolders"]);
  assert.equal(reloadedBody.recoverableCleanup?.retryAvailable, true);
  assert.equal(reloadedBody.recoverableCleanup?.phase, "interrupted");
  assert.match(reloadedBody.recoverableCleanup?.message ?? "", /server restart/i);
  assert.equal(typeof reloadedBody.recoverableCleanup?.processed, "number", "Last progress should survive a reload");

  const retry = await request(`/media/cleanup/jobs/${originalJobId}/retry`, { method: "POST" });
  const retryText = await retry.text();
  assert.equal(retry.status, 202, retryText);
  const retryBody = JSON.parse(retryText) as { job?: { id?: number; actions?: string[] } };
  assert.ok(Number.isSafeInteger(retryBody.job?.id));
  assert.notEqual(retryBody.job?.id, originalJobId);
  cleanupRetryJobId = retryBody.job!.id!;

  let retryJob: { status?: string; actions?: string[] } | undefined;
  for (let attempt = 0; attempt < 300; attempt++) {
    const response = await request(`/media/health/jobs/${cleanupRetryJobId}`);
    assert.equal(response.status, 200);
    const body = await response.json() as { job?: typeof retryJob };
    retryJob = body.job;
    if (retryJob?.status !== "RUNNING") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(retryJob?.status, "DONE", "Retry should finish after rechecking already-completed work");
  assert.deepEqual(retryJob?.actions, ["emptyFolders"]);
  const original = await db.select({ diagnostics: libraryJobsTable.diagnostics })
    .from(libraryJobsTable).where(eq(libraryJobsTable.id, originalJobId)).limit(1);
  const healthJob = ((original[0]?.diagnostics as Record<string, unknown>)?.healthJob ?? {}) as Record<string, unknown>;
  assert.equal(healthJob.retryAvailable, false, "A successful retry should consume the old retry prompt");
});
