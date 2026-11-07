import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
const routePath = new URL("../routes/optimize.ts", import.meta.url);

test("cancelled conversion keeps successful staged outputs eligible for finalization", () => {
  const source = fs.readFileSync(routePath, "utf8");
  const completionStart = source.indexOf("const [finishedJob]");
  const completionEnd = source.indexOf('send("summary"', completionStart);
  assert.ok(completionStart >= 0, "finished-job cancellation check must exist");
  assert.ok(completionEnd > completionStart, "final summary must follow cancellation finalization");
  const completion = source.slice(completionStart, completionEnd);

  assert.match(completion, /const wasCancelled = Boolean\(finishedJob\?\.cancelledAt\)/);
  assert.match(completion, /const needsFinalization = succeeded > 0/);
  assert.match(completion, /const nextStatus = needsFinalization \? "awaiting_action" : "cancelled"/);
  assert.match(completion, /resultJson = \{ files: results, totalSaved, stagingDir, cancelled: wasCancelled \}/);
  assert.match(completion, /status: nextStatus/);
  assert.match(completion, /stage: nextStatus/);
  assert.match(completion, /verified staged file\(s\) are ready for your action/);
  assert.match(completion, /no successful staged files need finalization/);
});
