import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("branding logo replacement and deletion use compare-and-set on the previous path", () => {
  const sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const route = fs.readFileSync(path.join(sourceDir, "routes", "settings.ts"), "utf8");

  assert.match(route, /settings\.logoPath \? eq\(appSettingsTable\.logoPath, settings\.logoPath\) : isNull\(appSettingsTable\.logoPath\)/);
  assert.match(route, /Branding logo changed during upload/);
  assert.match(route, /Branding logo changed before it could be removed/);
  assert.match(route, /res\.status\(409\)/);

  const uploadStart = route.indexOf('router.post(\n  "/settings/logo"');
  const deleteStart = route.indexOf('router.delete("/settings/logo"');
  assert.ok(uploadStart >= 0 && deleteStart > uploadStart);
  const upload = route.slice(uploadStart, deleteStart);
  const deletion = route.slice(deleteStart);
  assert.match(upload, /\.where\(and\([\s\S]*?appSettingsTable\.id[\s\S]*?appSettingsTable\.logoPath/);
  assert.match(deletion, /\.where\(and\([\s\S]*?appSettingsTable\.id[\s\S]*?appSettingsTable\.logoPath/);
});


test("branding storage refuses symlinked data or branding roots", () => {
  const sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const route = fs.readFileSync(path.join(sourceDir, "routes", "settings.ts"), "utf8");
  assert.match(route, /function ensureBrandingDirectory\(\)/);
  assert.match(route, /fs\.lstatSync\(directory\)/);
  assert.match(route, /stat\.isSymbolicLink\(\) \|\| !stat\.isDirectory\(\)/);
  assert.match(route, /ensureBrandingDirectory\(\);[\s\S]*?fs\.realpathSync\(getBrandingDir\(\)\)/);
});


test("NAS log stream switches only after the new library path is persisted", () => {
  const sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const route = fs.readFileSync(path.join(sourceDir, "routes", "settings.ts"), "utf8");
  const persistence = route.indexOf(".update(appSettingsTable)");
  const streamSwitch = route.indexOf("nasLogStream.setNasPath(normalizedNasPath)");
  assert.ok(persistence >= 0 && streamSwitch > persistence);
  const preflightEnd = route.indexOf("if (body.nasPath)", persistence);
  const preflight = route.slice(route.indexOf("const normalizedNasPath"), persistence);
  assert.doesNotMatch(preflight, /nasLogStream\.setNasPath/);
  assert.ok(preflightEnd > 0);
});
