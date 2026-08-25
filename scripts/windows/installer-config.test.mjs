import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { findHighSeverityImageAdvisories } from "./validate-release.mjs";

const config = await readFile(new URL("../../installer/WillardMediaCenter.iss", import.meta.url), "utf8");
const launcher = await readFile(new URL("../../desktop/WillardMediaCenter.ps1", import.meta.url), "utf8");
const developerLauncher = await readFile(new URL("../launcher/start.ps1", import.meta.url), "utf8");
const launcherCommon = await readFile(new URL("../launcher/common.ps1", import.meta.url), "utf8");
const setupLauncher = await readFile(new URL("../launcher/setup.ps1", import.meta.url), "utf8");
const updater = await readFile(new URL("../launcher/update.ps1", import.meta.url), "utf8");
const releaseBuilder = await readFile(new URL("./make-release.ps1", import.meta.url), "utf8");
const releaseStager = await readFile(new URL("./build-release.mjs", import.meta.url), "utf8");
const workflow = await readFile(new URL("../../.github/workflows/windows-release.yml", import.meta.url), "utf8");
const releaseValidator = await readFile(new URL("./validate-release.mjs", import.meta.url), "utf8");
const startupSmoke = await readFile(new URL("./startup-smoke.ps1", import.meta.url), "utf8");

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
  assert.match(launcher, /schema-ready\.json/);
  assert.match(launcher, /Get-SchemaFingerprint/);
  assert.match(launcher, /\$env:WILLARD_SCHEMA_READY = "1"/);
  assert.match(launcher, /last-update-check\.txt/);
  assert.match(launcher, /Test-ProcessIdentity/);
  assert.match(launcher, /StatusCode -eq 200/);
  assert.match(launcher, /The previous working release was restored/);
  assert.match(launcher, /Set-Content \$UpdateCheckFile/);
  assert.match(launcher, /-Stop/);
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
  assert.match(releaseValidator, /WILLARD_RELEASE_ZIP/);
  assert.match(releaseValidator, /sha256.*match/i);
  assert.match(releaseValidator, /sharp.*package\.json/);
  assert.match(releaseValidator, /sharpManifest\.version !== "0\.35\.2"/);
});

test("release validation gates high and critical image parser advisories in both runtime graphs", () => {
  const findings = findHighSeverityImageAdvisories({
    advisories: {
      "api-image": {
        module_name: "image-size",
        severity: "high",
        title: "Image parser denial of service",
        findings: [{
          version: "1.2.1",
          paths: ["artifacts__willard-mobile>@expo/cli>image-size"],
        }],
      },
      "api-sharp": {
        module_name: "sharp",
        severity: "critical",
        title: "Sharp parser issue",
        findings: [{
          version: "0.35.1",
          paths: ["artifacts__api-server>sharp"],
        }],
      },
      "unrelated": {
        module_name: "tar",
        severity: "critical",
        title: "Archive issue",
        findings: [{
          version: "7.5.20",
          paths: ["artifacts__willard-mobile>@expo/cli>tar"],
        }],
      },
      "below-threshold": {
        module_name: "image-size",
        severity: "moderate",
        title: "Not a release-blocking severity",
        findings: [{
          version: "1.2.0",
          paths: ["artifacts__api-server>image-size"],
        }],
      },
    },
  }, {
    "API runtime": "artifacts__api-server>",
    "Mobile toolchain": "artifacts__willard-mobile>",
  });

  assert.deepEqual(findings, [
    {
      scope: "Mobile toolchain",
      package: "image-size",
      version: "1.2.1",
      severity: "high",
      path: "artifacts__willard-mobile>@expo/cli>image-size",
      title: "Image parser denial of service",
    },
    {
      scope: "API runtime",
      package: "sharp",
      version: "0.35.1",
      severity: "critical",
      path: "artifacts__api-server>sharp",
      title: "Sharp parser issue",
    },
  ]);
  assert.match(releaseValidator, /pnpm.*audit.*--json/);
  assert.match(releaseValidator, /High or critical image-processing advisories/);
});

test("clean Windows payload includes a one-click launcher", () => {
  assert.match(releaseStager, /Start Willard Media Center\.bat/);
  assert.match(releaseValidator, /Start Willard Media Center\.bat/);
});

test("Windows payload prunes non-Windows native dependencies and bundles only node.exe", () => {
  assert.match(releaseStager, /pruneWindowsPayload/);
  assert.match(releaseStager, /darwin\|linux\|android\|freebsd\|arm64\|armv7/);
  assert.match(releaseStager, /nodeRuntime, "node\.exe"/);
  assert.match(releaseValidator, /pg-types/);
  assert.match(releaseValidator, /isSymbolicLink/);
});

test("Windows release builds provide Vite's required build-time environment", () => {
  assert.match(releaseStager, /PORT: process\.env\.PORT \|\| "5000"/);
  assert.match(releaseStager, /BASE_PATH: process\.env\.BASE_PATH \|\| "\/"/);
  assert.match(workflow, /PORT: "5000"/);
  assert.match(workflow, /BASE_PATH: "\/"/);
});

test("source updater finds the built-in Windows curl executable", () => {
  assert.match(updater, /SystemRoot.*System32\\curl\.exe/);
});

