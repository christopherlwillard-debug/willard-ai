import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("maintenance routes share the authoritative active-library resolver", () => {
  for (const file of ["routes/library.ts", "routes/cleanup.ts", "routes/media-health.ts", "routes/optimize.ts"]) {
    assert.match(source(file), /active-library\.ts/);
  }

  const resolver = source("lib/active-library.ts");
  assert.match(resolver, /orderBy\(desc\(isNotNull\(appSettingsTable\.passwordHash\)\), asc\(appSettingsTable\.id\)\)/);
  assert.match(resolver, /nasPath\?\.trim\(\)/);
});

test("scan and Cleanup use the same confirmed-duplicate summary", () => {
  assert.match(source("lib/library-engine/job-engine.ts"), /getDuplicateSummary\(state\.nasPath\)/);
  assert.match(source("routes/cleanup.ts"), /getDuplicateSummary\(nasPath\)/);
  assert.match(source("routes/cleanup.ts"), /duplicateCandidates:\s+duplicateSummary\.unconfirmedCandidates/);
});

test("catalog reconciliation remains metadata-only", () => {
  const engine = source("lib/library-engine/job-engine.ts");
  const reconciliation = engine.slice(
    engine.indexOf("// ── Phase: detecting deletions"),
    engine.indexOf("// ── Duplicate detection"),
  );
  assert.match(reconciliation, /\.update\(mediaFilesTable\)/);
  assert.doesNotMatch(reconciliation, /unlink|rmSync|renameSync|copyFile/);
});