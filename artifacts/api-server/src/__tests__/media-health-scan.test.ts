import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isMissingFilesystemEntry, isMissingRegularMediaFile } from "../lib/media-health-scan.ts";
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
