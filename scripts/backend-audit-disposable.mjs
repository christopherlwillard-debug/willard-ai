import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  closeSync,
  existsSync,
  openSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiDirectory = path.join(workspaceRoot, "artifacts", "api-server");
const testArgument = process.argv[2];
const auditTestFilter = testArgument === "--test" ? process.argv[3] : undefined;
if (
  (testArgument !== undefined && testArgument !== "--test")
  || (testArgument === "--test" && (
    !auditTestFilter
    || process.argv.length !== 4
    || path.basename(auditTestFilter) !== auditTestFilter
    || !auditTestFilter.endsWith(".test.ts")
  ))
  || (testArgument === undefined && process.argv.length !== 2)
) {
  throw new Error("Usage: node scripts/backend-audit-disposable.mjs [--test <test-file.test.ts>]");
}
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "willard-backend-audit-"));
const databaseDirectory = path.join(tempRoot, "postgres");
const libraryDirectory = path.join(tempRoot, "library");

function findExecutable(name) {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Required local test executable was not found: ${name}`);
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? workspaceRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.stdio ?? "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} failed with exit code ${result.status ?? 1}.`);
  }
  return result;
}

async function allocatePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate a local test port.");
  }
  const { port } = address;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForApi(apiUrl, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("The isolated API server exited during startup.");
    }
    try {
      const response = await fetch(`${apiUrl}/api/auth/status`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The local server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("The isolated API server did not become ready within 20 seconds.");
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exit = waitForChildExit(child);
  child.kill("SIGTERM");
  let timeoutHandle;
  const exitedGracefully = await Promise.race([
    exit.then(() => true),
    new Promise((resolve) => {
      timeoutHandle = setTimeout(() => resolve(false), 5_000);
    }),
  ]);
  clearTimeout(timeoutHandle);
  if (!exitedGracefully) {
    child.kill("SIGKILL");
    await exit;
  }
}

function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      child.off("exit", onExit);
      reject(error);
    };
    const onExit = (code, signal) => {
      child.off("error", onError);
      resolve({ code, signal });
    };
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function postgresIsRunning(pgCtl, directory) {
  const result = spawnSync(pgCtl, ["--pgdata", directory, "status"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status === 3 || /no server running/i.test(output)) return false;
  throw new Error("Could not determine whether disposable PostgreSQL is still running.");
}

function removeAuditTempRoot(directory) {
  if (!directory) throw new Error("Refusing to remove an empty backend-audit path.");
  const resolvedTemp = path.resolve(directory);
  const resolvedOsTemp = path.resolve(os.tmpdir());
  if (
    path.dirname(resolvedTemp) !== resolvedOsTemp
    || !path.basename(resolvedTemp).startsWith("willard-backend-audit-")
  ) {
    throw new Error("Refusing to remove a backend-audit directory outside its approved temporary root.");
  }
  const stat = lstatSync(resolvedTemp);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Refusing to remove a backend-audit path that is not an owned directory.");
  }
  const realTemp = realpathSync(resolvedTemp);
  if (
    path.dirname(realTemp) !== realpathSync(resolvedOsTemp)
    || !path.basename(realTemp).startsWith("willard-backend-audit-")
  ) {
    throw new Error("Refusing to remove a backend-audit directory that escaped its approved temporary root.");
  }
  rmSync(realTemp, { recursive: true, force: false });
}

async function tryCleanup(name, action, errors) {
  try {
    await action();
    return true;
  } catch (error) {
    errors.push(new Error(`${name} cleanup failed.`, { cause: error }));
    return false;
  }
}

let pgCtl;
let postgresStarted = false;
let apiProcess;
let auditProcess;
let apiLogFd;
let testExitCode = 1;

