import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeOptionalDateOnlyRange, parseAllowedString, parseBoundedInteger, parseOptionalDateOnlyRange, parseOptionalQueryString, parsePositiveIntegerParam, parsePositiveIntegerValue } from "../lib/request-validation.ts";

const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const readWorkspaceFile = (relativePath: string) =>
  readFileSync(path.join(workspaceRoot, relativePath), "utf8");

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
    const source = readWorkspaceFile(file);
    assert.ok(source.includes("parsePositiveIntegerParam"), file);
    assert.doesNotMatch(source, /(?:parseInt|Number)\s*\(\s*req\.params/, file);
  }

  const collectionsSource = readWorkspaceFile("artifacts/api-server/src/routes/collections.ts");
  assert.ok(collectionsSource.includes("parsePositiveIntegerValue"));
  assert.doesNotMatch(collectionsSource, /parseInt\(String/);

  const facesSource = readWorkspaceFile("artifacts/api-server/src/routes/faces.ts");
  assert.ok(facesSource.includes("parsePositiveIntegerValue"));

  const cleanupSource = readWorkspaceFile("artifacts/api-server/src/routes/cleanup.ts");
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
  const route = readWorkspaceFile("artifacts/api-server/src/routes/archives.ts");
  assert.ok(route.includes('parseOptionalQueryString(req.query.category, "category")'));
  assert.ok(route.includes("parseBoundedInteger(req.query.minSize"));
  assert.ok(route.includes("parseBoundedInteger(req.query.maxSize"));
  assert.ok(route.includes("parseOptionalDateOnlyRange("));
  assert.ok(route.includes("req.query.dateFrom"));
  assert.ok(route.includes("req.query.dateTo"));
  assert.ok(route.includes("minSizeBytes > maxSizeBytes"));
  assert.ok(route.includes("lt(archivesTable.modifiedAt, dateToExclusive)"));
  assert.ok(!route.includes("parseInt(minSize") && !route.includes("parseInt(maxSize"));

  const spec = readWorkspaceFile("lib/api-spec/openapi.yaml");
  const dateFromIndex = spec.indexOf("name: dateFrom");
  const dateToIndex = spec.indexOf("name: dateTo");
  assert.ok(dateFromIndex >= 0 && dateToIndex > dateFromIndex);
  assert.ok(spec.slice(dateFromIndex, dateToIndex).includes("format: date"));
  assert.ok(spec.slice(dateToIndex, dateToIndex + 140).includes("format: date"));

  const generatedParams = readWorkspaceFile("lib/api-zod/src/generated/types/listArchivesParams.ts");
  assert.ok(generatedParams.includes("dateFrom?: Date;"));
  assert.ok(generatedParams.includes("dateTo?: Date;"));
  const generatedClientParams = readWorkspaceFile("lib/api-client-react/src/generated/api.schemas.ts");
  assert.ok(generatedClientParams.includes("dateFrom?: string;"));
  assert.ok(generatedClientParams.includes("dateTo?: string;"));

  const page = readWorkspaceFile("artifacts/willard-ai/src/pages/archives.tsx");
  assert.ok(page.includes("const params: ListArchivesParams ="));
  assert.ok(page.includes("minSizeMb !== \"\""));
  assert.ok(page.includes("maxSizeMb !== \"\""));
});

test("search intent date normalization rejects impossible and contradictory calendar ranges", () => {
  assert.deepEqual(normalizeOptionalDateOnlyRange("2026-11-05", "2026-11-06"), {
    dateFrom: "2026-11-05",
    dateTo: "2026-11-06",
  });
  assert.deepEqual(normalizeOptionalDateOnlyRange("2026-02-30", "2026-03-01"), {
    dateFrom: null,
    dateTo: null,
  });
  assert.deepEqual(normalizeOptionalDateOnlyRange("2026-11-06", "2026-11-05"), {
    dateFrom: null,
    dateTo: null,
  });
  assert.deepEqual(normalizeOptionalDateOnlyRange(null, undefined), {
    dateFrom: null,
    dateTo: null,
  });
});

