import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireConversionJobLock,
  CONVERSION_JOB_LOCK_NAMESPACE,
  releaseConversionJobLock,
  type ConversionJobLockClient,
} from "../lib/conversion-job-lock.ts";

function makeClient(
  responses: Array<Record<string, unknown>>,
  queryError?: Error,
) {
  const calls: Array<{ text: string; values?: any[] }> = [];
  let releaseCalls = 0;
  let releaseError: Error | boolean | undefined;
  const client: ConversionJobLockClient = {
    async query(text, values) {
      calls.push({ text, values });
      if (queryError) throw queryError;
      const row = responses.shift();
      return { rows: row ? [row] : [] };
    },
    release(error) {
      releaseCalls++;
      releaseError = error;
    },
  };
  return {
    client,
    calls,
    get releaseCalls() { return releaseCalls; },
    get releaseError() { return releaseError; },
  };
}

test("conversion advisory lock stays on one connection until verified unlock", async () => {
  const fake = makeClient([{ locked: true }, { unlocked: true }]);
  const lock = await acquireConversionJobLock(42, async () => fake.client);
  assert.equal(lock, fake.client);
  assert.equal(fake.releaseCalls, 0);
  assert.match(fake.calls[0]!.text, /pg_try_advisory_lock/);
  assert.deepEqual(fake.calls[0]!.values, [CONVERSION_JOB_LOCK_NAMESPACE, 42]);

  await releaseConversionJobLock(lock!, 42);
  assert.match(fake.calls[1]!.text, /pg_advisory_unlock/);
  assert.deepEqual(fake.calls[1]!.values, [CONVERSION_JOB_LOCK_NAMESPACE, 42]);
  assert.equal(fake.releaseCalls, 1);
  assert.equal(fake.releaseError, undefined);
});

test("a busy conversion lock releases its unused connection and returns null", async () => {
  const fake = makeClient([{ locked: false }]);
  const lock = await acquireConversionJobLock(7, async () => fake.client);
  assert.equal(lock, null);
  assert.equal(fake.releaseCalls, 1);
  assert.equal(fake.calls.length, 1);
});

test("a failed lock query discards the connection", async () => {
  const failure = new Error("database unavailable");
  const fake = makeClient([], failure);
  await assert.rejects(acquireConversionJobLock(7, async () => fake.client), /database unavailable/);
  assert.equal(fake.releaseCalls, 1);
  assert.equal(fake.releaseError, failure);
});

test("an unverified unlock discards the connection instead of pooling a held lock", async () => {
  const fake = makeClient([{ locked: true }, { unlocked: false }]);
  const lock = await acquireConversionJobLock(7, async () => fake.client);
  await assert.rejects(releaseConversionJobLock(lock!, 7), /was not held/);
  assert.equal(fake.releaseCalls, 1);
  assert.ok(fake.releaseError instanceof Error);
});

test("invalid conversion job IDs are rejected before opening a connection", async () => {
  let connected = false;
  await assert.rejects(
    acquireConversionJobLock(0, async () => {
      connected = true;
      return makeClient([{ locked: true }]).client;
    }),
    /Invalid conversion job ID/,
  );
  assert.equal(connected, false);
});