try {
  mkdirSync(libraryDirectory, { recursive: true });
  const initdb = findExecutable("initdb");
  pgCtl = findExecutable("pg_ctl");
  const createdb = findExecutable("createdb");
  const psql = findExecutable("psql");
  const postgresPort = await allocatePort();
  const apiPort = await allocatePort();
  const databaseName = "willard_audit";
  const databaseUser = os.userInfo().username;
  const databaseUrl = `postgresql://${encodeURIComponent(databaseUser)}@127.0.0.1:${postgresPort}/${databaseName}`;

  runSync(initdb, [
    "--pgdata", databaseDirectory,
    "--auth-local=trust",
    "--auth-host=trust",
    "--no-instructions",
  ]);
  runSync(pgCtl, [
    "--pgdata", databaseDirectory,
    "--log", path.join(tempRoot, "postgres.log"),
    "--options", `-h 127.0.0.1 -p ${postgresPort} -k ${tempRoot}`,
    "--wait",
    "start",
  ]);
  postgresStarted = true;
  runSync(createdb, [
    "--host", "127.0.0.1",
    "--port", String(postgresPort),
    "--username", databaseUser,
    databaseName,
  ]);

  runSync(process.execPath, [path.join(workspaceRoot, "setup-db.cjs")], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  runSync("pnpm", ["--filter", "@workspace/api-server", "run", "build"]);

  const apiUrl = `http://127.0.0.1:${apiPort}`;
  apiLogFd = openSync(path.join(tempRoot, "api-server.log"), "a");
  const apiEnvironment = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    HOST: "127.0.0.1",
    PORT: String(apiPort),
    SESSION_SECRET: randomBytes(32).toString("hex"),
    WILLARD_LOCAL_SETUP: "true",
    WILLARD_NAS_SAFETY_MARGIN_BYTES: "0",
  };
  delete apiEnvironment.REPL_ID;
  apiProcess = spawn(process.execPath, ["--enable-source-maps", "./dist/index.mjs"], {
    cwd: apiDirectory,
    env: apiEnvironment,
    stdio: ["ignore", apiLogFd, apiLogFd],
    windowsHide: true,
  });
  await waitForApi(apiUrl, apiProcess);

  const setupResponse = await fetch(`${apiUrl}/api/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "willard123" }),
  });
  if (!setupResponse.ok) {
    throw new Error(`Could not initialize the isolated test administrator (HTTP ${setupResponse.status}).`);
  }
  await setupResponse.arrayBuffer();

  const escapedLibraryPath = libraryDirectory.replaceAll("'", "''");
  runSync(psql, [
    "--dbname", databaseUrl,
    "--set=ON_ERROR_STOP=1",
    "--command", `UPDATE app_settings SET nas_path = '${escapedLibraryPath}'`,
  ]);

  const auditEnvironment = {
    ...process.env,
    WILLARD_AUDIT_API_URL: apiUrl,
    WILLARD_AUDIT_DATABASE_IS_DISPOSABLE: "1",
    WILLARD_AUDIT_DATABASE_URL: databaseUrl,
    WILLARD_TEST_ROOT: tempRoot,
  };
  delete auditEnvironment.WILLARD_AUDIT_TEST_FILTER;
  if (auditTestFilter) auditEnvironment.WILLARD_AUDIT_TEST_FILTER = auditTestFilter;
  const audit = spawn("pnpm", ["--filter", "@workspace/api-server", "run", "audit"], {
    cwd: workspaceRoot,
    env: auditEnvironment,
    stdio: "inherit",
    windowsHide: true,
  });
  auditProcess = audit;
  const { code, signal } = await waitForChildExit(audit);
  testExitCode = code ?? (signal ? 1 : 0);
} catch (error) {
  console.error(`[backend-audit] ${error instanceof Error ? error.message : String(error)}`);
  testExitCode = 1;
} finally {
  const cleanupErrors = [];
  const auditStopped = await tryCleanup("Audit test runner", () => stopProcess(auditProcess), cleanupErrors);
  const apiStopped = await tryCleanup("Isolated API server", () => stopProcess(apiProcess), cleanupErrors);
  if (apiLogFd !== undefined) {
    const fd = apiLogFd;
    apiLogFd = undefined;
    await tryCleanup("API server log descriptor", () => closeSync(fd), cleanupErrors);
    if (testExitCode !== 0) {
      await tryCleanup("API server diagnostics", async () => {
        const lines = readFileSync(path.join(tempRoot, "api-server.log"), "utf8").trim().split("\n");
        if (lines.length > 0 && lines[0]) {
          console.error("[backend-audit] Isolated API server log tail:");
          console.error(lines.slice(-60).join("\n"));
        }
      }, cleanupErrors);
    }
    apiLogFd = undefined;
  }

  let postgresStopped = true;
  if (pgCtl && existsSync(databaseDirectory)) {
    try {
      if (postgresStarted || postgresIsRunning(pgCtl, databaseDirectory)) {
        try {
          runSync(pgCtl, ["--pgdata", databaseDirectory, "--mode", "fast", "--wait", "stop"]);
        } catch (error) {
          if (postgresIsRunning(pgCtl, databaseDirectory)) throw error;
        }
      }
      postgresStopped = !postgresIsRunning(pgCtl, databaseDirectory);
    } catch (error) {
      postgresStopped = false;
      cleanupErrors.push(new Error("Could not verify that disposable PostgreSQL stopped cleanly.", { cause: error }));
    }
  }
  if (postgresStopped && auditStopped && apiStopped) {
    await tryCleanup("Disposable audit files", () => removeAuditTempRoot(tempRoot), cleanupErrors);
  } else {
    console.error(`[backend-audit] Preserving ${tempRoot} because PostgreSQL may still be running.`);
  }
  for (const error of cleanupErrors) {
    console.error(`[backend-audit] ${error.message}`);
    if (error.cause instanceof Error) console.error(`  ${error.cause.message}`);
  }
  if (cleanupErrors.length > 0 || !postgresStopped) testExitCode = 1;
}

process.exitCode = testExitCode;
