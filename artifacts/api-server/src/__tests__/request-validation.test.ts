import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parsePositiveIntegerParam, parsePositiveIntegerValue } from "../lib/request-validation.ts";

test("parsePositiveIntegerParam accepts canonical positive safe integer identifiers", () => {
  assert.equal(parsePositiveIntegerParam("1"), 1);
  assert.equal(parsePositiveIntegerParam("42"), 42);
  assert.equal(parsePositiveIntegerParam("9007199254740991"), Number.MAX_SAFE_INTEGER);
});

test("parsePositiveIntegerParam rejects coercion, partial, zero, and unsafe identifiers", () => {
  for (const value of [
    "", "0", "00", "01", "-1", "+1", "1.0", "1.5", "1e2", " 1", "1 ",
    "1abc", "9007199254740992", "NaN", "Infinity", undefined, null, 1, ["1"],
  ]) {
    assert.equal(parsePositiveIntegerParam(value), null);
  }
});

test("parsePositiveIntegerValue accepts safe positive JSON numbers and canonical decimal strings", () => {
  assert.equal(parsePositiveIntegerValue(7), 7);
  assert.equal(parsePositiveIntegerValue("7"), 7);
  assert.equal(parsePositiveIntegerValue(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
});

test("parsePositiveIntegerValue rejects coercible non-integer JSON values", () => {
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, true, false, null, {}, "1e2", " 2", "2x"]) {
    assert.equal(parsePositiveIntegerValue(value), null);
  }
});

test("numeric route handlers use strict path parsing and body ID validation", () => {
  const routeFiles = [
    "artifacts/api-server/src/routes/media.ts",
    "artifacts/api-server/src/routes/archives.ts",
    "artifacts/api-server/src/routes/search.ts",
    "artifacts/api-server/src/routes/organize.ts",
    "artifacts/api-server/src/routes/optimize.ts",
    "artifacts/api-server/src/routes/collections.ts",
    "artifacts/api-server/src/routes/faces.ts",
    "artifacts/api-server/src/routes/library.ts",
    "artifacts/api-server/src/routes/media-detail.ts",
    "artifacts/api-server/src/routes/openai/index.ts",
  ];
  for (const file of routeFiles) {
    const source = readFileSync(file, "utf8");
    assert.ok(source.includes("parsePositiveIntegerParam"), file);
    assert.doesNotMatch(source, /(?:parseInt|Number)\s*\(\s*req\.params/, file);
  }

  const collectionsSource = readFileSync("artifacts/api-server/src/routes/collections.ts", "utf8");
  assert.ok(collectionsSource.includes("parsePositiveIntegerValue"));
  assert.doesNotMatch(collectionsSource, /parseInt\(String/);

  const facesSource = readFileSync("artifacts/api-server/src/routes/faces.ts", "utf8");
  assert.ok(facesSource.includes("parsePositiveIntegerValue"));

  const cleanupSource = readFileSync("artifacts/api-server/src/routes/cleanup.ts", "utf8");
  assert.ok(cleanupSource.includes("parseBoundedInteger"));
  assert.doesNotMatch(cleanupSource, /Number\.parseInt\(String\(req\.query\.(?:limit|offset)/);
});
