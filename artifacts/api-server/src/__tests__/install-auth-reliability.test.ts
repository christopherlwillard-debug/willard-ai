import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../");
const setupSource = fs.readFileSync(path.join(repoRoot, "setup-db.cjs"), "utf8");
const localSetupSource = fs.readFileSync(path.join(repoRoot, "LOCAL_SETUP.md"), "utf8");
const authSource = fs.readFileSync(
  path.join(repoRoot, "artifacts/api-server/src/routes/auth.ts"),
  "utf8",
);
const indexSource = fs.readFileSync(
  path.join(repoRoot, "artifacts/api-server/src/index.ts"),
  "utf8",
);
const appSource = fs.readFileSync(
  path.join(repoRoot, "artifacts/api-server/src/app.ts"),
  "utf8",
);
const desktopLauncherSource = fs.readFileSync(
  path.join(repoRoot, "desktop/WillardMediaCenter.ps1"),
  "utf8",
);
const developerLauncherSource = fs.readFileSync(
  path.join(repoRoot, "scripts/launcher/start.ps1"),
  "utf8",
);
const viteConfigSource = fs.readFileSync(
  path.join(repoRoot, "artifacts/willard-ai/vite.config.ts"),
  "utf8",
);

test("standalone setup keeps vector columns optional", () => {
  const requiredSql = setupSource
    .slice(setupSource.indexOf("const SETUP_SQL = ["), setupSource.indexOf("const VECTOR_SQL = ["));

  assert.doesNotMatch(requiredSql, /\bvector\s*\(/i);
  assert.match(setupSource, /ALTER TABLE media_ai ADD COLUMN IF NOT EXISTS embedding vector\(384\)/);
  assert.match(setupSource, /ALTER TABLE people ADD COLUMN IF NOT EXISTS centroid vector\(512\)/);
  assert.match(setupSource, /ALTER TABLE faces ADD COLUMN IF NOT EXISTS embedding vector\(512\)/);
});

test("standalone setup rolls back required schema failures", () => {
  assert.match(setupSource, /await client\.query\('BEGIN'\)/);
  assert.match(setupSource, /await client\.query\('COMMIT'\)/);
  assert.match(setupSource, /await client\.query\('ROLLBACK'\)/);
  assert.match(setupSource, /process\.exit\(1\)/);
});

test("first-run setup claims the password row atomically", () => {
  assert.match(
    authSource,
    /and\(eq\(appSettingsTable\.id, settings\.id\), isNull\(appSettingsTable\.passwordHash\)\)/,
  );
  assert.match(authSource, /error\?\.code !== "23505"/);
  assert.match(setupSource, /CREATE UNIQUE INDEX IF NOT EXISTS app_settings_singleton_idx/);
});

test("successful recovery consumes the recovery key transactionally", () => {
  assert.match(authSource, /recovery_key_hash = NULL/);
  assert.match(authSource, /WHERE id = \$2 AND recovery_key_hash = \$3/);
  assert.match(authSource, /const consumed = await updatePasswordAndRevokeSessions/);
  assert.match(authSource, /if \(!consumed\)/);
});

test("password changes and recovery revoke sessions in the same transaction", () => {
  assert.match(authSource, /async function updatePasswordAndRevokeSessions/);
  assert.match(authSource, /await client\.query\("BEGIN"\)/);
  assert.match(authSource, /await client\.query\("DELETE FROM session"\)/);
  assert.match(authSource, /await client\.query\("COMMIT"\)/);
  assert.match(authSource, /await client\.query\("ROLLBACK"\)/);
  assert.match(authSource, /updatePasswordAndRevokeSessions\(\s*settings\.id,[\s\S]*?settings\.recoveryKeyHash,[\s\S]*?true/);
  assert.match(authSource, /updatePasswordAndRevokeSessions\(\s*settings\.id,[\s\S]*?settings\.passwordHash!/);
});

test("interrupted-job recovery is behind the schema startup gate and does not block listening", () => {
  const migration = indexSource.indexOf("const startupMigrations");
  const recovery = indexSource.indexOf("await recoverInterruptedJobs()");
  const listen = indexSource.indexOf("app.listen");

  assert.ok(migration >= 0);
  assert.ok(recovery > migration);
  assert.ok(recovery > listen);
});
test("conversion recovery runs only after schema bootstrap and listener readiness", () => {
  const migration = indexSource.indexOf("const startupMigrations");
  const recovery = indexSource.indexOf("recoverInterruptedConversionJobs()");
  const listen = indexSource.indexOf("app.listen");

  assert.ok(migration >= 0);
  assert.ok(listen > migration);
  assert.ok(recovery > listen, "conversion recovery must not query tables before startup migrations finish");
  assert.doesNotMatch(appSource, /recoverInterruptedConversionJobs\(/);
  assert.match(indexSource, /Conversion recovery did not complete/);
});

test("authentication sessions are created under a lock on the current credential", () => {
  assert.match(authSource, /async function establishSessionForPassword/);
  assert.match(authSource, /req\.session\.save/);
  assert.match(authSource, /persistSessionUnderCredentialLock/);
  assert.match(authSource, /FOR SHARE/);
  assert.equal(authSource.split("await establishSessionForPassword(req,").length - 1, 4);
});


test("desktop API binds only to loopback behind the localhost web proxy", () => {
  assert.match(indexSource, /const host = process\.env\["HOST"\]\?\.trim\(\)\s*\|\|\s*\(process\.env\["REPL_ID"\]\s*===\s*undefined\s*\?\s*"127\.0\.0\.1"\s*:\s*undefined\)/);
  assert.match(indexSource, /app\.listen\(\{\s*port,\s*\.\.\.\(host\s*\?\s*\{\s*host\s*\}\s*:\s*\{\}\)\s*\}/);
  assert.match(indexSource, /app\.listen\(\{ port, \.\.\.\(host \? \{ host \} : \{\}\) \}/);
  assert.match(desktopLauncherSource, /\$env:HOST = "127\.0\.0\.1"/);
  assert.ok(desktopLauncherSource.indexOf('$env:WILLARD_LOCAL_SETUP = "true"') > desktopLauncherSource.indexOf('$env:HOST = "127.0.0.1"'));
});


test("developer desktop launcher and local Vite servers bind only to loopback", () => {
  const startup = developerLauncherSource.indexOf("function Start-WillardServices");
  const host = developerLauncherSource.indexOf('$env:HOST = "127.0.0.1"', startup);
  const localSetup = developerLauncherSource.indexOf('$env:WILLARD_LOCAL_SETUP = "true"', startup);
  const apiStart = developerLauncherSource.indexOf("$apiProc = Start-Process", startup);

  assert.ok(startup >= 0 && host > startup && localSetup > host && apiStart > localSetup, "developer API host and local setup capability must be set before the process starts");
  assert.match(viteConfigSource, /const serverHost = isReplit \? "0\.0\.0\.0" : "127\.0\.0\.1"/);
  assert.equal((viteConfigSource.match(/host: serverHost/g) ?? []).length, 2, "dev and preview servers must share the environment-specific host");
});

test("manual local API startup documents the explicit loopback-only first-run opt-in", () => {
  const manualSetup = localSetupSource.slice(localSetupSource.indexOf("## The manual way"));
  assert.ok(manualSetup.includes('$env:HOST = "127.0.0.1"'));
  assert.ok(manualSetup.includes('$env:WILLARD_LOCAL_SETUP = "true"'));
  assert.ok(manualSetup.includes("HOST=127.0.0.1 WILLARD_LOCAL_SETUP=true pnpm"));
  assert.ok(manualSetup.includes("do not use this bypass on a hosted server or behind a reverse"));
  assert.ok(manualSetup.includes("WILLARD_SETUP_TOKEN"));
});

test("remote first-run setup requires an operator secret and rate-limits attempts", () => {
  assert.match(authSource, /authorizeFirstRunSetup/);
  assert.match(authSource, /configuredToken: process\.env\["WILLARD_SETUP_TOKEN"\]/);
  assert.match(authSource, /router\.post\("\/auth\/setup", setupRateLimiter/);
  assert.match(authSource, /remoteAddress: req\.socket\.remoteAddress/);
  assert.match(authSource, /allowLoopbackSetup:[\s\S]*?WILLARD_LOCAL_SETUP[\s\S]*?REPL_ID[\s\S]*?HOST/);
  assert.match(desktopLauncherSource, /\$env:WILLARD_LOCAL_SETUP = "true"/);
  assert.match(developerLauncherSource, /\$env:WILLARD_LOCAL_SETUP = "true"/);
  assert.match(authSource, /authorization === "token_misconfigured"/);
  assert.match(authSource, /authorization === "token_required" \|\| authorization === "token_invalid"/);
  assert.match(authSource, /status\(503\)/);
  assert.match(authSource, /status\(403\)/);
  const authCheck = authSource.indexOf("const authorization = authorizeFirstRunSetup");
  const settingsRead = authSource.indexOf("const settings = await getOrCreateSettings()", authCheck);
  assert.ok(authCheck >= 0 && settingsRead > authCheck, "remote bootstrap authorization must precede the setup credential lookup/write");
  assert.match(authSource, /const setupRateLimiter = rateLimit\(/);
});


test("late session-store saves after password reset cannot restore authorization", () => {
  assert.ok(authSource.includes("sess.credentialSettingsId = settingsId"));
  assert.ok(authSource.includes("sess.credentialVersion = credentialVersion(expectedPasswordHash)"));
  assert.ok(appSource.includes("FROM app_settings WHERE id = $1"));
  assert.ok(appSource.includes("isSessionCredentialCurrent(sess.credentialVersion, currentPasswordHash)"));
  const credentialCheck = appSource.indexOf("isSessionCredentialCurrent(sess.credentialVersion, currentPasswordHash)");
  assert.ok(
    credentialCheck >= 0 && appSource.indexOf("next();", credentialCheck) > credentialCheck,
    "credential version must be checked before protected routes execute",
  );
  assert.ok(authSource.includes("sess->>'credentialSettingsId' = $1"));
  assert.ok(authSource.includes("sess->>'credentialVersion' = $2"));
  assert.ok(authSource.includes("isSessionCredentialCurrent(sess.credentialVersion, settings.passwordHash)"));
});
