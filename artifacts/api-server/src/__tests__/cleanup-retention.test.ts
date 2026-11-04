import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isTrashEntryExpired } from "../lib/cleanup-retention.ts";

test("trash retention fails closed when expiration metadata is missing or malformed", () => {
  const now = Date.parse("2026-11-04T12:00:00.000Z");
  assert.equal(isTrashEntryExpired(undefined, now), false);
  assert.equal(isTrashEntryExpired("", now), false);
  assert.equal(isTrashEntryExpired("not-a-date", now), false);
  assert.equal(isTrashEntryExpired("2026-11-04T13:00:00.000Z", now), false);
  assert.equal(isTrashEntryExpired("2026-11-04T11:59:59.000Z", now), true);
});

test("manual restore and startup recovery use no-replace moves", () => {
  const sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cleanupRoute = fs.readFileSync(path.join(sourceDir, "routes", "cleanup.ts"), "utf8");
  const recoverySource = fs.readFileSync(path.join(sourceDir, "lib", "cleanup-recovery.ts"), "utf8");
  assert.match(cleanupRoute, /moveFileNoReplace\(resolvedTrashPath, resolvedOriginalPath\)/);
  assert.match(cleanupRoute, /ensureDirectoryWithinRoot\(/);
  assert.match(cleanupRoute, /moveFileNoReplace\(filePath, trashPath\)/);
  assert.match(cleanupRoute, /moveFileNoReplace\(resolvedOriginalPath, resolvedTrashPath\)/);
  assert.match(recoverySource, /moveFileNoReplace\(sourceTrash, destination\)/);
});
