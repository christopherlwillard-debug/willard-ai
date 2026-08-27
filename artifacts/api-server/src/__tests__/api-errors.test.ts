import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import express from "express";
import {
  ApiRequestError,
  apiErrorHandler,
  apiNotFoundHandler,
} from "../lib/api-errors.ts";

type LoggedEvent = {
  fields: Record<string, unknown>;
  message: string;
};

async function withServer(run: (baseUrl: string, events: LoggedEvent[]) => Promise<void>): Promise<void> {
  const events: LoggedEvent[] = [];
  const app = express();
  app.use((req, _res, next) => {
    const request = req as typeof req & { id: string };
    request.id = "request-test-123";
    (request as any).log = {
      error(...args: unknown[]) {
        const [fields, message] = args as [Record<string, unknown>, string];
        events.push({ fields, message });
      },
    };
    next();
  });
  app.use(express.json({ limit: "32b" }));
  app.get("/explode", () => {
    throw new Error("database password at /private/secret.db");
  });
  app.get("/typed", (_req, _res, next) => {
    next(new ApiRequestError(422, "The request is actionable."));
  });
  app.post("/parse", (_req, res) => res.json({ ok: true }));
  app.use(apiNotFoundHandler);
  app.use(apiErrorHandler);

  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, () => resolve(created));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`, events);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("unexpected route failures return a sanitized JSON error and correlate in logs", async () => {
  await withServer(async (baseUrl, events) => {
    const response = await fetch(`${baseUrl}/explode`);
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("content-type")?.startsWith("application/json"), true);
    assert.deepEqual(await response.json(), { error: "Internal server error." });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.fields.requestId, "request-test-123");
    assert.equal(events[0]?.fields.statusCode, 500);
    assert.equal(events[0]?.message, "API request failed");
  });
});

test("unknown routes and typed request errors use the same JSON shape", async () => {
  await withServer(async (baseUrl, events) => {
    const notFound = await fetch(`${baseUrl}/missing`);
    assert.equal(notFound.status, 404);
    assert.deepEqual(await notFound.json(), { error: "Not found." });

    const typed = await fetch(`${baseUrl}/typed`);
    assert.equal(typed.status, 422);
    assert.deepEqual(await typed.json(), { error: "The request is actionable." });

    assert.deepEqual(events.map((event) => event.fields.statusCode), [404, 422]);
    assert.deepEqual(events.map((event) => event.fields.requestId), [
      "request-test-123",
      "request-test-123",
    ]);
  });
});

test("malformed and oversized JSON bodies return actionable JSON errors", async () => {
  await withServer(async (baseUrl, events) => {
    const malformed = await fetch(`${baseUrl}/parse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{\"broken\":",
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "Malformed request body." });

    const oversized = await fetch(`${baseUrl}/parse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: "x".repeat(100) }),
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: "Request body is too large." });

    assert.deepEqual(events.map((event) => event.fields.statusCode), [400, 413]);
  });
});