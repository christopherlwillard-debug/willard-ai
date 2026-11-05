import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const routePath = fileURLToPath(new URL("../routes/optimize.ts", import.meta.url));
const source = readFileSync(routePath, "utf8");
const executeStart = source.indexOf('router.get("/optimize/jobs/:id/execute"');
const executeEnd = source.indexOf("\nrouter.", executeStart + 1);
const executeRoute = source.slice(executeStart, executeEnd < 0 ? source.length : executeEnd);

test("conversion execution claims pending jobs atomically before scanning", () => {
  const claim = executeRoute.indexOf("const [claimedJob] = await db.update(conversionJobsTable)");
  const scan = executeRoute.indexOf("walkForConversion(path.resolve(nasPath)");
  assert.ok(claim >= 0 && scan > claim);
  assert.match(executeRoute.slice(claim, scan), /eq\(conversionJobsTable\.status, "pending"\)/);
  assert.match(executeRoute.slice(claim, scan), /eq\(conversionJobsTable\.nasPath, job\.nasPath\)/);
  assert.match(executeRoute.slice(claim, scan), /if \(!claimedJob\)/);
  assert.doesNotMatch(executeRoute, /set\(\{ status: "running", cancelledAt: null, error: null \}\)\.where\(eq\(conversionJobsTable\.id, id\)\)/);
});


const retryStart = source.indexOf('router.post("/optimize/jobs/:id/retry"');
const retryEnd = source.indexOf('\nrouter.post("/optimize/jobs/:id/cancel"', retryStart);
const retryRoute = source.slice(retryStart, retryEnd);

test("conversion retry refuses awaiting-action jobs without deleting staged outputs", () => {
  assert.ok(retryStart >= 0 && retryEnd > retryStart, "retry route should be present");
  assert.match(retryRoute, /if \(job\.status !== "failed"\)/);
  assert.match(retryRoute, /only failed jobs can be retried/);
  assert.match(retryRoute, /Finalize awaiting-action jobs first to preserve staged outputs/);
  assert.match(retryRoute, /res\.status\(409\)/);
  assert.doesNotMatch(retryRoute, /fs\.rmSync/);
  assert.doesNotMatch(retryRoute, /job\.status === "awaiting_action"/);
  const guard = retryRoute.indexOf('if (job.status !== "failed")');
  const reset = retryRoute.indexOf(".update(conversionJobsTable)", guard);
  assert.ok(guard >= 0 && reset > guard, "the status guard must run before resetting the job");
});

const walkerStart = source.indexOf("function walkForConversion(");
const walkerEnd = source.indexOf("\n}", walkerStart);
const walker = source.slice(walkerStart, walkerEnd < 0 ? source.length : walkerEnd);

test("conversion scans fail closed when a directory cannot be read", () => {
  assert.ok(walkerStart >= 0 && walkerEnd > walkerStart, "conversion walker should be present");
  assert.match(walker, /catch \(error\)/);
  assert.match(walker, /Unable to scan conversion directory/);
  assert.doesNotMatch(walker, /catch \{\s*return;\s*\}/);

  const executeStart = source.indexOf('router.get("/optimize/jobs/:id/execute"');
  const executeEnd = source.indexOf("\nrouter.", executeStart + 1);
  const executeRoute = source.slice(executeStart, executeEnd < 0 ? source.length : executeEnd);
  const scan = executeRoute.indexOf("walkForConversion(path.resolve(nasPath)");
  const emptyResult = executeRoute.indexOf("if (totalFiles === 0)");
  assert.ok(scan >= 0 && emptyResult > scan, "directory scanning must finish before the empty-library result");
  assert.match(executeRoute, /status: "failed"/);
});
