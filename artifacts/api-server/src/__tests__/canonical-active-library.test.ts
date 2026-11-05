import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const routeRoot = new URL("../routes/", import.meta.url);
const files = [
  "documents.ts", "diagnostics.ts", "search.ts", "files.ts",
  "faces.ts", "health.ts", "explorer.ts",
];
const sources = Object.fromEntries(files.map((name) => [
  name,
  readFileSync(fileURLToPath(new URL(name, routeRoot)), "utf8"),
]));

test("media feature routes use the canonical active-library resolver", () => {
  for (const [name, source] of Object.entries(sources)) {
    assert.match(source, /getActiveNasPath/, name);
    assert.doesNotMatch(source, /appSettingsTable|SELECT nas_path FROM app_settings LIMIT 1/, name);
  }
});

test("archive and storage scopes share the same active-library resolver", () => {
  const archivePath = fileURLToPath(new URL("../lib/archive-scope.ts", import.meta.url));
  const storagePath = fileURLToPath(new URL("../routes/storage.ts", import.meta.url));
  const archive = readFileSync(archivePath, "utf8");
  const storage = readFileSync(storagePath, "utf8");
  assert.match(archive, /import \{ getActiveNasPath \} from "\.\/active-library\.ts"/);
  assert.match(storage, /import \{ getActiveNasPath \} from "\.\.\/lib\/active-library\.ts"/);
  assert.doesNotMatch(archive, /appSettingsTable|\.from\(appSettingsTable\)/);
  assert.doesNotMatch(storage, /appSettingsTable|\.from\(appSettingsTable\)/);
});
