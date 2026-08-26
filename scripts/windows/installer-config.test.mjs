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
const releaseSigner = await readFile(new URL("./sign-release.mjs", import.meta.url), "utf8");
const localBuildInstaller = await readFile(new URL("./build-installer.ps1", import.meta.url), "utf8");
const releaseStager = await readFile(new URL("./build-release.mjs", import.meta.url), "utf8");
const workflow = await readFile(new URL("../../.github/workflows/windows-release.yml", import.meta.url), "utf8");
const releaseValidator = await readFile(new URL("./validate-release.mjs", import.meta.url), "utf8");
const startupSmoke = await readFile(new URL("./startup-smoke.ps1", import.meta.url), "utf8");
const updateSmoke = await readFile(new URL("./update-smoke.ps1", import.meta.url), "utf8");

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
  assert.match(launcher, /UpdateStage/);
  assert.match(launcher, /checksum verification/);
  assert.match(launcher, /Test-ProcessIdentity/);
  assert.match(launcher, /StatusCode -eq 200/);
  assert.match(launcher, /The previous working release was restored/);
  assert.match(launcher, /Set-Content \$UpdateCheckFile/);
  assert.match(launcher, /-Stop/);
  assert.match(launcher, /loading\.html/);
  assert.match(launcher, /payload-manifest\.json/);
  assert.match(launcher, /signature verification/);
  assert.match(launcher, /signed artifact verification/);
  assert.match(launcher, /--verify-artifact/);
  assert.match(launcher, /-PassThru/);
  assert.match(launcher, /untrusted host/);
  assert.match(launcher, /release-assets\.githubusercontent\.com/);
  assert.match(launcher, /Start-Process \$LoadingScreen/);
});

test("installer deliberately leaves external services outside its payload", () => {
  const installSources = config.split(/\r?\n/).filter((line) => /^\s*Source:/i.test(line));
  assert.doesNotMatch(installSources.join("\n"), /postgres|PostgreSQL|ffmpeg/i);
});

test("release helper produces a checksum-bearing update artifact", () => {
  assert.match(releaseBuilder, /Compress-Archive/);
  assert.match(releaseBuilder, /Get-FileHash .*SHA256/);
  assert.match(releaseBuilder, /git -C \$Root archive/);
  assert.match(releaseBuilder, /sourceArtifactUrl/);
  assert.match(releaseBuilder, /sourceSha256/);
  assert.match(releaseBuilder, /release-manifest\.json/);
  assert.match(releaseBuilder, /sign-release\.mjs/);
  assert.match(releaseSigner, /WILLARD_RELEASE_SIGNING_PRIVATE_KEY/);
  assert.match(releaseSigner, /refusing to publish an unsigned release/);
});

test("Windows release workflow builds and publishes the versioned package", () => {
  assert.match(workflow, /runs-on: windows-latest/);
  assert.match(workflow, /make-release\.ps1/);
  assert.match(workflow, /WILLARD_NODE_RUNTIME/);
  assert.match(workflow, /MyAppVersion=\$env:WILLARD_VERSION/);
  assert.match(workflow, /release-manifest\.json/);
  assert.match(workflow, /WillardMediaCenter-.*-Setup\.exe/);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/);
  assert.match(workflow, /softprops\/action-gh-release@[0-9a-f]{40}/);
  assert.match(workflow, /WILLARD_RELEASE_SIGNING_PRIVATE_KEY/);
  assert.match(workflow, /fba577c4bb87df04d54dd87bbdaa5a2272f1f99a2acbf9152e1a91b8b5f0b279/);
  assert.match(workflow, /e3be0545990c90995d7bf3a7af5d64af1f2e0fc1bbd9b79c27f7abc1e9676e50/);
  assert.match(localBuildInstaller, /fba577c4bb87df04d54dd87bbdaa5a2272f1f99a2acbf9152e1a91b8b5f0b279/);
  assert.match(localBuildInstaller, /e3be0545990c90995d7bf3a7af5d64af1f2e0fc1bbd9b79c27f7abc1e9676e50/);
});

