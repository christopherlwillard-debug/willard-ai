import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";

test("organization preflight uses asynchronous per-filesystem capacity checks and fails closed", () => {
  const source = fs.readFileSync(new URL("../routes/organize.ts", import.meta.url), "utf8");
  assert.equal(source.includes('spawnSync("df"'), false);
  assert.equal(source.includes('import { spawnSync } from "child_process"'), false);

  const start = source.indexOf('router.post("/organize/jobs/:id/preflight"');
  const end = source.indexOf('router.get("/organize/jobs/:id/dry-run"', start);
  assert.ok(start >= 0 && end > start, "preflight route boundaries must exist");
  const route = source.slice(start, end);
  assert.ok(route.includes("await fs.promises.stat(checkDir)"));
  assert.ok(route.includes("await fs.promises.realpath(checkDir)"));
  assert.ok(route.includes("await getDiskFreeBytes(checkDir)"));
  assert.ok(route.includes("free !== null && free >= totalBytes"));
});
