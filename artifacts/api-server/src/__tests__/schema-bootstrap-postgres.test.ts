import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@workspace/db";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../");
const bootstrap = createRequire(import.meta.url)(
  path.join(repoRoot, "setup-db.cjs"),
) as {
  SCHEMA_VERSION: number;
  runRequiredSchema(client: { query(sql: string): Promise<unknown> }, options?: { log?: boolean }): Promise<void>;
  verifyRequiredSchema(client: { query(sql: string): Promise<unknown> }): Promise<{ ready: boolean; missing: string[] }>;
};

after(async () => {
  await pool.end();
});

test("PostgreSQL schema verifier detects and repairs version-2 organization jobs without lease_token", async () => {
  const client = await pool.connect();
  const schema = `willard_schema_audit_${randomUUID().replaceAll("-", "")}`;
  let schemaCreated = false;
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(`
      CREATE TABLE willard_schema_versions (
        version integer PRIMARY KEY,
        applied_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query("INSERT INTO willard_schema_versions (version) VALUES (2)");
    await client.query(`
      CREATE TABLE organization_jobs (
        id serial PRIMARY KEY,
        status text NOT NULL DEFAULT 'pending',
        source_type text NOT NULL,
        source_path text NOT NULL,
        nas_path text,
        archive_id integer,
        archive_disposition text NOT NULL DEFAULT 'keep',
        conflict_policy text NOT NULL DEFAULT 'keep_existing',
        plan_json jsonb,
        preflight_json jsonb,
        file_moves jsonb,
        report_json jsonb,
        report_path text,
        error text,
        last_stage text,
        stage_updated_at timestamp,
        created_at timestamp NOT NULL DEFAULT now(),
        completed_at timestamp
      )
    `);

    const before = await bootstrap.verifyRequiredSchema(client);
    assert.equal(before.ready, false);
    assert.ok(before.missing.includes("organization_jobs.lease_token"));
    assert.ok(before.missing.includes(`willard_schema_versions.max_version=${bootstrap.SCHEMA_VERSION} (found 2)`));

    await bootstrap.runRequiredSchema(client, { log: false });

    const after = await bootstrap.verifyRequiredSchema(client);
    assert.deepEqual(after, { ready: true, missing: [] });
    const leaseColumn = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'organization_jobs'
          AND column_name = 'lease_token'
      ) AS exists
    `);
    assert.equal(leaseColumn.rows[0].exists, true);
  } finally {
    try {
      if (schemaCreated) {
        await client.query("SET search_path TO public");
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
    } finally {
      client.release();
    }
  }
});
