import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearStartupDegraded,
  getStartupHealth,
  markStartupDegraded,
} from "../lib/startup-health.ts";

test("startup health is degraded only while recorded failures exist", () => {
  const operation = "test-startup-operation";
  clearStartupDegraded(operation);
  assert.equal(getStartupHealth().status, "ok");

  markStartupDegraded(operation, "A background check did not complete.");
  const degraded = getStartupHealth();
  assert.equal(degraded.status, "degraded");
  assert.deepEqual(degraded.failures.find((failure) => failure.operation === operation), {
    operation,
    message: "A background check did not complete.",
    recordedAt: degraded.failures.find((failure) => failure.operation === operation)?.recordedAt,
  });

  clearStartupDegraded(operation);
  assert.equal(getStartupHealth().status, "ok");
  assert.equal(getStartupHealth().failures.some((failure) => failure.operation === operation), false);
});