test("developer startup launches the API directly and fails when that process exits", () => {
  assert.doesNotMatch(developerLauncher, /Start-Process -FilePath "cmd\.exe"/);
  assert.match(developerLauncher, /--env-file=\$envFile/);
  assert.match(developerLauncher, /-FilePath \$nodeCommand/);
  assert.match(developerLauncher, /\$env:PORT = "8080"/);
  assert.match(developerLauncher, /schema-ready\.json/);
  assert.match(developerLauncher, /Get-FileHash/);
  assert.match(developerLauncher, /\$env:WILLARD_SCHEMA_READY = "1"/);
  assert.match(developerLauncher, /dependencies-ready\.json/);
  assert.match(developerLauncher, /pnpm-lock\.yaml/);
  assert.match(developerLauncher, /"pnpm\.cmd", "pnpm\.exe"/);
  assert.doesNotMatch(developerLauncher, /Get-Command pnpm -ErrorAction SilentlyContinue\)\.Source/);
  assert.doesNotMatch(developerLauncher, /git -C \$Root pull/);
  assert.doesNotMatch(developerLauncher, /Checking for safe updates/);
  assert.doesNotMatch(developerLauncher, /Start-Process -FilePath \$powershellCommand/);
  assert.match(developerLauncher, /Wait-ForUrl \$ApiUrl "your library service" \$apiReadyTimeout \$services\.api\.Id/);
  assert.match(developerLauncher, /\$apiReadyTimeout = 180/);
  assert.doesNotMatch(developerLauncher, /automatic restart/);
  assert.doesNotMatch(developerLauncher, /Read-Host "  Press Enter to close this launcher window"/);
  assert.match(launcherCommon, /process exited before it became ready/);
  assert.match(launcherCommon, /Get-LogTail/);
  assert.match(launcherCommon, /function Wait-ForDatabase/);
  assert.match(developerLauncher, /Wait-ForDatabase 30/);
  assert.doesNotMatch(developerLauncher, /Show-Failure \$friendly \$technical/);
  assert.match(launcherCommon, /Get-CimInstance Win32_Process/);
  assert.match(launcherCommon, /Test-ProcessIdentity/);
  assert.doesNotMatch(launcherCommon, /\$pid\s*=/i);
  assert.match(launcherCommon, /StatusCode -eq 200/);
  assert.match(developerLauncher, /Save-TrackedPids \$apiProc\.Id \$null/);
});

test("developer setup does not require or initialize GitHub updates", () => {
  assert.doesNotMatch(setupLauncher, /Enable one-click updates from GitHub/);
  assert.doesNotMatch(setupLauncher, /git -C \$Root init/);
  assert.doesNotMatch(setupLauncher, /git -C \$Root fetch/);
});

test("Windows startup smoke test covers readiness, ownership, and web failure diagnostics", () => {
  assert.match(workflow, /startup-smoke\.ps1/);
  assert.match(workflow, /Install PostgreSQL for the source launcher smoke test/);
  assert.match(startupSmoke, /Start Willard AI\.bat/);
  assert.match(startupSmoke, /127\.0\.0\.1:8080\/api\/healthz/);
  assert.match(startupSmoke, /127\.0\.0\.1:5000/);
  assert.match(startupSmoke, /Get-CimInstance Win32_Process/);
  assert.match(startupSmoke, /deliberate web startup failure/);
  assert.match(startupSmoke, /web\.log/);
  assert.match(startupSmoke, /scripts\\launcher\\stop\.ps1/);
  assert.doesNotMatch(startupSmoke, /desktop\\WillardMediaCenter\.ps1/);
  assert.match(config, /WillardMediaCenter\.ps1/);
});

test("installer coordinates upgrades and repair reports failures", async () => {
  const repair = await readFile(new URL("../launcher/repair.ps1", import.meta.url), "utf8");
  assert.match(config, /PrepareToInstall/);
  assert.match(config, /WillardMediaCenter\.ps1[\s\S]*-Stop/);
  assert.match(repair, /\$problems\.Count -gt 0\) \{ exit 1 \}/);
});

test("developer fallback stages a complete source archive", async () => {
  const updater = await readFile(new URL("../launcher/update.ps1", import.meta.url), "utf8");
  assert.match(updater, /archive\/refs\/heads/);
  assert.match(updater, /Expand-Archive/);
  assert.match(updater, /The downloaded source archive is incomplete/);
  assert.match(updater, /robocopy/);
  assert.doesNotMatch(updater, /Downloading \+ \$filesToUpdate\.Count/);
});

test("developer setup creates identity shortcuts for the batch launcher", () => {
  assert.match(setupLauncher, /New-WillardShortcut/);
  assert.match(setupLauncher, /GetFolderPath\("Desktop"\)/);
  assert.match(setupLauncher, /GetFolderPath\("Programs"\)/);
  assert.match(setupLauncher, /Start Willard AI\.bat/);
  assert.match(launcherCommon, /WScript\.Shell/);
  assert.match(launcherCommon, /WorkingDirectory/);
  assert.match(launcherCommon, /IconLocation/);
  assert.match(releaseStager, /icons\/willard\.ico/);
});