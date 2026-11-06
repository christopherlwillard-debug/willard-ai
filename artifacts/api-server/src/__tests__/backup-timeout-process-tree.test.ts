import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const sourcePath = path.resolve(import.meta.dirname, "../lib/backup-coordinator.ts");

test("backup timeout terminates the complete process tree on supported platforms", () => {
  const source = fs.readFileSync(sourcePath, "utf8");
  assert.match(source, /function terminateBackupProcessTree\(child: ChildProcess\)/);
  assert.match(source, /execFile\("taskkill\.exe", \["\/PID", String\(child\.pid\), "\/T", "\/F"\]/);
  assert.match(source, /process\.kill\(-child\.pid, "SIGTERM"\)/);
  assert.match(source, /process\.kill\(-child\.pid!, "SIGKILL"\)/);
  assert.match(source, /detached: process\.platform !== "win32"/);
  assert.match(source, /await closed/);
  assert.match(source, /if \(taskkillError\)[\s\S]*?child\.kill\("SIGKILL"\)/);
  assert.match(source, /Windows taskkill could not terminate the backup process tree/);
  assert.match(source, /timedOut = true/);
  assert.match(source, /Backup exceeded its 30-minute time limit/);
});

test("backup process diagnostics are bounded and startup errors clear timeout state", () => {
  const source = fs.readFileSync(sourcePath, "utf8");
  assert.match(source, /const OUTPUT_TAIL_LIMIT = 8_192/);
  assert.match(source, /\.slice\(-OUTPUT_TAIL_LIMIT\)/);
  assert.match(source, /const cleanup = \(\): void => \{[\s\S]*?clearTimeout\(timeout\)/);
  assert.match(source, /child\.once\("error", \(error\) => \{[\s\S]*?cleanup\(\)/);
});
