import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

type Queryable = {
  query(sql: string): Promise<unknown>;
};

type BootstrapModule = {
  SCHEMA_VERSION: number;
  SETUP_SQL: string[];
  runRequiredSchema(
    client: Queryable,
    options?: { log?: boolean },
  ): Promise<void>;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../");
const bootstrap = createRequire(import.meta.url)(
  path.join(repoRoot, "setup-db.cjs"),
) as BootstrapModule;

test("required schema bootstrap is versioned and runs atomically", async () => {
  const statements: string[] = [];
  const client: Queryable = {
    async query(sql) {
      statements.push(sql);
    },
  };

  await bootstrap.runRequiredSchema(client, { log: false });

  assert.equal(statements[0], "BEGIN");
  assert.equal(statements.at(-1), "COMMIT");
  assert.match(
    bootstrap.SETUP_SQL[0],
    /CREATE TABLE IF NOT EXISTS willard_schema_versions/,
  );
  assert.match(
    bootstrap.SETUP_SQL.at(-1) ?? "",
    new RegExp(`VALUES \\(${bootstrap.SCHEMA_VERSION}\\)`),
  );
  assert.ok(
    statements.some((sql) => /CREATE TABLE IF NOT EXISTS app_settings/.test(sql)),
    "fresh bootstrap must create app_settings before any settings query",
  );
  assert.ok(
    statements.some((sql) => /CREATE TABLE IF NOT EXISTS media_files/.test(sql)),
    "fresh bootstrap must create the canonical media table",
  );
  assert.ok(
    statements.some((sql) => /library_jobs_active_nas_unique/.test(sql)),
    "fresh bootstrap must create the durable per-library job claim",
  );
  assert.ok(
    statements.some((sql) => /organization_jobs[\s\S]*nas_path/.test(sql)),
    "fresh bootstrap must create organization job library scope",
  );
});

test("required schema bootstrap rolls back and rethrows the original failure", async () => {
  const statements: string[] = [];
  const failure = new Error("simulated migration failure");
  const client: Queryable = {
    async query(sql) {
      statements.push(sql);
      if (/CREATE TABLE IF NOT EXISTS app_settings/.test(sql)) throw failure;
    },
  };

  await assert.rejects(
    bootstrap.runRequiredSchema(client, { log: false }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("Required schema setup rolled back") &&
      error.cause === failure,
  );
  assert.equal(statements[0], "BEGIN");
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.ok(!statements.includes("COMMIT"));
});