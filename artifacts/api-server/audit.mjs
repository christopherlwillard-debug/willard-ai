import { readdirSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const apiServerDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = path.resolve(apiServerDirectory, "../..");
const testDirectory = path.join(apiServerDirectory, "src", "__tests__");
const auditDatabaseUrl = process.env.WILLARD_AUDIT_DATABASE_URL?.trim();
const auditApiUrlValue = process.env.WILLARD_AUDIT_API_URL?.trim();

if (process.env.WILLARD_AUDIT_DATABASE_IS_DISPOSABLE !== "1" || !auditDatabaseUrl || !auditApiUrlValue) {
  throw new Error(
    "[backend-audit] Refusing to use the app database. Run the disposable audit wrapper or provide an isolated local database and API URL.",
  );
}

const auditDatabase = new URL(auditDatabaseUrl);
const auditApiUrl = new URL(auditApiUrlValue);
const localHosts = new Set(["localhost", "127.0.0.1"]);
if (!["postgres:", "postgresql:"].includes(auditDatabase.protocol) || !localHosts.has(auditDatabase.hostname)) {
  throw new Error("[backend-audit] The audit database must be a local PostgreSQL instance.");
}
if (auditApiUrl.protocol !== "http:" || !localHosts.has(auditApiUrl.hostname)) {
  throw new Error("[backend-audit] The audit API must be an explicitly configured local HTTP service.");
}

const testEnvironment = {
  ...process.env,
  DATABASE_URL: auditDatabaseUrl,
  WILLARD_API_URL: auditApiUrl.origin,
};
const apiTestFiles = readdirSync(testDirectory)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => path.join(testDirectory, name));
const cleanupIntegrationTest = path.join(
  workspaceDirectory,
  "e2e",
  "cleanup-execute.test.ts",
);
const integrationTestFiles = [
  // This suite intentionally exercises Linux .Trash behavior and creates
  // hostile archive fixtures with GNU tar/zip options. Windows cleanup uses
  // the Recycle Bin and is validated by the Windows lifecycle smoke test.
  ...(process.platform === "win32" ? [] : [cleanupIntegrationTest]),
  path.join(workspaceDirectory, "e2e", "dashboard-after-scan.test.ts"),
];
const testFiles = [...apiTestFiles, ...integrationTestFiles];

if (process.platform === "win32") {
  console.log(
    `[backend-audit] SKIP ${path.basename(cleanupIntegrationTest)} ` +
      "(Linux .Trash and GNU archive fixture assertions)",
  );
}

const timeoutMs = Number(process.env.WILLARD_AUDIT_TEST_TIMEOUT_MS ?? 300_000);
const heartbeatMs = Number(process.env.WILLARD_AUDIT_HEARTBEAT_MS ?? 30_000);

if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error("WILLARD_AUDIT_TEST_TIMEOUT_MS must be a positive number.");
}
if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) {
  throw new Error("WILLARD_AUDIT_HEARTBEAT_MS must be a positive number.");
}

function runTestFile(testFile) {
  const name = path.basename(testFile);
  const startedAt = Date.now();
  const testWorkingDirectory = integrationTestFiles.includes(testFile)
    ? workspaceDirectory
    : apiServerDirectory;
  console.log(`[backend-audit] START ${name}`);

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-test-module-mocks",
        "--experimental-strip-types",
        "--test",
        "--test-concurrency=1",
        testFile,
      ],
      {
        cwd: testWorkingDirectory,
        env: testEnvironment,
        stdio: "inherit",
        windowsHide: false,
      },
    );
    let settled = false;
    const heartbeat = setInterval(() => {
      console.log(
        `[backend-audit] HEARTBEAT ${name} elapsedMs=${Date.now() - startedAt}`,
      );
    }, heartbeatMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      console.error(
        `[backend-audit] TIMEOUT ${name} afterMs=${Date.now() - startedAt}`,
      );
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "inherit",
          windowsHide: true,
        });
      } else {
        child.kill("SIGTERM");
      }
      finish({ code: 124, timedOut: true });
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      finish({ code: code ?? 1, signal, timedOut: false });
    });
  });
}

for (const testFile of testFiles) {
  const result = await runTestFile(testFile);
  if (result.timedOut) {
    console.error(
      `[backend-audit] FAILED ${path.basename(testFile)} reason=timeout`,
    );
    process.exit(124);
  }
  if (result.code !== 0) {
    console.error(
      `[backend-audit] FAILED ${path.basename(testFile)} exitCode=${result.code} signal=${result.signal ?? "none"}`,
    );
    process.exit(result.code);
  }
  console.log(`[backend-audit] PASS ${path.basename(testFile)}`);
}
