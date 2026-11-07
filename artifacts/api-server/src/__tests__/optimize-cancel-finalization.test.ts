import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const routePath = path.resolve(
  import.meta.dirname,
  "../routes/optimize.ts",
);

test("cancelled conversion keeps successful staged outputs eligible for finalization", () => {
  const source = fs.readFileSync(routePath, "utf8");
  const completion = source.slice(source.indexOf("const [finishedJob]"), source.indexOf('send("summary"'));

  assert.match(completion, /const wasCancelled = Boolean\(finishedJob\?\.cancelledAt\)/);
  assert.match(completion, /const needsFinalization = succeeded > 0/);
  assert.match(completion, /const nextStatus = needsFinalization \? "awaiting_action" : "cancelled"/);
  assert.match(completion, /resultJson = \{ files: results, totalSaved, stagingDir, cancelled: wasCancelled \}/);
  assert.match(completion, /status: nextStatus/);
  assert.match(completion, /stage: nextStatus/);
  assert.match(completion, /verified staged file\(s\) are ready for your action/);
  assert.match(completion, /no successful staged files need finalization/);
});
