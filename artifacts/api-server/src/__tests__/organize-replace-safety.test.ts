import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("organization Replace collisions fail closed in execute and resume until backups are journaled", () => {
  const sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = fs.readFileSync(path.join(sourceDir, "routes", "organize.ts"), "utf8");
  const replaceBranches = [...source.matchAll(/if \(conflictPolicy === "replace"\) \{([\s\S]*?)\n        \}/g)];
  assert.equal(replaceBranches.length, 2, "both execute and resume must guard Replace collisions");
  for (const branch of replaceBranches) {
    assert.match(branch[1] ?? "", /Replace is temporarily unavailable/);
    assert.match(branch[1] ?? "", /Choose Rename or Keep Existing/);
    assert.doesNotMatch(branch[1] ?? "", /unlinkSync|rmSync|renameSync/);
  }
  assert.doesNotMatch(source, /fs\.unlinkSync\(destFile\)/);
});

test("new organize jobs reject the unsupported Replace policy before creating a job", () => {
  const sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const route = fs.readFileSync(path.join(sourceDir, "routes", "organize.ts"), "utf8");
  const ui = fs.readFileSync(
    path.resolve(sourceDir, "../../willard-ai/src/pages/organize.tsx"),
    "utf8",
  );

  assert.match(route, /if \(conflictPolicy === "replace"\)/);
  assert.match(route, /REPLACE_RECOVERY_UNAVAILABLE/);
  assert.match(route, /Choose Rename or Keep Existing/);
  assert.match(ui, /SelectItem value="replace" disabled/);
});
