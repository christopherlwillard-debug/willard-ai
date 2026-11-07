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
  assert.equal(startCalls.length, 5, "all five library worker start routes should be covered");
  assert.equal(handledCalls.length, startCalls.length, "every library worker start route must map admission failures");
  assert.match(library, /result\.errorCode === "NAS_OFFLINE"/);
  assert.match(library, /result\.errorCode === "NAS_READ_ONLY"/);
  assert.match(library, /result\.errorCode === "CAPACITY_UNSAFE"/);

  const clearStart = library.indexOf('router.delete("/library/thumbnails/cache"');
  const clearEnd = library.indexOf("// ── POST /api/library/thumbnails/rebuild", clearStart);
  const clearRoute = library.slice(clearStart, clearEnd);
  assert.ok(clearRoute.includes('profile: "HEALTH_SCAN"'));
  assert.ok(clearRoute.includes("clearThumbnailsOnly: true"));
  assert.ok(clearRoute.includes("respondToLibraryJobStartFailure(res, result, nasPath)"));
  assert.ok(clearRoute.includes("if (result.alreadyRunning)") && clearRoute.includes("res.status(409)"));
  assert.doesNotMatch(clearRoute, /clearThumbnailCache|thumbnailPath: null|thumbnailGeneratedAt: null/);

  const engine = source("lib/library-engine/job-engine.ts");
  assert.match(engine, /\(opts\.rebuildThumbnails \|\| opts\.clearThumbnailsOnly\) && opts\.jobType !== "THUMBNAILS"/);
  assert.match(engine, /if \(!opts\.clearThumbnailsOnly\)/);
  assert.match(engine, /async function runThumbnailJob\(state: ActiveJobState, rebuild = false, clearOnly = false\)/);
  assert.match(engine, /await clearThumbnailCache\(\s*nasPath,/);
  assert.match(engine, /thumbnailOperation: "CLEAR_ONLY"/);
  assert.match(engine, /jobDiagnostics\.thumbnailOperation === "CLEAR_ONLY"/);

  const openapi = readFileSync(new URL("../../../../lib/api-spec/openapi.yaml", import.meta.url), "utf8");
  const openApiClearStart = openapi.indexOf("  /library/thumbnails/cache:");
  const openApiClearEnd = openapi.indexOf("  /library/thumbnails/rebuild:", openApiClearStart);
  const openApiClear = openapi.slice(openApiClearStart, openApiClearEnd);
  assert.match(openApiClear, /summary: Queue thumbnail cache clearing/);
  assert.match(openApiClear, /"202":\s*\n\s*description: Thumbnail cache clear job accepted/);
  assert.match(openApiClear, /"503":\s*\n\s*description: NAS is offline or read-only/);

  assert.match(legacyScan, /result\.errorCode === "NAS_OFFLINE"/);
  assert.match(legacyScan, /result\.errorCode === "NAS_READ_ONLY"/);
  assert.match(legacyScan, /result\.errorCode === "CAPACITY_UNSAFE"/);
});


