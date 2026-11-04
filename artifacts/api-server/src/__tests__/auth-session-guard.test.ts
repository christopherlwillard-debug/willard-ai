import assert from "node:assert/strict";
import test from "node:test";
import { persistSessionIfCredentialUnchanged } from "../lib/auth-session-guard.ts";

test("persists the session before checking the current credential and destroys a stale login", async () => {
  let currentHash = "old-password-hash";
  const events: string[] = [];
  const accepted = await persistSessionIfCredentialUnchanged(
    "old-password-hash",
    async () => {
      events.push("save");
      // A password reset can commit before this session is saved.
      currentHash = "new-password-hash";
    },
    async () => {
      events.push("read");
      return currentHash;
    },
    async () => {
      events.push("destroy");
    },
  );

  assert.equal(accepted, false);
  assert.deepEqual(events, ["save", "read", "destroy"]);
});

test("keeps a session when its credential is still current", async () => {
  const events: string[] = [];
  const accepted = await persistSessionIfCredentialUnchanged(
    "current-hash",
    async () => { events.push("save"); },
    async () => {
      events.push("read");
      return "current-hash";
    },
    async () => { events.push("destroy"); },
  );

  assert.equal(accepted, true);
  assert.deepEqual(events, ["save", "read"]);
});

test("does not read the credential or report success when session persistence fails", async () => {
  let credentialRead = false;
  await assert.rejects(
    persistSessionIfCredentialUnchanged(
      "current-hash",
      async () => { throw new Error("session store unavailable"); },
      async () => {
        credentialRead = true;
        return "current-hash";
      },
      async () => {},
    ),
    /session store unavailable/,
  );
  assert.equal(credentialRead, false);
});

test("does not report a stale session as rejected if session destruction fails", async () => {
  await assert.rejects(
    persistSessionIfCredentialUnchanged(
      "old-hash",
      async () => {},
      async () => "new-hash",
      async () => { throw new Error("session delete failed"); },
    ),
    /session delete failed/,
  );
});
