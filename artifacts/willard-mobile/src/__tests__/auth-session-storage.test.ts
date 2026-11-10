import assert from "node:assert/strict";
import test from "node:test";
import { clearStoredSession, migrateSessionCookie } from "../../context/auth-session-storage.ts";
import { fetchMobileAuthStatus } from "../../context/auth-status.ts";

function stores(secureValue: string | null = null, legacyValue: string | null = null) {
  const calls: string[] = [];
  let secure = secureValue;
  let legacy = legacyValue;
  const secureStore = {
    async getItemAsync(key: string) { calls.push(`secure.get:${key}`); return secure; },
    async setItemAsync(key: string, value: string) { calls.push(`secure.set:${key}`); secure = value; },
    async deleteItemAsync(key: string) { calls.push(`secure.delete:${key}`); secure = null; },
  };
  const legacyStore = {
    async getItem(key: string) { calls.push(`legacy.get:${key}`); return legacy; },
    async removeItem(key: string) { calls.push(`legacy.remove:${key}`); legacy = null; },
  };
  return {
    calls,
    secureStore,
    legacyStore,
    getSecure: () => secure,
    getLegacy: () => legacy,
  };
}

test("migrates a legacy cookie to secure storage before removing its old copy", async () => {
  const state = stores(null, "willard.sid=old-session");
  const result = await migrateSessionCookie(state.secureStore, state.legacyStore, "willard.sessionCookie");

  assert.deepEqual(result, { cookie: "willard.sid=old-session", legacyRemoved: true });
  assert.equal(state.getSecure(), "willard.sid=old-session");
  assert.equal(state.getLegacy(), null);
  assert.ok(state.calls.indexOf("secure.set:willard.sessionCookie") < state.calls.indexOf("legacy.remove:willard.sessionCookie"));
});

test("keeps the legacy cookie if writing or verifying its secure copy fails", async () => {
  const state = stores(null, "willard.sid=legacy");
  const failingSecure = {
    ...state.secureStore,
    async setItemAsync() { throw new Error("keychain unavailable"); },
  };
  await assert.rejects(migrateSessionCookie(failingSecure, state.legacyStore, "willard.sessionCookie"), /keychain unavailable/);
  assert.equal(state.getLegacy(), "willard.sid=legacy");
  assert.ok(!state.calls.includes("legacy.remove:willard.sessionCookie"));
});

test("removes an older insecure copy when a secure cookie already exists", async () => {
  const state = stores("willard.sid=secure", "willard.sid=legacy");
  const result = await migrateSessionCookie(state.secureStore, state.legacyStore, "willard.sessionCookie");
  assert.deepEqual(result, { cookie: "willard.sid=secure", legacyRemoved: true });
  assert.equal(state.getLegacy(), null);
});

test("keeps an existing secure cookie usable when legacy storage cannot be read", async () => {
  const state = stores("willard.sid=secure", "willard.sid=legacy");
  const failingLegacy = {
    ...state.legacyStore,
    async getItem() { throw new Error("legacy storage unavailable"); },
  };
  const result = await migrateSessionCookie(state.secureStore, failingLegacy, "willard.sessionCookie");
  assert.deepEqual(result, { cookie: "willard.sid=secure", legacyRemoved: false });
  assert.equal(state.getLegacy(), "willard.sid=legacy");
});

test("secure-store read failure does not fall back to the legacy bearer cookie", async () => {
  const state = stores(null, "willard.sid=legacy");
  const failingSecure = {
    ...state.secureStore,
    async getItemAsync() { throw new Error("keychain unavailable"); },
  };
  await assert.rejects(migrateSessionCookie(failingSecure, state.legacyStore, "willard.sessionCookie"), /keychain unavailable/);
  assert.ok(!state.calls.includes("legacy.get:willard.sessionCookie"));
  assert.equal(state.getLegacy(), "willard.sid=legacy");
});

test("clears secure and legacy session values and reports incomplete removal", async () => {
  const state = stores("willard.sid=secure", "willard.sid=legacy");
  await clearStoredSession(state.secureStore, state.legacyStore, "willard.sessionCookie");
  assert.equal(state.getSecure(), null);
  assert.equal(state.getLegacy(), null);

  const failingSecure = { ...state.secureStore, async deleteItemAsync() { throw new Error("secure delete failed"); } };
  await assert.rejects(
    clearStoredSession(failingSecure, state.legacyStore, "willard.sessionCookie"),
    /could not be fully cleared/,
  );
});

test("auth status distinguishes setup, sign-in, and service errors", async () => {
  const fetcher = async (_url: string, init?: RequestInit) => {
    assert.equal(init?.credentials, "include");
    assert.equal((init?.headers as Record<string, string>).Cookie, "willard.sid=secure");
    return new Response(JSON.stringify({ setup: true, authenticated: false }), { status: 200 });
  };
  assert.deepEqual(await fetchMobileAuthStatus(fetcher, "https://example.test/api/auth/status", "willard.sid=secure"), { kind: "setup_required" });

  const unauthenticated = async () => new Response(JSON.stringify({ setup: false, authenticated: false }), { status: 200 });
  assert.deepEqual(await fetchMobileAuthStatus(unauthenticated, "https://example.test", null), { kind: "unauthenticated" });

  const serviceError = async () => new Response(JSON.stringify({ error: "Try again" }), { status: 503 });
  assert.deepEqual(await fetchMobileAuthStatus(serviceError, "https://example.test", null), { kind: "error", message: "Try again" });
});
