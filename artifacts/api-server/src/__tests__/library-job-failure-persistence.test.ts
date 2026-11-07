import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const engine = readFileSync(
  new URL("../lib/library-engine/job-engine.ts", import.meta.url),
  "utf8",
);
const start = engine.indexOf("async function failJob");
const end = engine.indexOf("// ── Thumbnail DB/disk reconciliation", start);
const failJob = engine.slice(start, end);

test("library job is removed from memory only after FAILED is durably persisted", () => {
  assert.ok(start >= 0 && end > start, "failJob implementation must exist");
  assert.match(failJob, /const result = await db\.update\(libraryJobsTable\)/);
  assert.match(failJob, /if \(result\.rowCount !== 1\)/);
  assert.match(failJob, /throw new Error\([\s\S]*?Could not persist FAILED status/);
  assert.ok(
    failJob.indexOf("if (result.rowCount !== 1)") < failJob.indexOf("activeJobs.delete(jobId)"),
    "active job must remain registered when the terminal DB transition fails",
  );
  assert.doesNotMatch(failJob, /\.catch\(\(\) => \{\}\)/);
  assert.match(failJob, /logger\.error\([\s\S]*?'scan job FAILED'/);
});
