import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const testDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "src", "__tests__");
const testFiles = readdirSync(testDirectory)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => path.join(testDirectory, name));

for (const testFile of testFiles) {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      "--experimental-strip-types",
      "--test",
      "--test-concurrency=1",
      testFile,
    ],
    { env: process.env, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}