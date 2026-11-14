import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { appSettingsTable, db } from "@workspace/db";
import { requireDisposableAuditApiUrl, requireDisposableTestRoot } from "./integration-test-safety.ts";

const API_BASE = requireDisposableAuditApiUrl();
const PASSWORD = "willard123";
let cookie = "";
let nasPath = "";
let fixturePath = "";
let jobId: number | null = null;

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
