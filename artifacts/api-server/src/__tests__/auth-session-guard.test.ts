import assert from "node:assert/strict";
import test from "node:test";
import {
  credentialVersion,
  isSessionCredentialCurrent,
  isSessionInactive,
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


test("session inactivity expires missing, malformed, stale, and implausibly future timestamps", () => {
  const now = Date.parse("2026-11-06T12:00:00.000Z");
  assert.equal(isSessionInactive("2026-11-06T11:29:59.000Z", now), true);
  assert.equal(isSessionInactive(undefined, now), true);
  assert.equal(isSessionInactive(null, now), true);
  assert.equal(isSessionInactive("", now), true);
  assert.equal(isSessionInactive("not-a-date", now), true);
  assert.equal(isSessionInactive("2026-11-07T12:00:00.000Z", now), true);
});

test("session inactivity accepts fresh timestamps and tolerates small clock skew", () => {
  const now = Date.parse("2026-11-06T12:00:00.000Z");
  assert.equal(isSessionInactive("2026-11-06T11:45:00.000Z", now), false);
  assert.equal(isSessionInactive("2026-11-06T12:00:30.000Z", now), false);
  assert.equal(isSessionInactive(new Date("2026-11-06T11:59:00.000Z"), now), false);
});

test("session inactivity uses the configured timeout", () => {
  const now = Date.parse("2026-11-06T12:00:00.000Z");
  assert.equal(isSessionInactive("2026-11-06T11:50:00.000Z", now, 5 * 60 * 1000), true);
  assert.equal(isSessionInactive("2026-11-06T11:56:00.000Z", now, 5 * 60 * 1000), false);
});

test("credential versions are stable one-way fingerprints of password hashes", () => {
  const passwordHash = "$2b$12$existing-password-hash";
  const version = credentialVersion(passwordHash);
  assert.ok(version);
  assert.match(version, /^[a-f0-9]{64}$/);
  assert.equal(credentialVersion(passwordHash), version);
  assert.notEqual(credentialVersion("$2b$12$replacement-password-hash"), version);
  assert.equal(credentialVersion(null), null);
  assert.equal(credentialVersion(""), null);
});

test("late session-store saves cannot restore a session after its password changes", () => {
  const oldVersion = credentialVersion("$2b$12$old-password-hash");
  assert.equal(isSessionCredentialCurrent(oldVersion, "$2b$12$old-password-hash"), true);
  assert.equal(isSessionCredentialCurrent(oldVersion, "$2b$12$new-password-hash"), false);
  assert.equal(isSessionCredentialCurrent(undefined, "$2b$12$new-password-hash"), false);
  assert.equal(isSessionCredentialCurrent(oldVersion, null), false);
  assert.equal(isSessionCredentialCurrent("malformed", "$2b$12$old-password-hash"), false);
});
