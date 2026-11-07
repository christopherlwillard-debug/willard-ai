import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../lib/", import.meta.url);
const read = (name: string) => readFileSync(fileURLToPath(new URL(name, root)), "utf8");
const monitor = read("library-monitor.ts");
const watcher = read("library-watcher.ts");
const faces = read("face-recognition.ts");
const scanner = read("media-scanner.ts");
const enrichment = read("ai-enrichment.ts");
const catalog = read("catalog-reconciliation.ts");
const recovery = read("cleanup-recovery.ts");

test("background services load the same canonical settings row", () => {
  for (const [name, source] of Object.entries({ monitor, watcher, faces, scanner, enrichment })) {
    assert.match(source, /getActiveAppSettings/, name);
    assert.doesNotMatch(source, /appSettingsTable|\.from\(appSettingsTable\)/, name);
  }
  for (const [name, source] of Object.entries({ catalog, recovery })) {
    assert.match(source, /getActiveNasPath/, name);
    assert.doesNotMatch(source, /appSettingsTable|\.from\(appSettingsTable\)/, name);
  }
});

test("startup recovery and NAS logging use the canonical active library", () => {
  const indexPath = fileURLToPath(new URL("../index.ts", import.meta.url));
  const appPath = fileURLToPath(new URL("../app.ts", import.meta.url));
  const index = readFileSync(indexPath, "utf8");
  const app = readFileSync(appPath, "utf8");
  assert.match(index, /getActiveNasPath\(\)/);
  assert.doesNotMatch(index, /appSettingsTable.*nasPath|SELECT nas_path FROM app_settings/);
  assert.match(app, /getActiveNasPath\(\)\.then/);
});

test("AI embedding recomputation is constrained to the active library", () => {
  assert.match(enrichment, /AND f\.nas_path = \$2/);
  assert.match(enrichment, /\[fileId, await getActiveNasPath\(\)\]/);
});
