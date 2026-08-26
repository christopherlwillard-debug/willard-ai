import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { consumeActionToken, issueActionToken } from "../lib/action-tokens.ts";

describe("one-time action tokens", () => {
  test("binds tokens to one action and resource, then rejects replay", async () => {
    const req = { session: {}, sessionID: "session-a" };
    const token = await issueActionToken(req, "organize-execute", "42");

    assert.ok(token.length >= 40);
    assert.equal(await consumeActionToken(req, token, "organize-resume", "42"), false);
    assert.equal(await consumeActionToken(req, token, "organize-execute", "41"), false);
    assert.equal(await consumeActionToken(req, token, "organize-execute", "42"), true);
    assert.equal(await consumeActionToken(req, token, "organize-execute", "42"), false);
  });

  test("rejects a token from a different session", async () => {
    const issuer = { session: {}, sessionID: "session-a" };
    const otherSession = { session: {}, sessionID: "session-b" };
    const token = await issueActionToken(issuer, "optimize-execute", "7");

    assert.equal(await consumeActionToken(otherSession, token, "optimize-execute", "7"), false);
    assert.equal(await consumeActionToken(issuer, token, "optimize-execute", "7"), true);
  });

  test("does not issue a token when session persistence fails", async () => {
    const session: {
      actionTokens?: Record<string, { action: string; resource: string; expiresAt: number }>;
      save(callback: (error?: unknown) => void): void;
    } = {
      save(callback: (error?: unknown) => void) {
        callback(new Error("session store unavailable"));
      },
    };
    const req = {
      session,
      sessionID: "session-failing",
    };

    await assert.rejects(
      issueActionToken(req, "organize-execute", "99"),
      /session store unavailable/,
    );
    assert.deepEqual(req.session.actionTokens, {});
  });
});