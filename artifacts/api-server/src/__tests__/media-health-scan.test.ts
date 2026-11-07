import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isMissingFilesystemEntry, isMissingRegularMediaFile, softDeleteMissingMediaRecord } from "../lib/media-health-scan.ts";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

test("media health treats only ENOENT and ENOTDIR as confirmed missing paths", () => {
  assert.equal(isMissingFilesystemEntry({ code: "ENOENT" }), true);
  assert.equal(isMissingFilesystemEntry({ code: "ENOTDIR" }), true);
  assert.equal(isMissingFilesystemEntry({ code: "EACCES" }), false);
  assert.equal(isMissingFilesystemEntry({ code: "EIO" }), false);
});

test("media health distinguishes missing regular files from directories", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-media-health-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "photo.jpg");
  fs.writeFileSync(file, "photo");
  assert.equal(isMissingRegularMediaFile(file), false);
  assert.equal(isMissingRegularMediaFile(path.join(root, "missing.jpg")), true);
  assert.throws(() => isMissingRegularMediaFile(root), /not a regular/);
});

test("media health refuses symlink media paths rather than following them", (t) => {
  if (process.platform === "win32") {
    t.skip("Symlink creation may require elevated Windows privileges.");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-media-health-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "target.jpg");
  const link = path.join(root, "link.jpg");
  fs.writeFileSync(target, "photo");
  fs.symlinkSync(target, link);
  assert.throws(() => isMissingRegularMediaFile(link), /not a regular/);
});

test("media health checks library reachability and uses fail-closed missing-file classification", () => {
  const routePath = fileURLToPath(new URL("../routes/media-health.ts", import.meta.url));
  const source = readFileSync(routePath, "utf8");
  assert.match(source, /checkNasReachable\(nasPath\)/);
  assert.match(source, /if \(!reachability\.online\)/);
  assert.match(source, /isMissingRegularMediaFile\(source\)/);
  assert.doesNotMatch(source, /if \(!fs\.existsSync\(source\)\) missing\.push\(row\)/);
  const walkerStart = source.indexOf("function walkDirectories");
  const walkerEnd = source.indexOf("function cacheInventory", walkerStart);
  const walker = source.slice(walkerStart, walkerEnd);
  assert.ok(walkerStart >= 0 && walkerEnd > walkerStart);
  assert.doesNotMatch(walker, /try \{ entries = fs\.readdirSync\(dir, \{ withFileTypes: true \}\); \} catch \{ return; \}/);
});

test("health cleanup reports durable job creation failures through its SSE error boundary", () => {
  const routePath = fileURLToPath(new URL("../routes/media-health.ts", import.meta.url));
  const source = readFileSync(routePath, "utf8");
  const cleanupRoute = source.slice(source.indexOf('router.post("/media/cleanup"'));
  const guardedStart = cleanupRoute.indexOf("try {");
  const jobInsert = cleanupRoute.indexOf("await db.insert(libraryJobsTable)");
  assert.ok(guardedStart >= 0 && jobInsert > guardedStart);
  assert.match(cleanupRoute, /let jobId: number \| null = null/);
  assert.match(cleanupRoute, /if \(jobId !== null\)/);
});


test("Health Center metadata rebuild starts the durable METADATA worker instead of reporting a no-op", () => {
  const routePath = fileURLToPath(new URL("../routes/media-health.ts", import.meta.url));
  const source = readFileSync(routePath, "utf8");
  const cleanupRoute = source.slice(source.indexOf('router.post("/media/cleanup"'));

  assert.ok(source.includes('import { startJob } from "../lib/library-engine";'));
  assert.ok(cleanupRoute.includes('jobType: "METADATA"'));
  assert.ok(cleanupRoute.includes('profile: "HEALTH_SCAN"'));
  assert.ok(cleanupRoute.includes("metadataJob.errorCode"));
  assert.ok(cleanupRoute.includes('existing?.jobType !== "METADATA" || existing.status !== "RUNNING"'));
  assert.ok(cleanupRoute.includes("Metadata refresh job #"));
  assert.ok(!cleanupRoute.includes("Metadata rebuild is queued for the next library scan."));

  const releasedTemporaryClaim = cleanupRoute.indexOf('status: "DONE"');
  const metadataStart = cleanupRoute.indexOf("const metadataJob = await startJob");
  assert.ok(releasedTemporaryClaim >= 0 && metadataStart > releasedTemporaryClaim);
});

test("missing-media cleanup rechecks the source and skips a file restored after inspection", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-health-restored-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "restored.jpg");

  // Model the original inspection finding followed by a restore before cleanup.
  assert.equal(isMissingRegularMediaFile(source), true);
  fs.writeFileSync(source, "restored media");

  let updateCalled = false;
  const result = await softDeleteMissingMediaRecord(source, async () => {
    updateCalled = true;
    return true;
  });

  assert.equal(result, "reappeared");
  assert.equal(updateCalled, false);
});

