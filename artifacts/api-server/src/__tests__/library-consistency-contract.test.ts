import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("maintenance routes share the authoritative active-library resolver", () => {
  for (const file of ["routes/library.ts", "routes/cleanup.ts", "routes/media-health.ts", "routes/optimize.ts"]) {
    assert.match(source(file), /active-library\.ts/);
  }

  const resolver = source("lib/active-library.ts");
  assert.match(resolver, /orderBy\(desc\(isNotNull\(appSettingsTable\.passwordHash\)\), asc\(appSettingsTable\.id\)\)/);
  assert.match(resolver, /nasPath\?\.trim\(\)/);
});

test("scan and Cleanup use the same confirmed-duplicate summary", () => {
  assert.match(source("lib/library-engine/job-engine.ts"), /getDuplicateSummary\(state\.nasPath\)/);
  assert.match(source("routes/cleanup.ts"), /getDuplicateSummary\(nasPath\)/);
  assert.match(source("routes/cleanup.ts"), /duplicateCandidates:\s+duplicateSummary\.unconfirmedCandidates/);
});

test("duplicate storage estimates exclude only one largest retained copy", () => {
  const summary = source("lib/duplicate-summary.ts");
  const cleanup = source("routes/cleanup.ts");

  assert.match(summary, /SUM\(size_bytes\)\s*-\s*MAX\(size_bytes\) AS wasted/);
  assert.match(summary, /SUM\(m\.size_bytes\)\s*-\s*MAX\(m\.size_bytes\) AS wasted/);
  assert.doesNotMatch(summary, /COUNT\(\*\)\s*-\s*1\)\s*\*\s*MAX/);
  assert.equal((cleanup.match(/largestFileSize:\s*Number\(r\.largest_file_size\)/g) ?? []).length, 2);
  assert.match(cleanup, /totalSize - a\.largestFileSize/);
  assert.match(cleanup, /raw\.totalSize - raw\.largestFileSize/);
});

test("organization execution, resume, and rollback are fenced by unique lease tokens", () => {
  const schema = source("../../../lib/db/src/schema/organization_jobs.ts");
  const routes = source("routes/organize.ts");
  const helpers = source("lib/organize-helpers.ts");

  assert.match(schema, /leaseToken:\s*text\("lease_token"\)/);
  assert.match(routes, /let executionLeaseToken = ""/);
  assert.match(routes, /executionLeaseToken = crypto\.randomUUID\(\)/);
  assert.match(routes, /let resumeLeaseToken = ""/);
  assert.match(routes, /resumeLeaseToken = crypto\.randomUUID\(\)/);
  assert.match(routes, /let rollbackLeaseToken = ""/);
  assert.match(routes, /rollbackLeaseToken = crypto\.randomUUID\(\)/);
  assert.match(routes, /eq\(organizationJobsTable\.leaseToken, executionLeaseToken\)/);
  assert.match(routes, /eq\(organizationJobsTable\.leaseToken, resumeLeaseToken\)/);
  assert.match(routes, /eq\(organizationJobsTable\.leaseToken, rollbackLeaseToken\)/);
  assert.match(routes, /beforeMove: async \(\) => \{\s*await assertOrganizationLease\(id, nasPath, executionLeaseToken\);/);
  assert.match(routes, /beforeRestore: async \(\) => \{\s*await assertOrganizationLease\(id, nasPath, executionLeaseToken\);/);
  assert.match(routes, /if \(!updatedRollback\)/);
  assert.match(routes, /function publicOrganizationJob[\s\S]*leaseToken: _leaseToken/);
  assert.match(routes, /jobs\.map\(publicOrganizationJob\)/);
  assert.match(routes, /interrupted: jobs\.map\(publicOrganizationJob\)/);
  assert.match(routes, /res\.json\(publicOrganizationJob\(updated\)\)/);
  assert.match(helpers, /await beforeEachMove\?\.\(mv\);\s*try/);
  assert.match(helpers, /await opts\?\.beforeMove\?\.\(\);/);
});

test("catalog reconciliation remains metadata-only", () => {
  const engine = source("lib/library-engine/job-engine.ts");
  const reconciliation = engine.slice(
    engine.indexOf("// ── Phase: detecting deletions"),
    engine.indexOf("// ── Duplicate detection"),
  );
  assert.match(reconciliation, /\.update\(mediaFilesTable\)/);
  assert.doesNotMatch(reconciliation, /unlink|rmSync|renameSync|copyFile/);
});

test("all library job-start routes fail HTTP admission when NAS is offline or read-only", () => {
  const library = source("routes/library.ts");
  const legacyScan = source("routes/scan.ts");

  const startCalls = library.match(/const result = await startJob\(/g) ?? [];
  const handledCalls = library.match(/respondToLibraryJobStartFailure\(res, result, nasPath\)/g) ?? [];
  assert.equal(startCalls.length, 4, "all four library worker start routes should be covered");
  assert.equal(handledCalls.length, startCalls.length, "every library worker start route must map admission failures");
  assert.match(library, /result\.errorCode === "NAS_OFFLINE"/);
  assert.match(library, /result\.errorCode === "NAS_READ_ONLY"/);
  assert.match(library, /result\.errorCode === "CAPACITY_UNSAFE"/);

  assert.match(legacyScan, /result\.errorCode === "NAS_OFFLINE"/);
  assert.match(legacyScan, /result\.errorCode === "NAS_READ_ONLY"/);
  assert.match(legacyScan, /result\.errorCode === "CAPACITY_UNSAFE"/);
});