test("full thumbnail rebuild invalidates cache only after durable job admission and NAS validation", () => {
  const library = source("routes/library.ts");
  const engine = source("lib/library-engine/job-engine.ts");

  const rebuildStart = library.indexOf('router.post("/library/thumbnails/rebuild"');
  const rebuildEnd = library.indexOf("// ── GET /api/library/jobs/:id/files", rebuildStart);
  assert.ok(rebuildStart >= 0 && rebuildEnd > rebuildStart, "full rebuild route must exist");
  const rebuildRoute = library.slice(rebuildStart, rebuildEnd);
  assert.ok(rebuildRoute.includes("rebuildThumbnails: true"));
  assert.doesNotMatch(rebuildRoute, /clearThumbnailCache|thumbnailPath: null|thumbnailGeneratedAt: null/);
  assert.ok(rebuildRoute.includes("if (result.alreadyRunning)") && rebuildRoute.includes("res.status(409)"),
    "a different active library job must not be reported as a successful rebuild");

  const backfillStart = library.indexOf('router.post("/library/thumbnails"');
  const backfillEnd = library.indexOf("// ── GET /api/library/thumbnails/status", backfillStart);
  const backfillRoute = library.slice(backfillStart, backfillEnd);
  assert.ok(backfillStart >= 0 && backfillEnd > backfillStart);
  assert.ok(!backfillRoute.includes("rebuildThumbnails"), "ordinary missing-thumbnail backfill must preserve reusable cache");

  const startJobStart = engine.indexOf("export async function startJob");
  const startJobEnd = engine.indexOf("// ── Resume a paused job", startJobStart);
  const startJob = engine.slice(startJobStart, startJobEnd);
  const durableRunningInsert = startJob.indexOf('status:   "RUNNING"');
  const thumbnailDispatch = startJob.indexOf("startJobRun(job.id, runThumbnailJob(state, opts.rebuildThumbnails === true, opts.clearThumbnailsOnly === true), reservation)");
  assert.ok(durableRunningInsert >= 0 && thumbnailDispatch > durableRunningInsert,
    "thumbnail worker must be dispatched only after the durable RUNNING row is inserted");
  assert.ok(startJob.includes('(opts.rebuildThumbnails || opts.clearThumbnailsOnly) && opts.jobType !== "THUMBNAILS"'));

  const workerStart = engine.indexOf("async function runThumbnailJob");
  const workerEnd = engine.indexOf("// ── Fail a job", workerStart);
  const worker = engine.slice(workerStart, workerEnd);
  const reachability = worker.indexOf("const initialReach = await checkNasReachableAsync(nasPath)");
  const rebuildGuard = worker.indexOf("if (rebuild || clearOnly)");
  const cacheClear = worker.indexOf("await clearThumbnailCache(");
  const pointerReset = worker.indexOf("thumbnailPath: null");
  const reconciliation = worker.indexOf("reconcileThumbnailPointers(nasPath)");
  assert.ok(reachability >= 0 && rebuildGuard > reachability && cacheClear > rebuildGuard &&
    pointerReset > cacheClear && reconciliation > pointerReset,
    "cache invalidation and pointer reset must follow NAS validation and precede thumbnail reconciliation");
});

test("thumbnail catalog pointer persistence is serialized with cache clearing", () => {
  const thumbnail = source("lib/thumbnail-engine.ts");
  const media = source("routes/media.ts");
  const engine = source("lib/library-engine/job-engine.ts");
  const health = source("routes/media-health.ts");

  assert.match(thumbnail, /await onReady\?\.\(\{ destPath, reused: true \}\)/);
  assert.match(thumbnail, /publishThumbnail\(tempPath, destPath\);\s*await onReady\?\.\(\{ destPath, reused: false \}\)/);
  assert.match(media, /generateThumbnail\([\s\S]*?async \(\{ destPath \}\) => \{[\s\S]*?db\.update\(mediaFilesTable\)/);
  assert.match(engine, /generateThumbnail\([\s\S]*?async \(\{ destPath \}\) => \{[\s\S]*?db\.update\(mediaFilesTable\)/);
  assert.match(health, /generateThumbnail\([\s\S]*?async \(\{ destPath \}\) => \{[\s\S]*?db\.update\(mediaFilesTable\)/);
  assert.match(health, /const needsThumb = row\.mediaType === "photo" \|\| row\.mediaType === "video" \|\| row\.extension === "pdf"/);
  assert.match(health, /row\.mediaType !== "photo" && row\.mediaType !== "video" && row\.extension !== "pdf"/);
  assert.match(health, /removeOrphanedThumbnail\(nasPath, file, async \(\) => \{[\s\S]*?db\.select\(\{ id: mediaFilesTable\.id \}\)/);
  assert.doesNotMatch(health, /fs\.unlinkSync\(resolveWithinRoot\(file, getWillardAIDir\(nasPath\)\)\)/);
});
