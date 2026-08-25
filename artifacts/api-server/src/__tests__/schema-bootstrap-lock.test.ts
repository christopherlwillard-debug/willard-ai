import assert from "node:assert/strict";
import test from "node:test";
import { withSchemaBootstrapLock, type SchemaClient, type SchemaPool } from "../lib/schema-bootstrap-lock.ts";

test("serializes concurrent schema bootstrap attempts and releases both clients", async () => {
  let locked = false;
  let unlock: (() => void) | undefined;
  let active = 0;
  let maxActive = 0;
  let released = 0;

  const makeClient = (): SchemaClient => ({
    async query(sql) {
      if (sql.includes("pg_advisory_lock")) {
        while (locked) await new Promise<void>((resolve) => { unlock = resolve; });
        locked = true;
        return;
      }
      if (sql.includes("pg_advisory_unlock")) {
        locked = false;
        unlock?.();
        unlock = undefined;
        return;
      }
    },
    release() {
      released += 1;
    },
  });

  const schemaPool: SchemaPool = {
    async connect() {
      return makeClient();
    },
  };

  const run = (id: number) => withSchemaBootstrapLock(schemaPool, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, id === 1 ? 15 : 1));
    active -= 1;
    return id;
  });

  const results = await Promise.all([run(1), run(2)]);
  assert.deepEqual(results.sort(), [1, 2]);
  assert.equal(maxActive, 1);
  assert.equal(released, 2);
  assert.equal(locked, false);
});