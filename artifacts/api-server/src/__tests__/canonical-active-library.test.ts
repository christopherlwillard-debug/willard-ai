import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const routeRoot = new URL("../routes/", import.meta.url);
const files = [
  "documents.ts", "diagnostics.ts", "search.ts", "files.ts",
  "faces.ts", "health.ts", "explorer.ts", "organize.ts", "dashboard.ts", "scan.ts", "media-detail.ts",
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

test("collections and AI privacy use the canonical active settings row", () => {
  const collections = readFileSync(fileURLToPath(new URL("collections.ts", routeRoot)), "utf8");
  const openai = readFileSync(fileURLToPath(new URL("openai/index.ts", routeRoot)), "utf8");
  const privacy = readFileSync(fileURLToPath(new URL("../lib/ai-privacy.ts", import.meta.url)), "utf8");
  assert.match(collections, /getActiveNasPath/);
  assert.doesNotMatch(collections, /appSettingsTable|\.from\(appSettingsTable\)/);
  assert.match(openai, /getActiveAppSettings/);
  assert.doesNotMatch(openai, /appSettingsTable|\.from\(appSettingsTable\)/);
  assert.match(privacy, /getActiveAppSettings/);
  assert.doesNotMatch(privacy, /\.from\(appSettingsTable\)/);
  assert.match(privacy, /aiConsentVersion: settings\.aiConsentVersion/);
  assert.doesNotMatch(privacy, /\.\.\.settings/);
});

test("library settings reads and writes target the canonical active settings row", () => {
  const library = readFileSync(fileURLToPath(new URL("library.ts", routeRoot)), "utf8");
  assert.match(library, /getActiveAppSettings/);
  assert.doesNotMatch(library, /\.from\(appSettingsTable\)\.limit\(1\)/);
  assert.doesNotMatch(library, /db\.update\(appSettingsTable\)\.set\(\{ indexingPaused: (?:true|false) \}\);/);
});

test("library job engine uses canonical scanner settings and only updates the active settings row", () => {
  const enginePath = fileURLToPath(new URL("../lib/library-engine/job-engine.ts", import.meta.url));
  const engine = readFileSync(enginePath, "utf8");
  assert.match(engine, /const settingsRow = await getActiveAppSettings\(\)/);
  assert.match(engine, /const activeSettings = await getActiveAppSettings\(\)/);
  assert.match(engine, /activeSettings\?\.nasPath === state\.nasPath/);
  assert.match(engine, /\.where\(eq\(appSettingsTable\.id, activeSettings\.id\)\)/);
  assert.doesNotMatch(engine, /\.where\(eq\(appSettingsTable\.nasPath, state\.nasPath\)\)/);
});
