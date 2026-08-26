import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  isRecoverableJobStatus,
  isTerminalJobStatus,
  progressFromPersistedJob,
  shouldAcceptJobSnapshot,
} from "../library-job-recovery.ts";

test("job snapshot cursors ignore stale events but accept a restarted server", () => {
  const current = { streamId: "before-restart", sequence: 8 };

  assert.equal(shouldAcceptJobSnapshot(current, { streamId: "before-restart", sequence: 7 }), false);
  assert.equal(shouldAcceptJobSnapshot(current, { streamId: "before-restart", sequence: 9 }), true);
  assert.equal(shouldAcceptJobSnapshot(current, { streamId: "after-restart", sequence: 1 }), true);
});

test("recovery treats every terminal job state as complete and preserves resumable pause", () => {
  for (const status of ["DONE", "FAILED", "CANCELLED", "INTERRUPTED_BY_RESTART"]) {
    assert.equal(isTerminalJobStatus(status), true);
    assert.equal(isRecoverableJobStatus(status), false);
  }
  assert.equal(isRecoverableJobStatus("RUNNING"), true);
  assert.equal(isRecoverableJobStatus("PAUSED"), true);
});

test("durable history restores a terminal progress snapshot after reconnect", () => {
  const progress = progressFromPersistedJob({
    id: 12,
    jobType: "SCAN",
    status: "FAILED",
    processedFiles: 20,
    totalFiles: 50,
    summary: { skipped: 3 },
  });

  assert.equal(progress.jobId, 12);
  assert.equal(progress.status, "FAILED");
  assert.equal(progress.progress, 40);
  assert.deepEqual(progress.summary, { skipped: 3 });
});