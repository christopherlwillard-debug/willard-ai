import assert from "node:assert/strict";
import { after, test } from "node:test";
import { pool } from "@workspace/db";
import {
  acquireConversionJobLock,
  releaseConversionJobLock,
  type ConversionJobLockClient,
} from "../lib/conversion-job-lock.ts";

const jobId = 2_000_000_000;

after(async () => {
  await pool.end();
});

test("PostgreSQL advisory locks serialize independent conversion workers and release on disconnect", async () => {
  let held: ConversionJobLockClient | null = null;
  try {
    held = await acquireConversionJobLock(jobId, () => pool.connect());
    assert.ok(held, "first worker should acquire the job lock");

    const competing = await acquireConversionJobLock(jobId, () => pool.connect());
    assert.equal(competing, null, "second connection must not acquire an already-held job lock");

    await releaseConversionJobLock(held, jobId);
    held = null;

    held = await acquireConversionJobLock(jobId, () => pool.connect());
    assert.ok(held, "lock should be available after verified unlock");

    // A crashed worker loses its session connection. PostgreSQL must release
    // the session advisory lock when that connection is discarded.
    held.release(true);
    held = null;

    held = await acquireConversionJobLock(jobId, () => pool.connect());
    assert.ok(held, "lock should be available after the owning connection is destroyed");
    await releaseConversionJobLock(held, jobId);
    held = null;
  } finally {
    if (held) {
      try { await releaseConversionJobLock(held, jobId); } catch { /* discard on failed unlock */ }
    }
  }
});
