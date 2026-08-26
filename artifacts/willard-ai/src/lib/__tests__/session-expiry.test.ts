import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  createUnauthorizedAwareFetch,
  isProtectedApiRequest,
} from "../session-expiry.ts";

test("only protected API routes are treated as an expired session", () => {
  const apiBaseUrl = "https://willard.example/willard-ai/api/";

  assert.equal(isProtectedApiRequest("/willard-ai/api/media/files", apiBaseUrl), true);
  assert.equal(isProtectedApiRequest("/willard-ai/api/auth/login", apiBaseUrl), false);
  assert.equal(isProtectedApiRequest("https://other.example/api/media/files", apiBaseUrl), false);
});

test("a protected API 401 clears local auth exactly once without consuming the response", async () => {
  let sessionExpiredCount = 0;
  const response = new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
  const fetchWithExpiryHandling = createUnauthorizedAwareFetch(
    async () => response,
    "https://willard.example/api/",
    () => {
      sessionExpiredCount += 1;
    },
  );

  const result = await fetchWithExpiryHandling("https://willard.example/api/media/files");

  assert.equal(result, response);
  assert.equal(await result.json().then((body) => body.error), "Unauthorized");
  assert.equal(sessionExpiredCount, 1);
});

test("an intentional login 401 remains available to the login form", async () => {
  let sessionExpiredCount = 0;
  const response = new Response(JSON.stringify({ error: "Incorrect password." }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
  const fetchWithExpiryHandling = createUnauthorizedAwareFetch(
    async () => response,
    "https://willard.example/api/",
    () => {
      sessionExpiredCount += 1;
    },
  );

  const result = await fetchWithExpiryHandling("https://willard.example/api/auth/login");

  assert.equal(await result.json().then((body) => body.error), "Incorrect password.");
  assert.equal(sessionExpiredCount, 0);
});