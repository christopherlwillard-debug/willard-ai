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


const jpegStart = source.indexOf("async function analyzeJpegFile(");
const jpegEnd = source.indexOf("\n}", jpegStart);
const jpegAnalyzer = source.slice(jpegStart, jpegEnd < 0 ? source.length : jpegEnd);

test("JPEG analysis failures are recorded as failed, never as already optimal", () => {
  assert.ok(jpegStart >= 0 && jpegEnd > jpegStart, "JPEG analyzer should be present");
  assert.match(jpegAnalyzer, /catch \(error\)/);
  assert.match(jpegAnalyzer, /Unable to analyze JPEG/);
  assert.doesNotMatch(jpegAnalyzer, /catch \{\s*return \[\];\s*\}/);
  assert.doesNotMatch(jpegAnalyzer, /catch \{\s*return 0;\s*\}/);

  const executeStart = source.indexOf('router.get("/optimize/jobs/:id/execute"');
  const executeEnd = source.indexOf("\nrouter.", executeStart + 1);
  const executeRoute = source.slice(executeStart, executeEnd < 0 ? source.length : executeEnd);
  const analysisStart = executeRoute.indexOf("let jpegIssues: string[];");
  const analysisEnd = executeRoute.indexOf("if (jpegIssues.length === 0)", analysisStart);
  const analysisBlock = executeRoute.slice(analysisStart, analysisEnd);
  assert.ok(analysisStart >= 0 && analysisEnd > analysisStart, "on-demand JPEG analysis should be present");
  assert.match(analysisBlock, /catch \(error\)/);
  assert.match(analysisBlock, /status: "failed"/);
  assert.match(analysisBlock, /failedFiles: failed/);
  assert.match(analysisBlock, /continue;/);
});


const executeSourceStart = source.indexOf('router.get("/optimize/jobs/:id/execute"');
const executeSourceEnd = source.indexOf("\nrouter.", executeSourceStart + 1);
const executeSource = source.slice(executeSourceStart, executeSourceEnd < 0 ? source.length : executeSourceEnd);
const finalizeStart = source.indexOf("async function finalizeHandlerImpl(");
const finalizeEnd = source.indexOf("\n}", finalizeStart);
const finalizeSource = source.slice(finalizeStart, finalizeEnd < 0 ? source.length : finalizeEnd);

