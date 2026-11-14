import assert from "node:assert/strict";
import test from "node:test";
import {
  getFollowUpHealthJobId,
  shouldClearCleanupActions,
  shouldPollHealthJob,
  type HealthJobSnapshot,
} from "../health-job-state.ts";

function job(overrides: Partial<HealthJobSnapshot> = {}): HealthJobSnapshot {
  return {
    id: 5,
    jobType: "HEALTH_CLEANUP",
    status: "RUNNING",
    processed: 3,
    total: 10,
    phase: "cleanup",
    message: "Removing stale entries",
    summary: null,
    error: null,
    ...overrides,
  };
}

test("Health Center reconnects while a durable job or its follow-up is active", () => {
  assert.equal(shouldPollHealthJob(job()), true);
  assert.equal(shouldPollHealthJob(job({ status: "DONE", summary: { followUpPending: true } })), true);
  assert.equal(shouldPollHealthJob(job({ status: "DONE", summary: { followUpPending: false } })), false);
});

test("Health Center follows a valid child job and does not clear actions after failure", () => {
  assert.equal(getFollowUpHealthJobId(job({ status: "DONE", summary: { followUpJobId: 42 } })), 42);
  assert.equal(getFollowUpHealthJobId(job({ status: "DONE", summary: { followUpJobId: "invalid" } })), null);
  assert.equal(shouldClearCleanupActions(job({ status: "DONE" })), true);
  assert.equal(shouldClearCleanupActions(job({ status: "FAILED" })), false);
  assert.equal(shouldClearCleanupActions(job({ jobType: "HEALTH_SCAN", status: "DONE" })), false);
});
