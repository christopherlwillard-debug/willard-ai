import assert from "node:assert/strict";
import test from "node:test";
import { customFetch, setUnauthorizedHandler } from "../lib/api-client-react/src/custom-fetch.ts";

test("custom API fetch notifies the auth owner on an unauthorized response", async () => {
  const originalFetch = globalThis.fetch;
  let unauthorizedCalls = 0;
  setUnauthorizedHandler(() => { unauthorizedCalls++; });
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "Session expired" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });

  try {
    await assert.rejects(
      customFetch("/api/media/health"),
      (error) => {
        assert.equal(error.status, 401);
        return true;
      },
    );
    assert.equal(unauthorizedCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    setUnauthorizedHandler(null);
  }
});

test("custom API fetch does not notify the auth owner on non-401 failures", async () => {
  const originalFetch = globalThis.fetch;
  let unauthorizedCalls = 0;
  setUnauthorizedHandler(() => { unauthorizedCalls++; });
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "Unavailable" }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });

  try {
    await assert.rejects(customFetch("/api/media/health"));
    assert.equal(unauthorizedCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    setUnauthorizedHandler(null);
  }
});
