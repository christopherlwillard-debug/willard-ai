import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { pool } = await import("@workspace/db");

async function insertRunningJob(nasPath: string) {
  return pool.query<{ id: number }>(
    `INSERT INTO library_jobs
       (job_type, profile, priority, status, nas_path, started_at)
     VALUES ('SCAN', 'QUICK', 'HIGH', 'RUNNING', $1, NOW())
     RETURNING id`,
    [nasPath],
  );
}

test("concurrent runnable claims allow one job per library and do not block other libraries", async (t) => {
  const reachable = await pool.query("SELECT 1").catch(() => null);
  if (!reachable) {
    t.skip("requires the configured PostgreSQL test database");
    return;
  }

  const sameLibrary = path.join(os.tmpdir(), `willard-job-claim-${crypto.randomUUID()}`);
  const otherLibrary = path.join(os.tmpdir(), `willard-job-claim-${crypto.randomUUID()}`);
  const paths = [sameLibrary, otherLibrary];
  try {
    const sameResults = await Promise.allSettled([
      insertRunningJob(sameLibrary),
      insertRunningJob(sameLibrary),
    ]);
    const sameFulfilled = sameResults.filter((result) => result.status === "fulfilled");
    const sameRejected = sameResults.filter((result) => result.status === "rejected");

    assert.equal(sameFulfilled.length, 1, "exactly one concurrent claim should win");
    assert.equal(sameRejected.length, 1, "the losing claim should be rejected by PostgreSQL");
    assert.equal(
      (sameRejected[0]!.reason as { code?: string; constraint?: string }).constraint,
      "library_jobs_active_nas_unique",
    );

    const differentResults = await Promise.allSettled([
      insertRunningJob(otherLibrary),
      insertRunningJob(`${otherLibrary}-second`),
    ]);
    assert.equal(
      differentResults.filter((result) => result.status === "fulfilled").length,
      2,
      "independent library roots should claim concurrently",
    );
  } finally {
    await pool.query("DELETE FROM library_jobs WHERE nas_path = ANY($1::text[])", [
      [...paths, `${otherLibrary}-second`],
    ]);
  }
});