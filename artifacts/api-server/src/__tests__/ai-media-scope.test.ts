import assert from "node:assert/strict";
import test from "node:test";
import { pgTable, text, PgDialect } from "drizzle-orm/pg-core";
import { buildAiMediaExclusionCondition } from "../lib/ai-media-scope.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mediaFiles = pgTable("media_files", {
  relativePath: text("relative_path"),
  name: text("name"),
});
const dialect = new PgDialect();

test("AI media exclusion SQL covers folder descendants and file extensions", () => {
  const query = dialect.sqlToQuery(buildAiMediaExclusionCondition(
    mediaFiles.relativePath,
    mediaFiles.name,
    { aiExcludedFolders: ["Private\\Family/"], aiExcludedExtensions: [".RAW", "DNG"] },
  ));
  assert.match(query.sql, /lower\(replace/);
  assert.match(query.sql, /left\(/);
  assert.match(query.sql, /right\(lower/);
  assert.ok(query.params.includes("private/family"));
  assert.ok(query.params.includes(".raw"));
  assert.ok(query.params.includes(".dng"));
});

test("AI media exclusion predicate is a no-op when no exclusions are configured", () => {
  const query = dialect.sqlToQuery(buildAiMediaExclusionCondition(
    mediaFiles.relativePath,
    mediaFiles.name,
    { aiExcludedFolders: [], aiExcludedExtensions: [] },
  ));
  assert.equal(query.sql.toLowerCase(), "true");
});

test("every OpenAI library context query applies the active library and AI exclusions", () => {
  const routePath = fileURLToPath(new URL("../routes/openai/index.ts", import.meta.url));
  const source = readFileSync(routePath, "utf8");
  assert.match(source, /getStorageContext\(settings\)/);
  assert.match(source, /getLargeFilesContext\(settings\)/);
  assert.ok((source.match(/buildAiMediaExclusionCondition\(/g) ?? []).length >= 5);
  assert.match(source, /: sql`FALSE`/);
});
