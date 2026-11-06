import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import {
  closeSync,
  existsSync,
  openSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiDirectory = path.join(workspaceRoot, "artifacts", "api-server");
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "willard-backend-audit-"));
const databaseDirectory = path.join(tempRoot, "postgres");
const libraryDirectory = path.join(tempRoot, "library");
mkdirSync(libraryDirectory, { recursive: true });

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
    if (child.exitCode !== null) throw new Error("The isolated API server exited during startup.");
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
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

const initdb = findExecutable("initdb");
const pgCtl = findExecutable("pg_ctl");
const createdb = findExecutable("createdb");
const psql = findExecutable("psql");
const postgresPort = await allocatePort();
const apiPort = await allocatePort();
const databaseName = "willard_audit";
const databaseUser = os.userInfo().username;
const databaseUrl = `postgresql://${encodeURIComponent(databaseUser)}@127.0.0.1:${postgresPort}/${databaseName}`;
let postgresStarted = false;
let apiProcess;
let apiLogFd;
let testExitCode = 1;

try {
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
    WILLARD_SCHEMA_READY: "1",
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
  const audit = spawn("pnpm", ["--filter", "@workspace/api-server", "run", "audit"], {
    cwd: workspaceRoot,
    env: auditEnvironment,
    stdio: "inherit",
    windowsHide: true,
  });
  const [code, signal] = await once(audit, "exit");
  testExitCode = code ?? (signal ? 1 : 0);
} catch (error) {
  console.error(`[backend-audit] ${error instanceof Error ? error.message : String(error)}`);
  testExitCode = 1;
} finally {
  await stopProcess(apiProcess);
  if (apiLogFd !== undefined) {
    closeSync(apiLogFd);
    if (testExitCode !== 0) {
      const lines = readFileSync(path.join(tempRoot, "api-server.log"), "utf8").trim().split("\n");
      if (lines.length > 0 && lines[0]) {
        console.error("[backend-audit] Isolated API server log tail:");
        console.error(lines.slice(-60).join("\n"));
      }
    }
  }
  if (postgresStarted) {
    try {
      runSync(pgCtl, ["--pgdata", databaseDirectory, "--mode", "fast", "--wait", "stop"]);
    } catch (error) {
      console.error(`[backend-audit] Could not stop disposable PostgreSQL cleanly: ${error instanceof Error ? error.message : String(error)}`);
      testExitCode = 1;
    }
  }
  rmSync(tempRoot, { recursive: true, force: true });
}

process.exitCode = testExitCode;
