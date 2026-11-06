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

test("legacy file search escapes literal filename LIKE metacharacters", () => {
  const route = readFileSync("artifacts/api-server/src/routes/files.ts", "utf8");
  assert.ok(route.includes('import { escapeLikePattern } from "../lib/sql-like.ts";'));
  assert.ok(route.includes("escapeLikePattern(q)"));
  assert.match(route, /ILIKE.*ESCAPE E'/);
});

test("Explorer rejects repeated path parameters before resolving filesystem paths", () => {
  const route = readFileSync("artifacts/api-server/src/routes/explorer.ts", "utf8");
  assert.ok(route.includes('parseOptionalQueryString(req.query.path, "path")'));
  assert.ok(route.includes("instanceof RequestValidationError"));
  assert.ok(route.indexOf("parseOptionalQueryString(req.query.path") < route.indexOf("safeResolve(nasPath, relativePath)"));
  assert.doesNotMatch(route, /req\.query\.path\s+as\s+string/);
});


const databaseUrl = process.env.DATABASE_URL;

test("PostgreSQL LIKE filters match wildcard characters literally", { skip: !databaseUrl }, async () => {
  if (!databaseUrl) return;
  const { pool } = await import("@workspace/db");
  try {
    const searchPattern = "%" + escapeLikePattern("family_100%\\photos") + "%";
    const folderPattern = escapeLikePattern("albums_100%\\family/") + "%";
    const result = await pool.query(
      "SELECT $1::text LIKE $2::text ESCAPE E'\\\\' AS search_matches, " +
        "$3::text LIKE $4::text ESCAPE E'\\\\' AS folder_matches, " +
        "$5::text LIKE $2::text ESCAPE E'\\\\' AS wildcard_non_match, " +
        "$6::text ILIKE $2::text ESCAPE E'\\\\' AS ilike_literal_match, " +
        "$7::text ILIKE $2::text ESCAPE E'\\\\' AS ilike_wildcard_non_match",
      [
        "family_100%\\photos_2026.jpg",
        searchPattern,
        "albums_100%\\family/child/photo.jpg",
        folderPattern,
        "familyX100Yphotos_2026.jpg",
        "FAMILY_100%\\PHOTOS_2026.JPG",
        "FAMILYX100YPHOTOS_2026.JPG",
      ],
    );
    assert.deepEqual(result.rows[0], {
      search_matches: true,
      folder_matches: true,
      wildcard_non_match: false,
      ilike_literal_match: true,
      ilike_wildcard_non_match: false,
    });
  } finally {
    await pool.end();
  }
});
