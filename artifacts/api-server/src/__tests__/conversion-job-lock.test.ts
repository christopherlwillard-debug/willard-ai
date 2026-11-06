import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  acquireConversionJobLock,
  acquireConversionFilesystemJobLock,
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

test("a database lock takeover cannot claim NAS mutations while the former process is alive", async () => {
  const nasPath = fs.mkdtempSync(path.join(os.tmpdir(), "willard-conversion-fence-"));
  try {
    const formerDatabaseOwner = makeClient([{ locked: true }]);
    const firstDatabaseLock = await acquireConversionJobLock(83, async () => formerDatabaseOwner.client);
    const firstFilesystemLock = acquireConversionFilesystemJobLock(nasPath, 83);
    assert.ok(firstDatabaseLock);
    assert.ok(firstFilesystemLock);

    // Simulate PostgreSQL dropping the old session during a network partition.
    firstDatabaseLock.release(true);
    const replacementDatabaseOwner = makeClient([{ locked: true }, { unlocked: true }]);
    const secondDatabaseLock = await acquireConversionJobLock(83, async () => replacementDatabaseOwner.client);
    assert.ok(secondDatabaseLock, "the replacement process may own the PostgreSQL lock");
    assert.equal(
      acquireConversionFilesystemJobLock(nasPath, 83),
      null,
      "the still-live former process must retain exclusive NAS ownership",
    );

    firstFilesystemLock.release();
    const secondFilesystemLock = acquireConversionFilesystemJobLock(nasPath, 83);
    assert.ok(secondFilesystemLock, "the replacement may proceed after the old process releases NAS ownership");
    secondFilesystemLock.release();
    await releaseConversionJobLock(secondDatabaseLock!, 83);
  } finally {
    fs.rmSync(nasPath, { recursive: true, force: true });
  }
});

test("a crashed process releases its NAS mutation ownership for safe recovery", async () => {
  const nasPath = fs.mkdtempSync(path.join(os.tmpdir(), "willard-conversion-crash-fence-"));
  const moduleUrl = new URL("../lib/conversion-job-lock.ts", import.meta.url).href;
  const childSource = `
    import { acquireConversionFilesystemJobLock } from ${JSON.stringify(moduleUrl)};
    const lock = acquireConversionFilesystemJobLock(${JSON.stringify(nasPath)}, 84);
    if (!lock) process.exit(2);
    process.stdout.write("LOCKED\\\\n");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", childSource], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("child did not acquire the conversion filesystem lock")), 10_000);
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        if (chunk.includes("LOCKED")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`child exited before acquiring the lock (code ${code})`));
      });
    });

    assert.equal(acquireConversionFilesystemJobLock(nasPath, 84), null, "a live process cannot be displaced");
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));

    const recoveredLock = acquireConversionFilesystemJobLock(nasPath, 84);
    assert.ok(recoveredLock, "recovery may reclaim ownership after confirming the process crashed");
    recoveredLock.release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    fs.rmSync(nasPath, { recursive: true, force: true });
  }
});

test("ownership assertion fails closed if the NAS claim is replaced", () => {
  const nasPath = fs.mkdtempSync(path.join(os.tmpdir(), "willard-conversion-owner-check-"));
  try {
    const lock = acquireConversionFilesystemJobLock(nasPath, 85);
    assert.ok(lock);
    fs.rmSync(lock.lockPath, { recursive: true, force: true });
    fs.mkdirSync(lock.lockPath);
    fs.writeFileSync(path.join(lock.lockPath, "owner.json"), JSON.stringify({
      host: os.hostname(),
      pid: process.pid,
      token: "another-owner",
    }));
    assert.throws(lock.assertOwned, /ownership was lost/);
  } finally {
    fs.rmSync(nasPath, { recursive: true, force: true });
  }
});

test("a lock left by another host is never stolen based on an unverifiable PID", () => {
  const nasPath = fs.mkdtempSync(path.join(os.tmpdir(), "willard-conversion-remote-owner-"));
  try {
    const lockPath = path.join(nasPath, "WillardAI", "conversions", ".locks", "job-86");
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      host: "another-host",
      pid: 999_999_999,
      token: "remote-owner",
    }));
    assert.equal(acquireConversionFilesystemJobLock(nasPath, 86), null);
    assert.equal(fs.existsSync(lockPath), true, "unverifiable remote ownership must remain intact");
  } finally {
    fs.rmSync(nasPath, { recursive: true, force: true });
  }
});
