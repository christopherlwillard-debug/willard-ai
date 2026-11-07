import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const routePath = fileURLToPath(new URL("../routes/openai/index.ts", import.meta.url));
const source = readFileSync(routePath, "utf8");

test("AI storage and large-file context are restricted to the active library", () => {
  assert.match(source, /async function getStorageContext\(settings: any\)/);
  assert.match(source, /async function getLargeFilesContext\(settings: any\)/);
  assert.match(source, /getStorageContext\(settings\)/);
  assert.match(source, /getLargeFilesContext\(settings\)/);
  assert.ok((source.match(/eq\(mediaFilesTable\.nasPath, nasPath\)/g) ?? []).length >= 2);
});

test("AI local file search is skipped when no active library is configured", () => {
  assert.match(source, /if \(searchMatch && settings\?\.nasPath\)/);
  assert.doesNotMatch(source, /settings\?\.nasPath \? eq\(mediaFilesTable\.nasPath, settings\.nasPath\) : sql`TRUE`/);
});
