import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import {
  parseBoundedInteger,
  parseOptionalDate,
  RequestValidationError,
} from "../lib/request-validation.ts";
import {
  parseSingleByteRange,
  streamFileWithErrorHandling,
} from "../lib/media-range.ts";

test("bounded integers reject malformed, fractional, negative, and oversized values", () => {
  assert.equal(parseBoundedInteger(undefined, { name: "limit", min: 1, max: 200, defaultValue: 60 }), 60);
  assert.equal(parseBoundedInteger("1", { name: "page", min: 1, max: 10_000_000 }), 1);
  assert.equal(parseBoundedInteger("200", { name: "limit", min: 1, max: 200 }), 200);

  for (const value of ["", "01", "1.5", "-1", "2abc", "999999999999999999999"]) {
    assert.throws(
      () => parseBoundedInteger(value, { name: "limit", min: 1, max: 200 }),
      (error: unknown) => error instanceof RequestValidationError && error.message === "Invalid limit",
    );
  }
  assert.throws(
    () => parseBoundedInteger(["10"], { name: "limit", min: 1, max: 200 }),
    /Invalid limit/,
  );
});

test("optional dates reject invalid values and preserve valid instants", () => {
  assert.equal(parseOptionalDate(undefined, "after"), undefined);
  assert.equal(parseOptionalDate("2026-08-26T12:00:00Z", "after")?.toISOString(), "2026-08-26T12:00:00.000Z");
  assert.throws(() => parseOptionalDate("not-a-date", "after"), /Invalid after/);
  assert.throws(() => parseOptionalDate(["2026-08-26"], "after"), /Invalid after/);
});

test("single byte range parser handles bounded, open-ended, suffix, and clipped ranges", () => {
  assert.equal(parseSingleByteRange(undefined, 10), null);
  assert.deepEqual(parseSingleByteRange("bytes=0-3", 10), { start: 0, end: 3 });
  assert.deepEqual(parseSingleByteRange("bytes=4-", 10), { start: 4, end: 9 });
  assert.deepEqual(parseSingleByteRange("bytes=-4", 10), { start: 6, end: 9 });
  assert.deepEqual(parseSingleByteRange("bytes=8-99", 10), { start: 8, end: 9 });
});

test("invalid and unsatisfiable byte ranges return null", () => {
  for (const header of [
    "bytes=",
    "bytes=3-2",
    "bytes=10-10",
    "bytes=-0",
    "bytes=0-1,2-3",
    "items=0-1",
    "bytes=abc-1",
  ]) {
    assert.equal(parseSingleByteRange(header, 10), null, header);
  }
  assert.equal(parseSingleByteRange("bytes=0-", 0), null);
});

test("file stream errors become a response instead of an unhandled stream error", async () => {
  const app = express();
  app.get("/", (_request, response) => {
    streamFileWithErrorHandling(response, path.join(os.tmpdir(), "willard-file-that-does-not-exist.bin"));
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const result = await fetch(`http://127.0.0.1:${address.port}`);
    assert.equal(result.status, 500);
    assert.deepEqual(await result.json(), { error: "File stream failed" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});