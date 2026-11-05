import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseBoundedInteger, parseOptionalDateOnlyRange, parseOptionalQueryString, parsePositiveIntegerParam, parsePositiveIntegerValue } from "../lib/request-validation.ts";

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


test("archive list filter inputs reject malformed sizes and repeated scalar parameters", () => {
  const sizeOptions = { name: "minSize", min: 0, max: Number.MAX_SAFE_INTEGER };
  assert.equal(parseBoundedInteger("0", sizeOptions), 0);
  assert.equal(parseBoundedInteger("9007199254740991", sizeOptions), Number.MAX_SAFE_INTEGER);
  for (const value of ["", "01", "-1", "1.5", "12garbage", "1e3", "9007199254740992", ["12"], null]) {
    assert.throws(() => parseBoundedInteger(value, sizeOptions), /Invalid minSize/);
  }
  assert.equal(parseOptionalQueryString(undefined, "category"), undefined);
  assert.equal(parseOptionalQueryString("Photo Archive", "category"), "Photo Archive");
  assert.equal(parseOptionalQueryString("", "category"), undefined);
  assert.throws(() => parseOptionalQueryString(["Photo Archive", "Software"], "category"), /Invalid category/);
});

test("archive date-only ranges validate calendar dates and include the entire end date", () => {
  const sameDay = parseOptionalDateOnlyRange("2026-11-05", "2026-11-05");
  assert.equal(sameDay.from?.toISOString(), "2026-11-05T00:00:00.000Z");
  assert.equal(sameDay.toExclusive?.toISOString(), "2026-11-06T00:00:00.000Z");
  assert.deepEqual(parseOptionalDateOnlyRange(undefined, undefined), { from: undefined, toExclusive: undefined });
  assert.throws(() => parseOptionalDateOnlyRange("2026-02-30", undefined), /Invalid dateFrom/);
  assert.throws(() => parseOptionalDateOnlyRange("2026-11-06", "2026-11-05"), /Invalid date range/);
  assert.throws(() => parseOptionalDateOnlyRange("2026-11-05T00:00:00Z", undefined), /Invalid dateFrom/);
});

test("archive route validates filters and treats the selected end date as inclusive", () => {
  const route = readFileSync("artifacts/api-server/src/routes/archives.ts", "utf8");
  assert.ok(route.includes('parseOptionalQueryString(req.query.category, "category")'));
  assert.ok(route.includes("parseBoundedInteger(req.query.minSize"));
  assert.ok(route.includes("parseBoundedInteger(req.query.maxSize"));
  assert.ok(route.includes("parseOptionalDateOnlyRange(req.query.dateFrom, req.query.dateTo)"));
  assert.ok(route.includes("lt(archivesTable.modifiedAt, dateToExclusive)"));
  assert.ok(!route.includes("parseInt(minSize") && !route.includes("parseInt(maxSize"));

  const spec = readFileSync("lib/api-spec/openapi.yaml", "utf8");
  const dateFromIndex = spec.indexOf("name: dateFrom");
  const dateToIndex = spec.indexOf("name: dateTo");
  assert.ok(dateFromIndex >= 0 && dateToIndex > dateFromIndex);
  assert.ok(spec.slice(dateFromIndex, dateToIndex).includes("format: date"));
  assert.ok(spec.slice(dateToIndex, dateToIndex + 140).includes("format: date"));

  const generatedParams = readFileSync("lib/api-zod/src/generated/types/listArchivesParams.ts", "utf8");
  assert.ok(generatedParams.includes("dateFrom?: string;"));
  assert.ok(generatedParams.includes("dateTo?: string;"));
  const generatedClientParams = readFileSync("lib/api-client-react/src/generated/api.schemas.ts", "utf8");
  assert.ok(generatedClientParams.includes("dateFrom?: string;"));
  assert.ok(generatedClientParams.includes("dateTo?: string;"));

  const page = readFileSync("artifacts/willard-ai/src/pages/archives.tsx", "utf8");
  assert.ok(page.includes("const params: ListArchivesParams ="));
  assert.ok(page.includes("minSizeMb !== \"\""));
  assert.ok(page.includes("maxSizeMb !== \"\""));
});
