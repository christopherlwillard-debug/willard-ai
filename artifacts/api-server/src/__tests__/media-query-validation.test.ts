import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseOptionalQueryString, RequestValidationError } from "../lib/request-validation.ts";
import { escapeLikePattern } from "../lib/sql-like.ts";

test("media scalar query parameters reject repeated or non-string values", () => {
  assert.equal(parseOptionalQueryString(undefined, "search"), undefined);
  assert.equal(parseOptionalQueryString("", "search"), undefined);
  assert.equal(parseOptionalQueryString("family photos", "search"), "family photos");
  for (const value of [["photo", "video"], 42, true, {}, null]) {
    assert.throws(
      () => parseOptionalQueryString(value, "search"),
      (error: unknown) => error instanceof RequestValidationError && error.message === "Invalid search",
    );
  }
});

test("LIKE patterns treat percent, underscore, and backslash as literal user input", () => {
  assert.equal(escapeLikePattern('family_100%\\photos'), 'family\\_100\\%\\\\photos');
  assert.equal(escapeLikePattern("plain name.jpg"), "plain name.jpg");
  assert.equal(escapeLikePattern("___%%%"), "\\_\\_\\_\\%\\%\\%");
});

test("media listing validates scalar filters and escapes literal folder/search patterns", () => {
  const route = readFileSync("artifacts/api-server/src/routes/media.ts", "utf8");
  for (const name of ["mediaType", "favorites", "folder", "search", "sort"]) {
    assert.ok(route.includes('parseOptionalQueryString(req.query["' + name + '"], "' + name + '")'), name);
  }
  assert.ok(route.includes('new Set(["photo", "video", "audio", "document", "other"])'));
  assert.ok(route.includes('new Set(["indexed_desc", "name_asc", "name_desc", "size_asc", "size_desc", "modified_asc", "modified_desc"])'));
  assert.ok(route.includes("escapeLikePattern(prefix)"));
  assert.ok(route.includes("escapeLikePattern(search)"));
  assert.ok(route.includes("ESCAPE E'"));
  assert.doesNotMatch(route, /req\.query\["(?:mediaType|favorites|folder|search|sort)"\]\s+as\s+string/);
});

test("Explorer rejects repeated path parameters before resolving filesystem paths", () => {
  const route = readFileSync("artifacts/api-server/src/routes/explorer.ts", "utf8");
  assert.ok(route.includes('parseOptionalQueryString(req.query.path, "path")'));
  assert.ok(route.includes("instanceof RequestValidationError"));
  assert.ok(route.indexOf("parseOptionalQueryString(req.query.path") < route.indexOf("safeResolve(nasPath, relativePath)"));
  assert.doesNotMatch(route, /req\.query\.path\s+as\s+string/);
});
