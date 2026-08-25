import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../../../");
const setupSource = fs.readFileSync(path.join(repoRoot, "setup-db.cjs"), "utf8");
const authSource = fs.readFileSync(
  path.join(repoRoot, "artifacts/api-server/src/routes/auth.ts"),
  "utf8",
);
const indexSource = fs.readFileSync(
  path.join(repoRoot, "artifacts/api-server/src/index.ts"),
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

test("successful recovery consumes the recovery key", () => {
  assert.match(authSource, /recovery_key_hash = NULL/);
  assert.match(authSource, /WHERE id = \$2 AND recovery_key_hash = \$3/);
  assert.match(authSource, /consumed\.rowCount !== 1/);
});

test("interrupted-job recovery is behind the schema startup gate and does not block listening", () => {
  const migration = indexSource.indexOf("const startupMigrations");
  const recovery = indexSource.indexOf("await recoverInterruptedJobs()");
  const listen = indexSource.indexOf("app.listen");

  assert.ok(migration >= 0);
  assert.ok(recovery > migration);
  assert.ok(recovery > listen);
});