test("missing-media cleanup marks only a still-missing active record and preserves changed rows", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-health-soft-delete-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "missing.jpg");

  let updates = 0;
  const result = await softDeleteMissingMediaRecord(source, async () => {
    updates++;
    return true;
  });
  assert.equal(result, "marked_deleted");
  assert.equal(updates, 1);

  const changed = await softDeleteMissingMediaRecord(source, async () => false);
  assert.equal(changed, "record_changed");
});

test("Health Center reports thumbnail and face-crop failures as partial cleanup instead of success", () => {
  const routePath = fileURLToPath(new URL("../routes/media-health.ts", import.meta.url));
  const source = readFileSync(routePath, "utf8");
  const cleanupRoute = source.slice(source.indexOf('router.post("/media/cleanup"'));

  assert.match(cleanupRoute, /let failedItems = 0/);
  assert.match(cleanupRoute, /faceCropFailures = cleaned\.cropErrors\.length/);
  assert.match(cleanupRoute, /failedItems \+= faceCropFailures/);
  assert.match(cleanupRoute, /thumbnailFailures\+\+/);
  assert.match(cleanupRoute, /status: partial \? "FAILED" : "DONE"/);
  assert.match(cleanupRoute, /ok: !partial/);
  assert.match(cleanupRoute, /partial,/);
  assert.match(cleanupRoute, /failedItems,/);
  assert.match(cleanupRoute, /metadataJobId !== null \? \{ metadataJobId \} : \{\}/);
});

test("Health Center rejects empty or unsupported cleanup actions before opening an event stream or creating a job", () => {
  const routePath = fileURLToPath(new URL("../routes/media-health.ts", import.meta.url));
  const source = readFileSync(routePath, "utf8");
  const cleanupRoute = source.slice(source.indexOf('router.post("/media/cleanup"'));

  const validationEnd = cleanupRoute.indexOf('const nasPath =');
  const streamStart = cleanupRoute.indexOf('res.writeHead(200');
  const jobInsert = cleanupRoute.indexOf("await db.insert(libraryJobsTable)");
  assert.ok(validationEnd > 0 && streamStart > validationEnd && jobInsert > streamStart);
  const validation = cleanupRoute.slice(0, validationEnd);
  assert.match(validation, /!Array\.isArray\(requested\)/);
  assert.match(validation, /requested\.length === 0/);
  assert.match(validation, /requested\.some\(/);
  assert.match(validation, /return res\.status\(400\)\.json/);
  assert.match(validation, /const actions = \[\.\.\.new Set\(requested as string\[\]\)\]/);
});

test("Health Center cleanup progress counts only selected work and excludes skipped folders", () => {
  const routePath = fileURLToPath(new URL("../routes/media-health.ts", import.meta.url));
  const source = readFileSync(routePath, "utf8");
  const cleanupRoute = source.slice(source.indexOf('router.post("/media/cleanup"'));

  assert.match(cleanupRoute, /actions\.includes\("orphanedRecords"\) \? inspected\.missing\.length : 0/);
  assert.match(cleanupRoute, /actions\.includes\("orphanedThumbnails"\) \? inspected\.orphanThumbs\.length : 0/);
  assert.match(cleanupRoute, /thumbnailTargets\.length/);
  assert.match(cleanupRoute, /actions\.includes\("emptyFolders"\) \? emptyFolderTargets\.length : 0/);
  assert.match(cleanupRoute, /emptyFolderTargets = inspected\.emptyFolders\.filter/);
  assert.match(cleanupRoute, /total \+= cleaned\.staleCropsRemoved \+ cleaned\.cropErrors\.length/);
  assert.doesNotMatch(cleanupRoute, /const total = Math\.max\(1, inspected\.missing\.length \+ inspected\.orphanThumbs\.length \+ inspected\.missingThumbs\.length \+ inspected\.emptyFolders\.length\)/);
});

test("Health Center orphan cleanup uses reversible conditional soft-delete and preserves derived data", () => {
  const routePath = fileURLToPath(new URL("../routes/media-health.ts", import.meta.url));
  const enginePath = fileURLToPath(new URL("../lib/library-engine/job-engine.ts", import.meta.url));
  const route = readFileSync(routePath, "utf8");
  const engine = readFileSync(enginePath, "utf8");
  const start = route.indexOf('if (actions.includes("orphanedRecords"))');
  const end = route.indexOf('if (actions.includes("orphanedDerivedData"))', start);
  const cleanup = route.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(cleanup, /softDeleteMissingMediaRecord\(source/);
  assert.match(cleanup, /lastScanAction: "DELETED"/);
  assert.match(cleanup, /eq\(mediaFilesTable\.relativePath, row\.relativePath\)/);
  assert.match(cleanup, /ACTIVE/);
  assert.doesNotMatch(cleanup, /db\.delete\(mediaFilesTable\)|purgeDerivedDataForMedia/);
  assert.match(engine, /lastScanAction:[\s\S]*excluded\.last_scan_action/);
});
