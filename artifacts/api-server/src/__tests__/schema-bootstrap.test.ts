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
  verifyRequiredSchema(client: Queryable): Promise<{ ready: boolean; missing: string[] }>;
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
    statements.some((sql) => /CREATE TABLE IF NOT EXISTS revoked_sessions/.test(sql)),
    "fresh and upgraded installs must create durable session-revocation tombstones",
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
  assert.ok(
    statements.some((sql) => /ALTER TABLE organization_jobs ADD COLUMN IF NOT EXISTS lease_token text/.test(sql)),
    "existing installs must receive the organization worker fencing token",
  );
  assert.ok(
    statements.some((sql) => /archives_nas_size_idx/.test(sql)) &&
      statements.some((sql) => /archives_nas_modified_idx/.test(sql)) &&
      statements.some((sql) => /archives_nas_status_idx/.test(sql)),
    "fresh bootstrap must create archive list indexes",
  );
  assert.ok(
    statements.some((sql) => /saved_searches_created_idx/.test(sql)),
    "fresh bootstrap must index saved-search ordering",
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
test("schema verification rejects a missing lease_token even when other tables exist", async () => {
  let versionQueryRan = false;
  const client: Queryable = {
    async query(sql) {
      if (sql.includes("required_tables")) {
        return {
          rows: [{
            missing_tables: [],
            missing_columns: ["organization_jobs.lease_token"],
          }],
        };
      }
      versionQueryRan = true;
      return { rows: [{ current_version: 3 }] };
    },
  };

  const result = await bootstrap.verifyRequiredSchema(client);
  assert.deepEqual(result, {
    ready: false,
    missing: ["organization_jobs.lease_token"],
  });
  assert.equal(versionQueryRan, false, "do not query schema history until required tables and columns exist");
});

test("schema verification rejects old and future schema histories", async () => {
  let currentVersion = 2;
  const client: Queryable = {
    async query(sql) {
      if (sql.includes("required_tables")) {
        return { rows: [{ missing_tables: [], missing_columns: [] }] };
      }
      return { rows: [{ current_version: currentVersion }] };
    },
  };

  const oldSchema = await bootstrap.verifyRequiredSchema(client);
  assert.deepEqual(oldSchema, {
    ready: false,
    missing: [`willard_schema_versions.max_version=${bootstrap.SCHEMA_VERSION} (found 2)`],
  });

  currentVersion = bootstrap.SCHEMA_VERSION + 1;
  const futureSchema = await bootstrap.verifyRequiredSchema(client);
  assert.equal(futureSchema.ready, false, "do not run an older application against a future schema");

  currentVersion = bootstrap.SCHEMA_VERSION;
  const currentSchema = await bootstrap.verifyRequiredSchema(client);
  assert.deepEqual(currentSchema, { ready: true, missing: [] });
});