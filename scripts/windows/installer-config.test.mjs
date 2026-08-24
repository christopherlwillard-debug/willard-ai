import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const config = await readFile(new URL("../../installer/WillardMediaCenter.iss", import.meta.url), "utf8");
const launcher = await readFile(new URL("../../desktop/WillardMediaCenter.ps1", import.meta.url), "utf8");
const developerLauncher = await readFile(new URL("../launcher/start.ps1", import.meta.url), "utf8");
const launcherCommon = await readFile(new URL("../launcher/common.ps1", import.meta.url), "utf8");
const releaseBuilder = await readFile(new URL("./make-release.ps1", import.meta.url), "utf8");
const workflow = await readFile(new URL("../../.github/workflows/windows-release.yml", import.meta.url), "utf8");
const releaseValidator = await readFile(new URL("./validate-release.mjs", import.meta.url), "utf8");

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

test("Windows release workflow builds and publishes the versioned package", () => {
  assert.match(workflow, /runs-on: windows-latest/);
  assert.match(workflow, /build-release\.mjs/);
  assert.match(workflow, /validate-release\.mjs/);
  assert.match(workflow, /WILLARD_NODE_RUNTIME/);
  assert.match(workflow, /MyAppVersion=\$env:WILLARD_VERSION/);
  assert.match(workflow, /release-manifest\.json/);
  assert.match(workflow, /WillardMediaCenter-.*-Setup\.exe/);
});

test("release payload validation requires the bundled runtime and app entrypoints", () => {
  assert.match(releaseValidator, /runtime\/node\.exe/);
  assert.match(releaseValidator, /api-runtime\/dist\/index\.mjs/);
  assert.match(releaseValidator, /api-runtime\/setup-db\.cjs/);
  assert.match(releaseValidator, /web\/index\.html/);
});

test("developer startup launches the API directly and fails when that process exits", () => {
  assert.doesNotMatch(developerLauncher, /Start-Process -FilePath "cmd\.exe"/);
  assert.match(developerLauncher, /--env-file=\$envFile/);
  assert.match(developerLauncher, /-FilePath \$nodeCommand/);
  assert.match(developerLauncher, /\$env:PORT = "8080"/);
  assert.match(developerLauncher, /"pnpm\.cmd", "pnpm\.exe"/);
  assert.doesNotMatch(developerLauncher, /Get-Command pnpm -ErrorAction SilentlyContinue\)\.Source/);
  assert.match(developerLauncher, /Wait-ForUrl \$ApiUrl "your library service" 60 \$services\.api\.Id/);
  assert.doesNotMatch(developerLauncher, /automatic restart/);
  assert.doesNotMatch(developerLauncher, /Read-Host "  Press Enter to close this launcher window"/);
  assert.match(launcherCommon, /process exited before it became ready/);
  assert.match(launcherCommon, /Get-LogTail/);
  assert.match(launcherCommon, /function Wait-ForDatabase/);
  assert.match(developerLauncher, /Wait-ForDatabase 30/);
  assert.doesNotMatch(developerLauncher, /Show-Failure \$friendly \$technical/);
});