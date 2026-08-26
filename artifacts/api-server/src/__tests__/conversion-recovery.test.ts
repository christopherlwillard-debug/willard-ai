/**
 * End-to-end coverage for conversion crash recovery:
 * running -> failed on recovery -> pending on retry -> done over SSE.
 *
 * The seeded job uses an extension that has no files in the configured test
 * library, so execution exercises the real stream and database transitions
 * without modifying any user media.
 */
import { describe, test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import { db, pool, appSettingsTable, conversionJobsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { recoverInterruptedConversionJobs, INTERRUPTED_CONVERSION_ERROR } from "../lib/conversion-recovery.ts";

const API_BASE = process.env["WILLARD_API_URL"]
  ?? (process.env["REPLIT_DEV_DOMAIN"] ? `https://${process.env["REPLIT_DEV_DOMAIN"]}` : "http://localhost:8080");
const PASSWORD = "willard123";
let cookie = "";
let jobId = 0;

async function post(route: string, body: unknown): Promise<Response> {
  const response = await fetch(`${API_BASE}/api${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  const setCookie = response.headers.get("set-cookie")?.match(/willard\.sid=[^;]+/);
  if (setCookie) cookie = setCookie[0];
  return response;
}

describe("conversion restart recovery", { concurrency: false }, () => {
  before(async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversion_jobs (
        id serial PRIMARY KEY,
        status text NOT NULL DEFAULT 'pending',
        approved_exts jsonb NOT NULL,
        backup_dir text,
        nas_path text NOT NULL,
        total_files integer NOT NULL DEFAULT 0,
        processed_files integer NOT NULL DEFAULT 0,
        succeeded_files integer NOT NULL DEFAULT 0,
        failed_files integer NOT NULL DEFAULT 0,
        skipped_files integer NOT NULL DEFAULT 0,
        result_json jsonb,
        error text,
        created_at timestamp NOT NULL DEFAULT now(),
        completed_at timestamp
      )
    `);
    const settings = await db.select({ nasPath: appSettingsTable.nasPath }).from(appSettingsTable).limit(1);
    const nasPath = settings[0]?.nasPath;
    assert.ok(nasPath, "A configured test library is required");
    const auth = await post("/auth/login", { password: PASSWORD });
    assert.equal(auth.status, 200, `Login failed: ${await auth.text()}`);

    const rows = await db.insert(conversionJobsTable).values({
      status: "running",
      approvedExts: ["__recovery_test__"],
      backupDir: `${nasPath}/WillardAI/backups/recovery-test`,
      nasPath,
      totalFiles: 0,
    }).returning({ id: conversionJobsTable.id });
    jobId = rows[0]!.id;
    const recovered = await recoverInterruptedConversionJobs();
    assert.ok(recovered >= 1, "Recovery should find the seeded running job");
  });

  after(async () => {
    if (jobId) await db.delete(conversionJobsTable).where(eq(conversionJobsTable.id, jobId));
  });

  test("marks interrupted job failed with retryable error", async () => {
    const row = await db.select().from(conversionJobsTable).where(eq(conversionJobsTable.id, jobId));
    assert.equal(row[0]?.status, "failed");
    assert.equal(row[0]?.error, INTERRUPTED_CONVERSION_ERROR);
  });

  test("retry resets to pending and SSE execution reaches done", async () => {
    const retry = await post(`/optimize/jobs/${jobId}/retry`, {});
    const retryText = await retry.text();
    assert.equal(retry.status, 200, retryText);
    const pending = JSON.parse(retryText) as { status: string };
    assert.equal(pending.status, "pending");

    const missingToken = await fetch(`${API_BASE}/api/optimize/jobs/${jobId}/execute`, {
      headers: { Cookie: cookie },
    });
    assert.equal(missingToken.status, 403);
    await missingToken.text();

    const tokenResponse = await post(`/optimize/jobs/${jobId}/execute-token`, {});
    const tokenBody = await tokenResponse.json() as { token?: string; error?: string };
    assert.equal(tokenResponse.status, 200, tokenBody.error ?? "Execution token request failed");
    assert.ok(tokenBody.token, "Execution token should be returned");

    const authorizedUrl = `${API_BASE}/api/optimize/jobs/${jobId}/execute?token=${encodeURIComponent(tokenBody.token)}`;
    const stream = await fetch(authorizedUrl, {
      headers: { Cookie: cookie },
    });
    const text = await stream.text();
    assert.equal(stream.status, 200, text);
    assert.match(text, /event: summary/);
    assert.match(text, /"totalFiles":0/);
    const done = await db.select().from(conversionJobsTable).where(eq(conversionJobsTable.id, jobId));
    assert.equal(done[0]?.status, "done");

    const replay = await fetch(authorizedUrl, {
      headers: { Cookie: cookie },
    });
    assert.equal(replay.status, 403);
    await replay.text();
  });
});