test("release payload validation requires the bundled runtime and app entrypoints", () => {
  assert.match(releaseValidator, /runtime\/node\.exe/);
  assert.match(releaseValidator, /api-runtime\/dist\/index\.mjs/);
  assert.match(releaseValidator, /api-runtime\/setup-db\.cjs/);
  assert.match(releaseValidator, /desktop\/loading\.html/);
  assert.match(releaseValidator, /web\/willard-loading\.mp4/);
  assert.match(releaseValidator, /payload-manifest\.json/);
  assert.match(releaseValidator, /onnxruntime-node/);
  assert.match(releaseValidator, /web\/index\.html/);
  assert.match(releaseValidator, /WILLARD_RELEASE_ZIP/);
  assert.match(releaseValidator, /validateReleaseManifest/);
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

test("release workflow packages the exact payload it validated", () => {
  assert.doesNotMatch(workflow, /Stage and validate the packaged payload/);
  assert.match(workflow, /Create, validate, and package the release/);
  assert.match(releaseBuilder, /build-release\.mjs/);
  assert.match(releaseBuilder, /validate-release\.mjs/);
});

test("release staging removes source and package-manager build metadata", () => {
  assert.match(releaseStager, /pruneBuildOnlyFiles/);
  assert.match(releaseStager, /"src"/);
  assert.match(releaseStager, /"tsconfig\.json"/);
  assert.match(releaseStager, /"willard-api-runtime"/);
});

test("Windows payload prunes non-Windows native dependencies and bundles only node.exe", () => {
  assert.match(releaseStager, /pruneWindowsPayload/);
  assert.match(releaseStager, /darwin\|linux\|android\|freebsd\|arm64\|armv7/);
  assert.match(releaseStager, /nodeRuntime, "node\.exe"/);
  assert.match(releaseStager, /desktop\/loading\.html/);
  assert.match(releaseValidator, /pg-types/);
  assert.match(releaseValidator, /isSymbolicLink/);
});

test("Windows release builds provide Vite's required build-time environment", () => {
  assert.match(releaseStager, /PORT: process\.env\.PORT \|\| "5000"/);
  assert.match(releaseStager, /BASE_PATH: process\.env\.BASE_PATH \|\| "\/"/);
  assert.match(workflow, /PORT: "5000"/);
  assert.match(workflow, /BASE_PATH: "\/"/);
});

test("developer updater is Git-first with a verified archive fallback", () => {
  assert.match(updater, /gitCommand/);
  assert.match(updater, /pull --ff-only origin/);
  assert.match(updater, /sourceArtifactUrl/);
  assert.match(updater, /failed checksum verification/);
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
  assert.doesNotMatch(developerLauncher, /pull --ff-only origin/);
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

test("developer setup enables one-click GitHub updates without affecting packaged installs", () => {
  assert.match(setupLauncher, /Initialize-DeveloperGitCheckout/);
  assert.match(launcherCommon, /init --quiet/);
  assert.match(launcherCommon, /fetch --quiet origin/);
  assert.match(launcherCommon, /One-click GitHub updates enabled/);
  assert.match(updater, /signed release archive remains a fallback/);
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
  assert.match(updater, /sourceArtifactUrl/);
  assert.match(updater, /sourceSha256/);
  assert.match(updater, /Expand-Archive/);
  assert.match(updater, /The developer-source archive was empty or malformed/);
  assert.match(updater, /failed checksum verification/);
  assert.match(updater, /robocopy/);
  assert.match(updater, /previous installation was restored/);
});

test("developer updater preserves local data and rolls back failed Git updates", () => {
  assert.match(updater, /status --porcelain/);
  assert.match(updater, /reset --hard \$gitBefore/);
  assert.match(updater, /previous developer version was restored/);
  assert.match(updater, /--ignore-scripts/);
  assert.match(updater, /api-server run build/);
});

test("Windows update smoke test exercises Git, preservation, and rollback on a real runner", () => {
  assert.match(updateSmoke, /git clone/);
  assert.match(updateSmoke, /WILLARD_UPDATE_REPO/);
  assert.match(updateSmoke, /Local changes were not protected/);
  assert.match(updateSmoke, /unreachable\/willard-ai/);
  assert.match(updateSmoke, /failed rebuild did not restore/);
  assert.match(updateSmoke, /postgres-data\.marker/);
  assert.match(updateSmoke, /media-path\.txt/);
  assert.match(updateSmoke, /New-WillardShortcut/);
  assert.match(updateSmoke, /WScript\.Shell/);
});

test("developer setup creates identity shortcuts for the batch launcher", () => {
  assert.match(setupLauncher, /New-WillardShortcut/);
  assert.match(setupLauncher, /GetFolderPath\("Desktop"\)/);
  assert.match(setupLauncher, /GetFolderPath\("Programs"\)/);
  assert.match(setupLauncher, /Start Willard AI\.bat/);
  assert.match(setupLauncher, /Update Willard AI\.bat/);
  assert.match(setupLauncher, /Update Willard AI from GitHub/);
  assert.match(launcherCommon, /WScript\.Shell/);
  assert.match(launcherCommon, /WorkingDirectory/);
  assert.match(launcherCommon, /IconLocation/);
  assert.match(releaseStager, /icons\/willard\.ico/);
});