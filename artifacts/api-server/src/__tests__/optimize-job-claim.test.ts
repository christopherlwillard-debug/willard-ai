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
