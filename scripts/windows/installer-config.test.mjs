import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const config = await readFile(new URL("../../installer/WillardMediaCenter.iss", import.meta.url), "utf8");
const launcher = await readFile(new URL("../../desktop/WillardMediaCenter.ps1", import.meta.url), "utf8");
const releaseBuilder = await readFile(new URL("./make-release.ps1", import.meta.url), "utf8");

test("installer creates both normal Windows shortcuts", () => {
  assert.match(config, /Name: "\{autoprograms\}\\\{#MyAppName\}"/);
  assert.match(config, /Name: "\{autodesktop\}\\\{#MyAppName\}"/);
  assert.match(config, /willard\.ico/);
});

test("installer shortcuts invoke the native launcher, not a developer script", () => {
  assert.match(config, /WillardMediaCenter\.ps1/);
  assert.doesNotMatch(config, /Start Willard AI\.bat/);
  assert.match(launcher, /release-manifest\.json|UpdateManifest/);
  assert.match(launcher, /Expand-Archive/);
  assert.match(launcher, /setup-db\.cjs/);
  assert.match(launcher, /database\.log/);
});

test("installer deliberately leaves external services outside its payload", () => {
  const installSources = config.split(/\r?\n/).filter((line) => /^\s*Source:/i.test(line));
  assert.doesNotMatch(installSources.join("\n"), /postgres|PostgreSQL|ffmpeg/i);
});

test("release helper produces a checksum-bearing update artifact", () => {
  assert.match(releaseBuilder, /Compress-Archive/);
  assert.match(releaseBuilder, /Get-FileHash .*SHA256/);
  assert.match(releaseBuilder, /release-manifest\.json/);
});