test("search SQL uses a half-open end-date bound and validates date-only intent", () => {
  const source = readWorkspaceFile("artifacts/api-server/src/lib/ai-search.ts");
  assert.ok(source.includes("parseOptionalDateOnlyRange(intent.dateFrom ?? undefined, intent.dateTo ?? undefined)"));
  assert.match(source, /COALESCE\(f\.date_taken, f\.modified_at\) < \$\{add\(dateRange\.toExclusive/);
  assert.doesNotMatch(source, /T23:59:59/);

  const route = readWorkspaceFile("artifacts/api-server/src/routes/search.ts");
  assert.ok(route.includes("normalizeOptionalDateOnlyRange(o.dateFrom, o.dateTo)"));
  assert.ok(route.includes("parseOptionalDateOnlyRange(f.dateFrom ?? undefined, f.dateTo ?? undefined)"));
  assert.ok(route.includes("instanceof RequestValidationError"));
});

test("parseAllowedString accepts exact enum values and rejects coercions", () => {
  const dispositions = ["waiting", "keep", "move_to_processed", "delete"] as const;
  assert.equal(parseAllowedString(undefined, dispositions, "keep"), "keep");
  assert.equal(parseAllowedString(null, dispositions, "keep"), "keep");
  assert.equal(parseAllowedString("waiting", dispositions, "keep"), "waiting");
  for (const value of ["Waiting", "wait", "waiting ", 1, true, ["keep"], {}]) {
    assert.equal(parseAllowedString(value, dispositions, "keep"), null);
  }
  assert.equal(parseAllowedString(undefined, dispositions), null);
});

test("organize job creation validates archive IDs and source-compatible options", () => {
  const route = readWorkspaceFile("artifacts/api-server/src/routes/organize.ts");
  assert.ok(route.includes("parsePositiveIntegerValue(archiveId)"));
  assert.ok(route.includes('parseAllowedString(archiveDisposition, ["waiting", "keep", "move_to_processed", "delete"], "keep")'));
  assert.ok(route.includes('if (conflictPolicy === "replace")'));
  assert.ok(route.includes("REPLACE_RECOVERY_UNAVAILABLE"));
  assert.ok(route.includes('parseAllowedString(conflictPolicy, ["keep_existing", "rename", "skip"], "keep_existing")'));
  assert.doesNotMatch(route, /parseAllowedString\(conflictPolicy, \["keep_existing", "replace"/);
  assert.ok(route.includes("archiveId: parsedArchiveId"));
  assert.ok(route.includes('sourceType === "folder" && requestedDisposition !== "keep"'));
  assert.doesNotMatch(route, /Number\(archiveId\)/);

  const page = readWorkspaceFile("artifacts/willard-ai/src/pages/organize.tsx");
  assert.match(page, /archiveDisposition:\s*form\.sourceType === "archive"\s*\?\s*form\.archiveDisposition(?:\s+as any)?\s*:\s*"keep"/);
});


test("archive disposition requires an explicit boolean confirmation", () => {
  const route = readWorkspaceFile("artifacts/api-server/src/routes/organize.ts");
  assert.ok(route.includes("req.body?.confirm !== true"));
  assert.doesNotMatch(route, /if\s*\(!req\.body\?\.confirm\)/);
});

test("archive disposition results persist and failed processed moves can be retried", () => {
  const route = readWorkspaceFile("artifacts/api-server/src/routes/organize.ts");
  assert.ok(route.includes("reportJson: nextReport as any"));
  assert.ok(route.includes("dispositionPending: false"));
  assert.ok(route.includes("dispositionError = redactText"));
  assert.ok(route.includes('previousResult === "already_gone"'));
  assert.ok(route.includes("destinationHash !== sourceHash"));

  const page = readWorkspaceFile("artifacts/willard-ai/src/pages/organize.tsx");
  assert.ok(page.includes("report?.dispositionPending === true"));
  assert.ok(page.includes("Retry move to processed"));
  assert.ok(page.includes("Archive is no longer present. No further deletion was performed."));
});
