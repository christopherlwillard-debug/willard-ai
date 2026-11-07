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
  SETUP_SQL: string[];
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

    // Recreate the full required schema at version 2, omitting only the v3
    // organization worker fencing-column migration.
    await client.query("BEGIN");
    try {
      for (const sql of bootstrap.SETUP_SQL) {
        if (/ALTER TABLE organization_jobs ADD COLUMN IF NOT EXISTS lease_token text/i.test(sql)) continue;
        await client.query(sql);
      }
      // The current SQL array records its current version; reset only this
      // disposable schema's history to model the legacy v2 database.
      await client.query("DELETE FROM willard_schema_versions");
      await client.query("INSERT INTO willard_schema_versions (version) VALUES (2)");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }

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
