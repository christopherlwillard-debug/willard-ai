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
delete testEnvironment.REPLIT_DEV_DOMAIN;
delete testEnvironment.REPLIT_DOMAINS;
delete testEnvironment.REPL_ID;
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
const availableTestFiles = [...apiTestFiles, ...integrationTestFiles];
const auditTestFilter = process.env.WILLARD_AUDIT_TEST_FILTER?.trim();
if (
  auditTestFilter
  && (
    path.basename(auditTestFilter) !== auditTestFilter
    || !auditTestFilter.endsWith(".test.ts")
  )
) {
  throw new Error("WILLARD_AUDIT_TEST_FILTER must be one test file name.");
}
const testFiles = auditTestFilter
  ? availableTestFiles.filter((file) => path.basename(file) === auditTestFilter)
  : availableTestFiles;
if (auditTestFilter && testFiles.length !== 1) {
  throw new Error(`[backend-audit] Requested test file was not found in this platform's audit set: ${auditTestFilter}`);
}

if (process.platform === "win32") {
  console.log(
    `[backend-audit] SKIP ${path.basename(cleanupIntegrationTest)} ` +
      "(Linux .Trash and GNU archive fixture assertions)",
  );
}

const timeoutMs = Number(process.env.WILLARD_AUDIT_TEST_TIMEOUT_MS ?? 300_000);
const heartbeatMs = Number(process.env.WILLARD_AUDIT_HEARTBEAT_MS ?? 30_000);
const processStopGraceMs = 5_000;

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
        detached: process.platform !== "win32",
        stdio: "inherit",
        windowsHide: false,
      },
    );
    let settled = false;
    let timedOut = false;
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
    const timeout = setTimeout(async () => {
      if (settled) return;
      timedOut = true;
      console.error(
        `[backend-audit] TIMEOUT ${name} afterMs=${Date.now() - startedAt}`,
      );
      try {
        await terminateTestProcess(child);
      } catch (error) {
        console.error(
          `[backend-audit] Could not stop timed-out test process ${name}: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
      finish({ code: 124, timedOut: true });
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timeout);
      if (settled || timedOut) return;
      settled = true;
      clearInterval(heartbeat);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (timedOut) return;
      clearTimeout(timeout);
      finish({ code: code ?? 1, signal, timedOut: false });
    });
  });
}

function waitForProcessExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      child.off("exit", onExit);
      reject(error);
    };
    const onExit = () => {
      child.off("error", onError);
      resolve();
    };
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function spawnAndWait(command, args) {
  const process = spawn(command, args, {
    stdio: "ignore",
    windowsHide: true,
  });
  return waitForProcessExit(process).then(() => {
    if (process.exitCode !== 0) {
      throw new Error(`${command} exited with code ${process.exitCode ?? process.signalCode ?? "unknown"}.`);
    }
  });
}

async function terminateTestProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = waitForProcessExit(child);

  if (process.platform === "win32" && child.pid) {
    try {
      await spawnAndWait("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
    } catch {
      child.kill("SIGKILL");
    }
  } else {
    const signalGroup = (signal) => {
      if (!child.pid) {
        child.kill(signal);
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    };
    signalGroup("SIGTERM");
    const deadline = Date.now() + processStopGraceMs;
    while (Date.now() < deadline) {
      try {
        process.kill(-child.pid, 0);
      } catch (error) {
        if (error?.code === "ESRCH") return;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    signalGroup("SIGKILL");
  }

  await exit;
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
