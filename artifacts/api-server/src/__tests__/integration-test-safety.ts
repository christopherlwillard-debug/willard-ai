import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

function parseLocalUrl(value: string, protocols: Set<string>, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid local URL.`);
  }

  if (!protocols.has(parsed.protocol) || !LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(`${label} must target a local service.`);
  }
  return parsed;
}

export function requireDisposableAuditApiUrl(): string {
  const apiValue = process.env["WILLARD_API_URL"]?.trim();
  if (!apiValue) {
    throw new Error(
      "WILLARD_API_URL is required for integration tests. Run `pnpm run audit:backend` to use the disposable API and database.",
    );
  }
  if (process.env["WILLARD_AUDIT_DATABASE_IS_DISPOSABLE"] !== "1") {
    throw new Error(
      "These integration tests require the disposable backend-audit environment; run `pnpm run audit:backend`.",
    );
  }

  const apiUrl = parseLocalUrl(apiValue, new Set(["http:"]), "WILLARD_API_URL");
  if (apiUrl.pathname !== "/" || apiUrl.search || apiUrl.hash || apiUrl.username || apiUrl.password) {
    throw new Error("WILLARD_API_URL must be a local HTTP origin without credentials, path, query, or fragment.");
  }

  const auditApiValue = process.env["WILLARD_AUDIT_API_URL"]?.trim();
  if (!auditApiValue) {
    throw new Error("WILLARD_AUDIT_API_URL is required by the disposable backend-audit environment.");
  }
  const auditApiUrl = parseLocalUrl(auditApiValue, new Set(["http:"]), "WILLARD_AUDIT_API_URL");
  if (apiUrl.origin !== auditApiUrl.origin) {
    throw new Error("WILLARD_API_URL must match the disposable audit API origin.");
  }

  const databaseValue = process.env["DATABASE_URL"]?.trim();
  const auditDatabaseValue = process.env["WILLARD_AUDIT_DATABASE_URL"]?.trim();
  if (!databaseValue || !auditDatabaseValue) {
    throw new Error("The disposable audit database URL is not configured.");
  }
  const databaseUrl = parseLocalUrl(
    databaseValue,
    new Set(["postgres:", "postgresql:"]),
    "DATABASE_URL",
  );
  const auditDatabaseUrl = parseLocalUrl(
    auditDatabaseValue,
    new Set(["postgres:", "postgresql:"]),
    "WILLARD_AUDIT_DATABASE_URL",
  );
  if (databaseUrl.href !== auditDatabaseUrl.href) {
    throw new Error("Database tests and the API must use the same disposable PostgreSQL database.");
  }

  return apiUrl.origin;
}

export function requireDisposableTestRoot(): string {
  const value = process.env["WILLARD_TEST_ROOT"]?.trim();
  if (!value) {
    throw new Error("WILLARD_TEST_ROOT is required for integration-test fixtures.");
  }

  const resolved = path.resolve(value);
  const basename = path.basename(resolved);
  if (!basename.startsWith("willard-backend-audit-")) {
    throw new Error("WILLARD_TEST_ROOT must be an owned backend-audit temporary directory.");
  }

  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("WILLARD_TEST_ROOT must be a real directory, not a symlink.");
  }

  const expectedParent = fs.realpathSync(os.tmpdir());
  const realPath = fs.realpathSync(resolved);
  if (
    fs.realpathSync(path.dirname(resolved)) !== expectedParent
    || path.dirname(realPath) !== expectedParent
    || !path.basename(realPath).startsWith("willard-backend-audit-")
  ) {
    throw new Error("WILLARD_TEST_ROOT must resolve directly inside the operating-system temporary directory.");
  }
  return realPath;
}

export async function runCleanupSteps(
  label: string,
  steps: Array<{ name: string; run: () => void | Promise<void> }>,
): Promise<void> {
  const errors: Error[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (cause) {
      errors.push(new Error(`${label}: ${step.name} cleanup failed.`, { cause }));
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `${label} cleanup had ${errors.length} failure(s).`);
  }
}

export function removeOwnedTempDirectory(
  targetPath: string,
  approvedParent: string,
  requiredPrefix: string,
): void {
  if (!targetPath || !approvedParent || !requiredPrefix) {
    throw new Error("Temporary directory cleanup requires a path, approved parent, and ownership prefix.");
  }

  const resolvedParent = path.resolve(approvedParent);
  const resolvedTarget = path.resolve(targetPath);
  if (
    path.dirname(resolvedTarget) !== resolvedParent ||
    !path.basename(resolvedTarget).startsWith(requiredPrefix)
  ) {
    throw new Error("Refusing to remove a temporary directory outside its approved parent or ownership prefix.");
  }

  const targetStat = fs.lstatSync(resolvedTarget);
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    throw new Error("Refusing to remove a temporary path that is not an owned real directory.");
  }

  const realParent = fs.realpathSync(resolvedParent);
  const realTarget = fs.realpathSync(resolvedTarget);
  if (path.dirname(realTarget) !== realParent || !path.basename(realTarget).startsWith(requiredPrefix)) {
    throw new Error("Refusing to remove a temporary directory whose resolved path escaped its approved parent.");
  }
  fs.rmSync(realTarget, { recursive: true, force: false });
}
