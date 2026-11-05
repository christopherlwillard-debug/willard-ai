import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parsePositiveIntegerParam } from "../lib/request-validation.ts";

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

test("media, archive, search, organize, and optimize routes use strict numeric path parsing", () => {
  const routeFiles = [
    "artifacts/api-server/src/routes/media.ts",
    "artifacts/api-server/src/routes/archives.ts",
    "artifacts/api-server/src/routes/search.ts",
    "artifacts/api-server/src/routes/organize.ts",
    "artifacts/api-server/src/routes/optimize.ts",
  ];
  for (const file of routeFiles) {
    const source = readFileSync(file, "utf8");
    assert.ok(source.includes("parsePositiveIntegerParam"), file);
    assert.doesNotMatch(source, /(?:parseInt|Number)\s*\(\s*req\.params/, file);
  }
});
