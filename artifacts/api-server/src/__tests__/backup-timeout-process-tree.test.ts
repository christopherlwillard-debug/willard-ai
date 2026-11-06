import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const sourcePath = path.resolve(import.meta.dirname, "../lib/backup-coordinator.ts");

test("backup timeout terminates the process tree instead of only the direct child", () => {
  const source = fs.readFileSync(sourcePath, "utf8");
  assert.match(source, /function terminateBackupProcessTree\(child: ChildProcess\)/);
  assert.match(source, /const timeout = setTimeout\(\(\) => \{ void terminateBackupProcessTree\(child\); \}, 30 \* 60 \* 1000\)/);
  assert.doesNotMatch(source, /setTimeout\(\(\) => child\.kill\("SIGTERM"\), 30 \* 60 \* 1000\)/);
});