test("conversion staging and finalization paths stay inside the active NAS root", () => {
  assert.match(executeSource, /ensureDirectoryWithinRoot\(\s*path\.join\(getWillardAIDir\(nasPath\), "conversions", String\(id\)\),\s*nasPath/);
  assert.match(executeSource, /ensureDirectoryWithinRoot\(stagedDir, nasPath\)/);
  assert.doesNotMatch(executeSource, /fs\.mkdirSync\(stagingDir/);
  assert.doesNotMatch(executeSource, /fs\.mkdirSync\(stagedDir/);

  assert.match(finalizeSource, /assertWithinRoot\(resultData\.stagingDir, nasPath\)/);
  assert.match(finalizeSource, /assertWithinRoot\(originalPath, nasPath\)/);
  assert.match(finalizeSource, /assertWithinRoot\(stagedPath, nasPath\)/);
  assert.match(finalizeSource, /assertWithinRoot\(convertedPath, nasPath\)/);
  assert.match(finalizeSource, /assertWithinRoot\(trashPath, nasPath\)/);
  assert.match(finalizeSource, /assertWithinRoot\(keepBothPath, nasPath\)/);
  assert.match(finalizeSource, /assertWithinRoot\(archivePath, nasPath\)/);
});


const scanStart = source.indexOf('router.get("/optimize/scan"');
const pngScanStart = source.indexOf('      if (ext === "png") {', scanStart);
const pngScanEnd = source.indexOf('      if (ext === "mov" || ext === "mkv"', pngScanStart);
const pngScan = source.slice(pngScanStart, pngScanEnd);

test("PNG scan analyzes every tracked file in bounded batches and protects unknown entries", () => {
  assert.ok(pngScanStart >= 0 && pngScanEnd > pngScanStart, "PNG scan analysis should be present");
  assert.match(pngScan, /PNG_ANALYZE_BATCH_SIZE = 16/);
  assert.match(pngScan, /paths\.slice\(offset, offset \+ PNG_ANALYZE_BATCH_SIZE\)/);
  assert.doesNotMatch(pngScan, /paths\.slice\(0, JPEG_ANALYZE_LIMIT\)/);
  assert.match(pngScan, /fileDecisions\[p\] = \{ convert: decision\.convert, targetExt: "jpg", reasons: \[decision\.reason\] \}/);
  assert.match(pngScan, /count > paths\.length/);
  assert.match(pngScan, /convert: false/);
});

test("PNG conversion rechecks metadata immediately before encoding and fails closed", () => {
  const pngCheckStart = executeRoute.indexOf('if (ext === "png")');
  const pngCheckEnd = executeRoute.indexOf("// Resolve target extension", pngCheckStart);
  const pngCheck = executeRoute.slice(pngCheckStart, pngCheckEnd);
  assert.ok(pngCheckStart >= 0 && pngCheckEnd > pngCheckStart, "PNG execute-time check should be present");
  assert.match(pngCheck, /analyzePngFile\(fullPath\)/);
  assert.match(pngCheck, /catch \(error\)/);
  assert.match(pngCheck, /status: "failed"/);
  assert.match(pngCheck, /if \(!pngDecision\.convert\)/);
  assert.match(pngCheck, /status: "skipped"/);
});

test("PNG cache is invalidated and the UI does not describe JPEG conversion as lossless", () => {
  assert.match(source, /const CACHE_VERSION\s*=\s*7/);
  const explainerStart = source.indexOf('if (ext === "png") {', source.indexOf("function buildExplainerText"));
  const explainerEnd = source.indexOf("\n  }", explainerStart);
  const explainer = source.slice(explainerStart, explainerEnd);
  assert.match(explainer, /JPEG is lossy/);
  assert.doesNotMatch(explainer, /losslessly|pixel data is identical/i);
});


const recoveryPath = fileURLToPath(new URL("../lib/conversion-recovery.ts", import.meta.url));
const recoverySource = readFileSync(recoveryPath, "utf8");

test("conversion execution, finalization, and restart recovery share a per-job advisory lock", () => {
  const executeLock = executeRoute.indexOf("acquireConversionJobLock(id");
  const executeClaim = executeRoute.indexOf("const [claimedJob] = await db.update(conversionJobsTable)");
  assert.ok(executeLock >= 0 && executeClaim > executeLock, "execution must own the job before its pending-to-running claim");
  assert.match(executeRoute, /releaseConversionJobLock\(jobLockClient, id\)/);

  assert.ok(finalizeStart >= 0 && finalizeSource.indexOf("acquireConversionJobLock(id") >= 0);
  assert.ok(
    finalizeSource.indexOf("acquireConversionJobLock(id") < finalizeSource.indexOf("getActiveConversionJob(id)"),
    "finalization must acquire ownership before reading and mutating job state",
  );
  assert.match(finalizeSource, /releaseConversionJobLock\(jobLockClient, lockJobId\)/);

  assert.match(recoverySource, /acquireConversionJobLock\(job\.id/);
  assert.match(recoverySource, /eq\(conversionJobsTable\.status, "running"\)/);
  assert.match(recoverySource, /releaseConversionJobLock\(lockClient, job\.id\)/);
});


test("conversion execution does not mark an unclaimed job failed when lock or preflight fails", () => {
  assert.match(executeRoute, /let jobClaimed = false/);
  const claim = executeRoute.indexOf("jobClaimed = true");
  const catchStart = executeRoute.indexOf("} catch (e: any)");
  const catchBlock = executeRoute.slice(catchStart, executeRoute.indexOf("} finally", catchStart));
  assert.ok(claim >= 0 && catchStart > claim, "the claim flag must be set only after the atomic pending-to-running update");
  assert.match(catchBlock, /if \(jobClaimed\)/);
  assert.match(catchBlock, /eq\(conversionJobsTable\.status, "running"\)/);
});
