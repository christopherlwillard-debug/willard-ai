import assert from "node:assert/strict";
import test from "node:test";
import {
  persistSessionUnderCredentialLock,
  type CredentialLock,
} from "../lib/auth-session-guard.ts";

function makeLock(
  passwordHash: string | null,
  events: string[],
  options: { commitError?: Error; rollbackError?: Error } = {},
): CredentialLock {
  return {
    passwordHash,
    async commit() {
      events.push("commit");
      if (options.commitError) throw options.commitError;
    },
    async rollback() {
      events.push("rollback");
      if (options.rollbackError) throw options.rollbackError;
    },
  };
}

test("saves the session while the credential lock is held, then commits the lock", async () => {
  const events: string[] = [];
  const accepted = await persistSessionUnderCredentialLock(
    "current-hash",
    async () => {
      events.push("lock");
      return makeLock("current-hash", events);
    },
    async () => { events.push("save"); },
    async () => { events.push("destroy"); },
  );

  assert.equal(accepted, true);
  assert.deepEqual(events, ["lock", "save", "commit"]);
});

test("rejects a stale credential before creating a session", async () => {
  const events: string[] = [];
  const accepted = await persistSessionUnderCredentialLock(
    "old-hash",
    async () => {
      events.push("lock");
      return makeLock("new-hash", events);
    },
    async () => { events.push("save"); },
    async () => { events.push("destroy"); },
  );

  assert.equal(accepted, false);
  assert.deepEqual(events, ["lock", "rollback"]);
});

test("rolls back the credential lock and removes a partially saved session on failure", async () => {
  const events: string[] = [];
  await assert.rejects(
    persistSessionUnderCredentialLock(
      "current-hash",
      async () => makeLock("current-hash", events),
      async () => {
        events.push("save");
        throw new Error("session store unavailable");
      },
      async () => { events.push("destroy"); },
    ),
    /session store unavailable/,
  );
  assert.deepEqual(events, ["save", "rollback", "destroy"]);
});

test("removes a saved session if committing the credential lock fails", async () => {
  const events: string[] = [];
  await assert.rejects(
    persistSessionUnderCredentialLock(
      "current-hash",
      async () => makeLock("current-hash", events, { commitError: new Error("commit failed") }),
      async () => { events.push("save"); },
      async () => { events.push("destroy"); },
    ),
    /commit failed/,
  );
  assert.deepEqual(events, ["save", "commit", "rollback", "destroy"]);
});

test("preserves cleanup failure when a stale session cannot be destroyed", async () => {
  const events: string[] = [];
  await assert.rejects(
    persistSessionUnderCredentialLock(
      "current-hash",
      async () => makeLock("current-hash", events, { commitError: new Error("commit failed") }),
      async () => { events.push("save"); },
      async () => {
        events.push("destroy");
        throw new Error("session delete failed");
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.match(String(error.errors[1]), /session delete failed/);
      return true;
    },
  );
});
