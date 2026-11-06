import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { releaseExportedSnapshot, waitForExportedSnapshot } from "./postgres-snapshot-process.mjs";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.kills = [];
    this.pid = 4321;
    this.exitCode = null;
    this.signalCode = null;
  }

  kill(signal) {
    this.kills.push(signal);
    return true;
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("snapshot holder resolves only a complete PostgreSQL exported snapshot id", async () => {
  const child = new FakeChild();
  const pending = waitForExportedSnapshot(child, { timeoutMs: 500 });
  child.stdout.write("BEGIN\n0000000a-0000001f-3\n");
  assert.equal(await pending, "0000000a-0000001f-3");
  assert.deepEqual(child.kills, []);
  child.emit("close", 0, null);
});

test("snapshot holder rejects an early PostgreSQL exit with bounded stderr context", async () => {
  const child = new FakeChild();
  const pending = waitForExportedSnapshot(child, { timeoutMs: 500 });
  child.stderr.write("database authentication failed");
  child.emit("close", 2, null);
  await assert.rejects(pending, /database authentication failed/);
  assert.deepEqual(child.kills, []);
});

test("snapshot holder handles spawn errors without an unhandled child error", async () => {
  const child = new FakeChild();
  const pending = waitForExportedSnapshot(child, { timeoutMs: 500 });
  child.emit("error", new Error("spawn ENOENT"));
  await assert.rejects(pending, /could not start: spawn ENOENT/);
});

test("snapshot holder terminates a timed-out process and escalates to SIGKILL", async () => {
  const child = new FakeChild();
  const pending = waitForExportedSnapshot(child, { timeoutMs: 20, killGraceMs: 20 });
  await assert.rejects(pending, /Timed out while exporting/);
  assert.deepEqual(child.kills, ["SIGTERM"]);
  await delay(30);
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  child.emit("close", null, "SIGKILL");
});

test("snapshot holder skips SIGKILL when signal exit is recorded before close", async () => {
  const child = new FakeChild();
  const pending = waitForExportedSnapshot(child, { timeoutMs: 20, killGraceMs: 20 });

  await assert.rejects(pending, /Timed out while exporting/);
  assert.deepEqual(child.kills, ["SIGTERM"]);

  // The process has exited, but Node has not delivered the close event yet.
  child.signalCode = "SIGTERM";
  await delay(30);

  assert.deepEqual(child.kills, ["SIGTERM"]);
  child.emit("close", null, "SIGTERM");
});

test("snapshot holder cancels kill escalation when the child closes after SIGTERM", async () => {
  const child = new FakeChild();
  const pending = waitForExportedSnapshot(child, { timeoutMs: 20, killGraceMs: 30 });
  await assert.rejects(pending, /Timed out while exporting/);
  assert.deepEqual(child.kills, ["SIGTERM"]);
  child.emit("close", null, "SIGTERM");
  await delay(40);
  assert.deepEqual(child.kills, ["SIGTERM"]);
});

test("snapshot holder bounds stdout and stops a noisy child process", async () => {
  const child = new FakeChild();
  const pending = waitForExportedSnapshot(child, { timeoutMs: 500, killGraceMs: 20 });
  child.stdout.write(Buffer.alloc(64 * 1024 + 1, 0x61));
  await assert.rejects(pending, /excessive output/);
  assert.deepEqual(child.kills, ["SIGTERM"]);
  await delay(30);
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  child.emit("close", null, "SIGKILL");
});

test("snapshot holder handles stdin EPIPE and stops the child", async () => {
  const child = new FakeChild();
  const pending = waitForExportedSnapshot(child, { timeoutMs: 500, killGraceMs: 20 });
  child.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
  await assert.rejects(pending, /input failed: broken pipe/);
  assert.deepEqual(child.kills, ["SIGTERM"]);
  await delay(30);
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  child.emit("close", null, "SIGKILL");
});


test("snapshot release is a no-op after the holder exits by signal", async () => {
  const child = new FakeChild();
  child.signalCode = "SIGTERM";
  child.emit("close", null, "SIGTERM");

  await releaseExportedSnapshot(child, { timeoutMs: 20 });

  assert.equal(child.stdin.writableEnded, false);
  assert.deepEqual(child.kills, []);
});

test("snapshot release waits for normal close and cancels the kill timer", async () => {
  const child = new FakeChild();
  const pending = releaseExportedSnapshot(child, { timeoutMs: 30 });

  assert.equal(child.stdin.writableEnded, true);
  child.emit("close", 0, null);
  await pending;
  await delay(40);

  assert.deepEqual(child.kills, []);
});

test("snapshot release escalates only while the holder is still running", async () => {
  const child = new FakeChild();
  const pending = releaseExportedSnapshot(child, { timeoutMs: 20 });

  await delay(30);
  assert.deepEqual(child.kills, ["SIGKILL"]);
  await pending;
});
