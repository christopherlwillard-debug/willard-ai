import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { findHighSeverityImageAdvisories } from "./validate-release.mjs";

const require = createRequire(import.meta.url);
const {
  ensureDatabase,
  getDatabaseName,
  quoteIdentifier,
} = require("../../setup-db.cjs");
const config = await readFile(
  new URL("../../installer/WillardMediaCenter.iss", import.meta.url),
  "utf8",
);
const launcher = await readFile(
  new URL("../../desktop/WillardMediaCenter.ps1", import.meta.url),
  "utf8",
);
const launcherInstanceLock = await readFile(
  new URL("../../desktop/launcher-instance-lock.ps1", import.meta.url),
  "utf8",
);
const developerLauncher = await readFile(
  new URL("../launcher/start.ps1", import.meta.url),
  "utf8",
);
const webIndex = await readFile(
  new URL("../../artifacts/willard-ai/index.html", import.meta.url),
  "utf8",
);
const launcherCommon = await readFile(
  new URL("../launcher/common.ps1", import.meta.url),
  "utf8",
);
const setupLauncher = await readFile(
  new URL("../launcher/setup.ps1", import.meta.url),
  "utf8",
);
const repairLauncher = await readFile(
  new URL("../launcher/repair.ps1", import.meta.url),
  "utf8",
);
const updater = await readFile(
  new URL("../launcher/update.ps1", import.meta.url),
  "utf8",
);
const releaseBuilder = await readFile(
  new URL("./make-release.ps1", import.meta.url),
  "utf8",
);
const releaseSigner = await readFile(
  new URL("./sign-release.mjs", import.meta.url),
  "utf8",
);
const localBuildInstaller = await readFile(
  new URL("./build-installer.ps1", import.meta.url),
  "utf8",
);
const releaseStager = await readFile(
  new URL("./build-release.mjs", import.meta.url),
  "utf8",
);
const officialSevenZipBootstrap = await readFile(
  new URL("./prepare-official-7zip.ps1", import.meta.url),
  "utf8",
);
const workflow = await readFile(
  new URL("../../.github/workflows/windows-release.yml", import.meta.url),
  "utf8",
);
const fastValidationWorkflow = await readFile(
  new URL("../../.github/workflows/fast-validation.yml", import.meta.url),
  "utf8",
);
const backendAudit = await readFile(
  new URL("../../artifacts/api-server/audit.mjs", import.meta.url),
  "utf8",
);
const backupCoordinator = await readFile(
  new URL(
    "../../artifacts/api-server/src/lib/backup-coordinator.ts",
    import.meta.url,
  ),
  "utf8",
);
const rootPackage = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
);
const pnpmWorkspace = await readFile(
  new URL("../../pnpm-workspace.yaml", import.meta.url),
  "utf8",
);
const releaseValidator = await readFile(
  new URL("./validate-release.mjs", import.meta.url),
  "utf8",
);
const startupSmoke = await readFile(
  new URL("./startup-smoke.ps1", import.meta.url),
  "utf8",
);
const apiBuild = await readFile(
  new URL("../../artifacts/api-server/build.mjs", import.meta.url),
  "utf8",
);
const updateSmoke = await readFile(
  new URL("./update-smoke.ps1", import.meta.url),
  "utf8",
);
const updateJournalSmoke = await readFile(
  new URL("./update-journal-smoke.ps1", import.meta.url),
  "utf8",
);
const loaderPage = await readFile(
  new URL("../../desktop/loading.html", import.meta.url),
  "utf8",
);
const installerCompiler = await readFile(
  new URL("./compile-installer.ps1", import.meta.url),
  "utf8",
);
const installedLifecycleSmoke = await readFile(
  new URL("./installer-lifecycle-smoke.ps1", import.meta.url),
  "utf8",
);
const replacementRecoverySmoke = await readFile(
  new URL("./replacement-recovery-smoke.ps1", import.meta.url),
  "utf8",
);

function selectImportedCertificateCleanupCandidates({
  snapshotSucceeded,
  before,
  imported,
  current,
}) {
  if (!snapshotSucceeded) return [];
  const original = new Set(before);
  const introduced = new Set(
    current.filter((thumbprint) => !original.has(thumbprint)),
  );
  return [
    ...new Set(imported.filter((thumbprint) => introduced.has(thumbprint))),
  ].sort();
}

test("installer creates both normal Windows shortcuts", () => {
  assert.match(config, /Name: "\{autoprograms\}\\\{#MyAppName\}"/);
  assert.match(config, /Name: "\{autodesktop\}\\\{#MyAppName\}"/);
  assert.match(config, /willard\.ico/);
  const explicitIconCopies = config
    .split(/\r?\n/)
    .filter((line) => /^\s*Source:\s*"willard\.ico"/i.test(line));
  assert.equal(
    explicitIconCopies.length,
    0,
    "the staged icon must be included by the payload wildcard only",
  );
});

test("installer shortcuts invoke the native launcher, not a developer script", () => {
  assert.match(config, /WillardMediaCenter\.ps1/);
  assert.doesNotMatch(config, /Start Willard AI\.bat/);
  assert.match(launcher, /release-manifest\.json|UpdateManifest/);
  assert.match(launcher, /Expand-Archive/);
  assert.match(launcher, /setup-db\.cjs/);
  assert.match(launcher, /database\.log/);
  assert.match(launcher, /automation-credential\.dpapi/);
  assert.match(launcher, /Add-Type -AssemblyName System\.Security/);
  assert.match(
    launcher,
    /could not unlock the locally protected backup credential.*Exception\.Message/,
  );
  assert.match(launcher, /stored\.Substring\("dpapi-v2:"\.Length\)/);
  assert.match(launcher, /ProtectedData\]::Protect/);
  assert.match(launcher, /WILLARD_BACKUP_RECOVERY_EXPORT_READY/);
  assert.match(launcher, /portable recovery export/i);
  assert.match(
    launcher,
    /\$version = \[string\]\(\(Get-Content \$VersionFile -Raw \| ConvertFrom-Json\)\.version\)\.Trim\(\)/,
  );
  assert.match(launcher, /return "0\.0\.0"/);
  assert.match(launcher, /credentialFingerprint/);
  assert.match(launcher, /documentsRoot/);
  assert.match(launcher, /schema-ready\.json/);
  assert.match(launcher, /Get-SchemaFingerprint/);
  assert.match(launcher, /\$env:WILLARD_SCHEMA_READY = "1"/);
  assert.match(launcher, /last-update-check\.txt/);
  assert.match(launcher, /UpdateStage/);
  assert.match(launcher, /checksum verification/);
  assert.match(launcher, /function Get-WillardSha256/);
  assert.doesNotMatch(launcher, /Get-FileHash/);
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
  assert.ok(launcher.includes('--env-file=`"$EnvFile`"'));
  assert.ok(launcher.includes('"`"$Api`""'));
  assert.ok(launcher.includes('--root=`"$Web`"'));
  assert.match(launcher, /untrusted host/);
  assert.match(launcher, /release-assets\.githubusercontent\.com/);
  assert.match(launcher, /Start-LoadingScreen/);
  assert.match(launcher, /function Read-StartupLogTail/);
  assert.match(launcher, /stopped before becoming ready/);
  assert.match(launcher, /Wait-Ready \$ApiUrl "library service" \$apiProc/);
  assert.match(launcher, /Wait-Ready \$WebUrl "Media Center" \$webProc/);
  assert.match(
    launcher,
    /Wait-Ready \$WebUrl "Media Center" \$webProc[\s\S]*Close-LoadingScreen[\s\S]*Start-Process \$WebUrl/,
  );
  assert.match(launcher, /swap-journal\.json/);
  assert.match(launcher, /Invoke-PackagedVersionSwap/);
  assert.match(launcher, /Recover-InterruptedUpdateSwap/);
  assert.match(
    launcher,
    /Move-Item -LiteralPath \$InstallRoot -Destination \$backup/,
  );
  assert.match(
    launcher,
    /prior runnable version is retained until health checks pass/,
  );
  assert.doesNotMatch(
    launcher,
    /Copy-Item \(Join-Path \$stage "\*"\) \$InstallRoot -Recurse -Force/,
  );
});

test("installer refuses payload replacement when the running application cannot stop", () => {
  const stopStart = config.indexOf("function StopWillardServices");
  const prepareStart = config.indexOf("function PrepareToInstall", stopStart);
  const prepareEnd = config.indexOf("\nprocedure CurUninstallStepChanged", prepareStart);
  const stopHelper = config.slice(stopStart, prepareStart);
  const prepare = config.slice(prepareStart, prepareEnd);
  assert.match(stopHelper, /if not Exec\(/);
  assert.match(stopHelper, /ResultCode <> 0/);
  assert.match(stopHelper, /existing installation was left unchanged/);
  assert.match(prepare, /StopWillardServices/);

  const packagedStopStart = launcher.indexOf("function Stop-Services {");
  const packagedStopEnd = launcher.indexOf("\nfunction Save-Services", packagedStopStart);
  const packagedStop = launcher.slice(packagedStopStart, packagedStopEnd);
  assert.match(packagedStop, /Wait-Process/);
  assert.match(packagedStop, /Test-ProcessIdentity/);
  assert.match(packagedStop, /if \(\$remaining\.Count -gt 0\)/);
  assert.ok(packagedStop.indexOf("Remove-Item $PidFile") > packagedStop.indexOf("if ($remaining.Count -gt 0)"));

  const developerStopStart = launcherCommon.indexOf("function Stop-TrackedProcesses {");
  const developerStopEnd = launcherCommon.indexOf("\nfunction Get-LogTail", developerStopStart);
  const developerStop = launcherCommon.slice(developerStopStart, developerStopEnd);
  assert.match(developerStop, /Wait-Process/);
  assert.match(developerStop, /Test-ProcessIdentity/);
  assert.match(developerStop, /throw/);
  assert.ok(developerStop.indexOf("Clear-TrackedPids") > developerStop.indexOf("if ($remaining.Count -gt 0)"));
});

test("installer deliberately leaves external services outside its payload", () => {
  const installSources = config
    .split(/\r?\n/)
    .filter((line) => /^\s*Source:/i.test(line));
  assert.doesNotMatch(installSources.join("\n"), /postgres|PostgreSQL|ffmpeg/i);
});

test("source Setup and Repair automatically restore thumbnail media tools", () => {
  assert.match(launcherCommon, /function Install-WillardMediaTools/);
  assert.match(
    launcherCommon,
    /winget install --id Gyan\.FFmpeg --exact --silent/,
  );
  assert.match(launcherCommon, /choco install ffmpeg -y --no-progress/);
  assert.match(launcherCommon, /GetEnvironmentVariable\("Path", "Machine"\)/);
  assert.match(launcherCommon, /GetEnvironmentVariable\("Path", "User"\)/);
  assert.match(setupLauncher, /if \(\$entryTracked\) \{\s+Stop-TrackedProcesses \| Out-Null/);
  assert.match(
    setupLauncher,
    /Setup stopped before scans could create repeated thumbnail failures/,
  );
  assert.match(repairLauncher, /if \(Install-WillardMediaTools\)/);
  assert.doesNotMatch(repairLauncher, /To add it:\s+winget install/);
});

test("developer API builds remain runnable after the update candidate is moved", () => {
  assert.match(apiBuild, /process\.chdir\(artifactDir\)/);
  assert.match(apiBuild, /outdir:\s*"dist"/);
  assert.doesNotMatch(apiBuild, /outdir:\s*distDir/);
  for (const worker of [
    "thread-stream-worker.mjs",
    "pino-worker.mjs",
    "pino-file.mjs",
    "pino-pretty.mjs",
  ]) {
    assert.match(launcherCommon, new RegExp(worker.replace(".", "\\.")));
  }
  assert.match(developerLauncher, /Test-WillardApiBuild \$Root/);
  assert.match(updater, /Test-WillardApiBuild \$candidate/);
  assert.match(developerLauncher, /Error output:/);
});

test("backup shutdown terminates the full Windows process tree", () => {
  assert.match(backupCoordinator, /taskkill\.exe/);
  assert.match(
    backupCoordinator,
    /\["\/PID", String\(child\.pid\), "\/T", "\/F"\]/,
  );
  assert.match(backupCoordinator, /SIGKILL/);
  assert.match(backupCoordinator, /Promise\.race/);
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
  assert.match(workflow, /push:\s*\n\s+branches:\s*\n\s+- main/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(
    workflow,
    /validate_only:\s*\n\s+description:[^\n]*\n\s+required:\s*false\n\s+type:\s*boolean\n\s+default:\s*true/,
  );
  assert.match(
    workflow,
    /if:\s*\$\{\{\s*github\.event_name != 'workflow_dispatch' \|\| inputs\.validate_only != true\s*\}\}/,
  );
  assert.match(workflow, /runs-on: windows-latest/);
  assert.match(
    workflow,
    /group:\s*windows-release-\$\{\{\s*github\.ref\s*\}\}/,
  );
  assert.match(workflow, /cancel-in-progress:\s*true/);
  assert.match(workflow, /make-release\.ps1/);
  assert.match(workflow, /WILLARD_NODE_RUNTIME/);
  assert.match(installerCompiler, /MyAppVersion=\$Version/);
  assert.match(installerCompiler, /\$ExpectedPublisher = "Willard Media Center"/);
  assert.match(installerCompiler, /VersionInfo/);
  assert.match(installerCompiler, /\$installerPublisher = \(\[string\]\$versionInfo\.CompanyName\)\.Trim\(\)/);
  assert.match(installerCompiler, /\$installerProduct = \(\[string\]\$versionInfo\.ProductName\)\.Trim\(\)/);
  assert.match(installerCompiler, /\$installerPublisher -ne \$ExpectedPublisher/);
  assert.match(installerCompiler, /\$installerProduct -ne \$ExpectedPublisher/);
  assert.match(installerCompiler, /WILLARD_REQUIRE_WINDOWS_SIGNING/);
  assert.match(installerCompiler, /WILLARD_WINDOWS_SIGNING_CERTIFICATE_BASE64/);
  assert.match(
    installerCompiler,
    /WILLARD_WINDOWS_SIGNING_CERTIFICATE_PASSWORD/,
  );
  assert.match(installerCompiler, /FromBase64String/);
  assert.match(installerCompiler, /Import-PfxCertificate/);
  assert.match(installerCompiler, /ConvertTo-SecureString/);
  assert.match(installerCompiler, /EnhancedKeyUsageList/);
  assert.match(installerCompiler, /1\.3\.6\.1\.5\.5\.7\.3\.3/);
  assert.match(installerCompiler, /signingCertificates\.Count -ne 1/);
  assert.match(installerCompiler, /\/sha1.*\$certificateThumbprint/);
  assert.doesNotMatch(installerCompiler, /\/p.*\$certificatePassword/);
  assert.match(installerCompiler, /signtool\.exe/);
  assert.match(installerCompiler, /\/fd.*SHA256/);
  assert.match(installerCompiler, /\/td.*SHA256/);
  assert.match(installerCompiler, /\/tr.*\$timestampUrl/);
  assert.match(installerCompiler, /verify.*\/pa.*\/all.*\/tw/);
  assert.match(installerCompiler, /Get-AuthenticodeSignature/);
  assert.match(installerCompiler, /TimeStamperCertificate/);
  assert.match(installerCompiler, /SignerCertificate\.GetNameInfo/);
  assert.match(installerCompiler, /signerPublisher -ne \$ExpectedPublisher/);
  assert.match(installerCompiler, /Installer signer publisher/);
  assert.match(installerCompiler, /Installer Authenticode signature verified/);
  assert.match(installerCompiler, /certificateThumbprintsToRemove/);
  assert.match(
    installerCompiler,
    /certificateStoreSnapshotSucceeded = \$false/,
  );
  assert.match(installerCompiler, /certificateStoreSnapshotSucceeded = \$true/);
  assert.match(
    installerCompiler,
    /certificateStoreSnapshotSucceeded -and \$importedCertificateThumbprints\.Count -gt 0/,
  );
  assert.match(
    installerCompiler,
    /introducedCertificateThumbprints -contains \$_/,
  );
  assert.match(installerCompiler, /foreach \(\$thumbprint/);
  assert.match(
    installerCompiler,
    /Remove-Item -LiteralPath \$certificateStorePath/,
  );
  assert.match(
    installerCompiler,
    /could not be removed from the current-user store/,
  );
  assert.match(installerCompiler, /Remove-Item -LiteralPath \$certificatePath/);
  assert.match(installerCompiler, /could not be removed\./);
  assert.match(workflow, /release-manifest\.json/);
  assert.match(workflow, /WillardMediaCenter-.*-Setup\.exe/);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/);
  assert.match(workflow, /softprops\/action-gh-release@[0-9a-f]{40}/);
  assert.match(workflow, /WILLARD_RELEASE_SIGNING_PRIVATE_KEY/);
  assert.match(
    workflow,
    /WILLARD_WINDOWS_SIGNING_CERTIFICATE_BASE64:\s*\$\{\{\s*secrets\.WILLARD_WINDOWS_SIGNING_CERTIFICATE_BASE64\s*\}\}/,
  );
  assert.match(
    workflow,
    /WILLARD_WINDOWS_SIGNING_CERTIFICATE_PASSWORD:\s*\$\{\{\s*secrets\.WILLARD_WINDOWS_SIGNING_CERTIFICATE_PASSWORD\s*\}\}/,
  );
  assert.match(workflow, /WILLARD_REQUIRE_WINDOWS_SIGNING:\s*"true"/);
  const trustMetadataStep = workflow.slice(
    workflow.indexOf("Record installer trust metadata"),
    workflow.indexOf("Verify replacement Windows recovery from the packaged payload"),
  );
  assert.match(trustMetadataStep, /Get-AuthenticodeSignature/);
  assert.match(trustMetadataStep, /SignerCertificate/);
  assert.match(trustMetadataStep, /TimeStamperCertificate/);
  assert.match(trustMetadataStep, /expected 'Willard Media Center'/);
  assert.match(trustMetadataStep, /Potential release URL \(only if published\):/);
  assert.match(trustMetadataStep, /Signer valid from:/);
  assert.match(trustMetadataStep, /Signer certification path: Valid/);
  assert.match(trustMetadataStep, /Timestamp signer valid from:/);
  assert.match(trustMetadataStep, /Timestamp certification path: Valid/);
  assert.match(trustMetadataStep, /GITHUB_STEP_SUMMARY/);
  assert.match(trustMetadataStep, /SmartScreen check: required separately/);
  assert.match(
    workflow,
    /WILLARD_VERSION_INPUT:\s*\$\{\{\s*inputs\.version\s*\}\}/,
  );
  assert.doesNotMatch(
    workflow,
    /\$version = "\$\{\{\s*inputs\.version\s*\}\}"/,
  );
  assert.match(workflow, /Reject an existing release tag/);
  assert.match(workflow, /\$existingTag = @\(& git ls-remote --tags origin/);
  assert.match(workflow, /\$existingTag\.Count -gt 0/);
  assert.match(workflow, /Install media fixture tools for backend audit/);
  assert.match(workflow, /choco install ffmpeg/);
  assert.match(workflow, /choco install zip/);
  const auditStep = workflow.slice(
    workflow.indexOf(
      "Run API server backend audit and backend integration tests",
    ),
    workflow.indexOf("Upload backend audit log on failure"),
  );
  assert.match(auditStep, /timeout-minutes:\s*30/);
  assert.match(auditStep, /WILLARD_AUDIT_TEST_TIMEOUT_MS:\s*"300000"/);
  assert.match(auditStep, /WILLARD_AUDIT_HEARTBEAT_MS:\s*"30000"/);
  assert.match(auditStep, /pnpm run audit:backend/);
  assert.match(
    auditStep,
    /-Environment\s+@\{[\s\S]*WILLARD_LOCAL_DATA_ROOT = \$env:RUNNER_TEMP[\s\S]*WILLARD_LOCAL_CAPACITY_FLOOR_BYTES = "0"[\s\S]*WILLARD_NAS_SAFETY_MARGIN_BYTES = "0"/,
  );
  assert.match(
    auditStep,
    /-WorkingDirectory \(Join-Path \$env:GITHUB_WORKSPACE "artifacts\\api-server"\)/,
  );
  assert.doesNotMatch(auditStep, /Get-Content [^\r\n]+ -Tail 80 -Raw/);
  assert.doesNotMatch(
    auditStep,
    /env:\s*[\s\S]*WILLARD_LOCAL_CAPACITY_FLOOR_BYTES:\s*"0"/,
  );
  assert.match(
    workflow,
    /fba577c4bb87df04d54dd87bbdaa5a2272f1f99a2acbf9152e1a91b8b5f0b279/,
  );
  assert.match(
    workflow,
    /e3be0545990c90995d7bf3a7af5d64af1f2e0fc1bbd9b79c27f7abc1e9676e50/,
  );
  assert.match(
    localBuildInstaller,
    /fba577c4bb87df04d54dd87bbdaa5a2272f1f99a2acbf9152e1a91b8b5f0b279/,
  );
  assert.match(
    localBuildInstaller,
    /e3be0545990c90995d7bf3a7af5d64af1f2e0fc1bbd9b79c27f7abc1e9676e50/,
  );
});

test("installer signing cleanup preserves certificates not introduced by this run", () => {
  assert.deepEqual(
    selectImportedCertificateCleanupCandidates({
      snapshotSucceeded: false,
      before: [],
      imported: [],
      current: ["EXISTING"],
    }),
    [],
    "malformed base64 or a failed snapshot must not remove store certificates",
  );
  assert.deepEqual(
    selectImportedCertificateCleanupCandidates({
      snapshotSucceeded: true,
      before: ["EXISTING"],
      imported: ["EXISTING"],
      current: ["EXISTING"],
    }),
    [],
    "an imported thumbprint that already existed must be preserved",
  );
  assert.deepEqual(
    selectImportedCertificateCleanupCandidates({
      snapshotSucceeded: true,
      before: ["EXISTING"],
      imported: ["LEAF", "CHAIN", "EXISTING"],
      current: ["EXISTING", "LEAF", "CHAIN", "UNRELATED"],
    }),
    ["CHAIN", "LEAF"],
    "only certificates both imported and introduced by this run are removable",
  );
});

test("Windows release publication is preceded by every required quality gate", () => {
  const publishIndex = workflow.indexOf(
    "Publish installer, update ZIP, and manifest",
  );
  assert.ok(publishIndex > 0, "release workflow must contain a publish step");

  for (const [stage, command] of [
    ["type checks and generated API contracts", "pnpm run typecheck"],
    ["type checks and generated API contracts", "pnpm run check:router"],
    ["type checks and generated API contracts", "pnpm run check:api-contracts"],
    ["unit and packaging contracts", "pnpm run test:database-backup"],
    ["unit and packaging contracts", "pnpm run test:release-contracts"],
    ["API server backend audit", "pnpm run audit:backend"],
    ["browser E2E suites", "pnpm exec playwright test"],
    ["storage-policy conformance", "pnpm run test:storage-conformance"],
    ["payload validation and dependency audit gate", "make-release.ps1"],
    ["Compile the Windows installer", "compile-installer.ps1"],
  ]) {
    const stageIndex = workflow.indexOf(stage);
    const commandIndex = workflow.indexOf(command);
    assert.ok(stageIndex >= 0, `missing release gate stage: ${stage}`);
    assert.ok(commandIndex >= 0, `missing release gate command: ${command}`);
    assert.ok(
      stageIndex < publishIndex && commandIndex < publishIndex,
      `${stage} must run before publication`,
    );
  }
  for (const browserSuite of [
    "e2e/loading-error-states.spec.ts",
    "e2e/origin-boundary.spec.ts",
    "e2e/dashboard-attention-center.spec.ts",
    "e2e/search.spec.ts",
  ]) {
    assert.ok(
      workflow.includes(browserSuite),
      `Windows release must run maintained browser suite ${browserSuite}`,
    );
  }

  assert.equal(
    rootPackage.scripts["audit:backend"],
    "pnpm --filter @workspace/api-server run audit",
  );
  assert.match(backendAudit, /cleanup-execute\.test\.ts/);
  assert.match(backendAudit, /dashboard-after-scan\.test\.ts/);
  assert.match(workflow, /pnpm exec playwright install chromium/);
  assert.match(workflow, /WILLARD_START_LOCAL_SERVERS: "true"/);
  assert.match(installerCompiler, /Get-FileHash \$setup -Algorithm SHA256/);
});

test("installed launcher serializes fresh starts and skips updates for an existing instance", () => {
  assert.match(launcher, /launcher-instance-lock\.ps1/);
  assert.match(launcherInstanceLock, /function Enter-WillardLauncherMutex/);
  assert.match(launcherInstanceLock, /WaitOne\(\$TimeoutMilliseconds\)/);
  assert.match(launcherInstanceLock, /AbandonedMutexException/);
  assert.match(launcherInstanceLock, /function Exit-WillardLauncherMutex/);

  const lockAcquire = launcher.indexOf("Enter-WillardLauncherMutex");
  const existingCheck = launcher.indexOf("$existing = Read-Pids");
  const updateCheck = launcher.lastIndexOf("  Try-Update\n");
  assert.ok(lockAcquire >= 0 && lockAcquire < existingCheck && existingCheck < updateCheck,
    "the startup lock must be acquired before the running-instance check and update check");

  const existingFlow = launcher.slice(existingCheck, updateCheck);
  assert.match(existingFlow, /Start-Process \$WebUrl/);
  assert.match(existingFlow, /Exit-WillardLauncherMutex \$script:LauncherMutex/);
  assert.doesNotMatch(existingFlow, /Try-Update/);

  const releaseCalls = launcher.match(/Exit-WillardLauncherMutex \$script:LauncherMutex/g) ?? [];
  assert.equal(releaseCalls.length, 4, "stop, existing-instance, normal-start, and failure paths must release the lock");

  assert.match(releaseStager, /desktop\/launcher-instance-lock\.ps1/);
  assert.match(fastValidationWorkflow, /Verify installed launcher serializes concurrent startup/);
});

test("installed updater verifies signed metadata before SemVer comparison", () => {
  const verifyIndex = launcher.indexOf('"--verify" $remoteManifestFile');
  const compareIndex = launcher.indexOf('"--compare" $remote.version $local');
  assert.ok(verifyIndex >= 0 && compareIndex > verifyIndex,
    "the signed release manifest must be verified before its version is used");
  assert.match(launcher, /version comparison/);
  assert.doesNotMatch(launcher, /\[version\]\(\$remote\.version -replace/);
});

test("packaged startup closes its owned loader and preserves actionable diagnostics on failure", () => {
  assert.match(launcher, /function Start-LoadingScreen/);
  assert.match(launcher, /Start-Process -FilePath \$LoadingScreen -PassThru/);
  assert.match(launcher, /function Close-LoadingScreen/);
  assert.match(launcher, /CloseMainWindow\(\)/);
  assert.match(launcher, /startup-failure\.log/);
  assert.match(launcher, /System\.Windows\.MessageBox/);
  assert.match(launcher, /Recover-InterruptedUpdateSwap/);
  assert.match(launcher, /\$env:PORT = "8080"/);
  assert.match(launcher, /Start-LoadingScreen/);
  assert.match(launcher, /\$env:WILLARD_7ZIP_PATH = \$BundledSevenZip/);
  assert.match(launcher, /\$apiProc = \$null/);
  assert.doesNotMatch(launcher, /if \(-not \(Ensure-Env\)\) \{ exit 1 \}/);
  assert.doesNotMatch(
    launcher,
    /if \(-not \(Test-Dependencies\)\) \{ exit 1 \}/,
  );
  assert.match(launcher, /throw "Willard needs database connection details/);

  const failureCatch = launcher.slice(launcher.lastIndexOf("} catch {"));
  assert.ok(
    failureCatch.indexOf("Close-LoadingScreen") <
      failureCatch.indexOf("Report-StartupFailure"),
  );
  assert.match(loaderPage, /const deadline = Date\.now\(\) \+ 150000/);
  assert.match(
    loaderPage,
    /const elapsed = document\.getElementById\("elapsed"\)/,
  );
  assert.match(loaderPage, /STARTING LOCAL SERVICES/);
  assert.match(loaderPage, /STARTUP NEEDS ATTENTION/);
  assert.match(loaderPage, /detail\.hidden = false/);
  assert.match(
    loaderPage,
    /return;\s*\n\s*}\s*\n\s*window\.setTimeout\(waitForWillard, 800\)/,
  );
});

test("installer compilation stops on warnings", () => {
  assert.match(installerCompiler, /ISCC\.exe/);
  assert.doesNotMatch(installerCompiler, /--messages-jsonl/);
  assert.match(installerCompiler, /warning\\s\*:/);
  assert.match(installerCompiler, /Inno Setup emitted warnings/);
  assert.match(localBuildInstaller, /compile-installer\.ps1/);
  assert.match(workflow, /compile-installer\.ps1/);
});

test("Windows release gate proves the installed lifecycle with external data", () => {
  assert.match(installedLifecycleSmoke, /RUNNER_TEMP.*postgresql\\pgsql\\bin/);
  assert.doesNotMatch(installedLifecycleSmoke, /ProgramFiles.*PostgreSQL\\16/);
  assert.match(installedLifecycleSmoke, /\$UserName = "wl_life_/);
  assert.match(installedLifecycleSmoke, /first-install-setup\.log/);
  assert.match(installedLifecycleSmoke, /upgrade-install-setup\.log/);
  assert.match(installedLifecycleSmoke, /first-install-Setup\.exe/);
  assert.match(installedLifecycleSmoke, /upgrade-install-Setup\.exe/);
  assert.match(installedLifecycleSmoke, /Lifecycle diagnostics preserved/);
  assert.match(
    installedLifecycleSmoke,
    /Could not grant lifecycle user access/,
  );
  assert.match(installedLifecycleSmoke, /Lifecycle file:/);
  assert.match(installedLifecycleSmoke, /UserProfile = Join-Path/);
  assert.match(installedLifecycleSmoke, /TEMP = \$script:UserTemp/);
  assert.match(installedLifecycleSmoke, /WaitForExit/);
  assert.match(installedLifecycleSmoke, /Lifecycle: first install/);
  assert.match(installedLifecycleSmoke, /WILLARD_RECOVERY_EXPORT_PATH/);
  assert.match(installedLifecycleSmoke, /WILLARD_RECOVERY_EXPORT_PASSPHRASE/);
  const compileIndex = workflow.indexOf("Compile the Windows installer");
  const lifecycleIndex = workflow.indexOf(
    "Verify installed Windows lifecycle with external PostgreSQL",
  );
  const publishIndex = workflow.indexOf(
    "Publish installer, update ZIP, and manifest",
  );
  assert.ok(
    compileIndex >= 0 &&
      lifecycleIndex > compileIndex &&
      lifecycleIndex < publishIndex,
  );
  assert.match(workflow, /installer-lifecycle-smoke\.ps1/);
  assert.match(workflow, /Bootstrap disposable backend-audit database schema/);
  assert.match(workflow, /Seed disposable backend-audit settings/);
  assert.match(workflow, /setup-db\.cjs/);
  assert.match(workflow, /WILLARD_API_URL: "http:\/\/127\.0\.0\.1:8080"/);
  assert.match(workflow, /VALUES \(\$1, \$2\)/);
  assert.match(workflow, /bcryptjs/);
  assert.doesNotMatch(workflow, /api\/auth\/setup/);
  assert.match(installedLifecycleSmoke, /New-LocalUser/);
  assert.match(
    installedLifecycleSmoke,
    /Get-LocalGroupMember -Group "Administrators"/,
  );
  assert.match(
    installedLifecycleSmoke,
    /-Credential \$Credential -LoadUserProfile/,
  );
  assert.match(installedLifecycleSmoke, /VERYSILENT.*SUPPRESSMSGBOXES.*\/DIR/);
  assert.match(
    installedLifecycleSmoke,
    /Wait-Http "http:\/\/127\.0\.0\.1:8080\/api\/healthz"/,
  );
  assert.match(installedLifecycleSmoke, /compile-installer\.ps1/);
  assert.match(installedLifecycleSmoke, /phase = "swapped"/);
  assert.match(installedLifecycleSmoke, /candidate-only\.marker/);
  assert.match(installedLifecycleSmoke, /startup-failure\.log/);
  assert.match(installedLifecycleSmoke, /unins000\.exe/);
  assert.match(installedLifecycleSmoke, /Upgrade removed or duplicated the Start Menu shortcut/);
  assert.match(installedLifecycleSmoke, /Uninstall left the Start Menu shortcut behind/);
  assert.match(installedLifecycleSmoke, /willard_lifecycle_marker/);
  assert.match(installedLifecycleSmoke, /Dropdb/);
  assert.match(launcher, /WILLARD_SUPPRESS_STARTUP_DIALOG/);
});

test("release payload validation requires the bundled runtime and app entrypoints", () => {
  assert.match(releaseValidator, /runtime\/node\.exe/);
  assert.match(releaseValidator, /api-runtime\/dist\/index\.mjs/);
  assert.match(releaseValidator, /api-runtime\/setup-db\.cjs/);
  assert.match(releaseValidator, /desktop\/loading\.html/);
  assert.match(releaseValidator, /web\/willard-loading\.mp4/);
  assert.match(releaseValidator, /payload-manifest\.json/);
  assert.match(releaseValidator, /onnxruntime-node/);
  assert.match(releaseValidator, /api-runtime\/vendor\/7zip\/7z\.exe/);
  assert.match(releaseValidator, /api-runtime\/vendor\/7zip\/7z\.dll/);
  assert.match(releaseValidator, /api-runtime\/vendor\/7zip\/License\.txt/);
  assert.match(releaseValidator, /Packaged Windows release must contain verified official 7-Zip 26\.05/);
  assert.match(releaseValidator, /web\/index\.html/);
  assert.match(releaseValidator, /desktop\/database-backup\.mjs/);
  assert.match(releaseStager, /desktop\/database-backup\.mjs/);
  assert.match(releaseValidator, /desktop\/backup-credentials\.mjs/);
  assert.match(releaseValidator, /desktop\/library-recovery\.mjs/);
  assert.match(releaseStager, /desktop\/backup-credentials\.mjs/);
  assert.match(releaseStager, /desktop\/library-recovery\.mjs/);
  assert.match(releaseValidator, /WILLARD_RELEASE_ZIP/);
  assert.match(releaseValidator, /validateReleaseManifest/);
  assert.match(releaseValidator, /sha256.*match/i);
  assert.match(releaseValidator, /sharp.*package\.json/);
  assert.match(releaseValidator, /sharpManifest\.version !== "0\.35\.2"/);
});

test("release validation gates high and critical image parser advisories in both runtime graphs", () => {
  assert.match(releaseValidator, /ComSpec \|\| "cmd\.exe"/);
  assert.match(releaseValidator, /pnpm\.cmd/);
  const findings = findHighSeverityImageAdvisories(
    {
      advisories: {
        "api-image": {
          module_name: "image-size",
          severity: "high",
          title: "Image parser denial of service",
          findings: [
            {
              version: "1.2.1",
              paths: ["artifacts__willard-mobile>@expo/cli>image-size"],
            },
          ],
        },
        "api-sharp": {
          module_name: "sharp",
          severity: "critical",
          title: "Sharp parser issue",
          findings: [
            {
              version: "0.35.1",
              paths: ["artifacts__api-server>sharp"],
            },
          ],
        },
        unrelated: {
          module_name: "tar",
          severity: "critical",
          title: "Archive issue",
          findings: [
            {
              version: "7.5.20",
              paths: ["artifacts__willard-mobile>@expo/cli>tar"],
            },
          ],
        },
        "below-threshold": {
          module_name: "image-size",
          severity: "moderate",
          title: "Not a release-blocking severity",
          findings: [
            {
              version: "1.2.0",
              paths: ["artifacts__api-server>image-size"],
            },
          ],
        },
      },
    },
    {
      "API runtime": "artifacts__api-server>",
      "Mobile toolchain": "artifacts__willard-mobile>",
    },
  );

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
  assert.match(
    releaseValidator,
    /High or critical image-processing advisories/,
  );
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
  assert.match(releaseStager, /process\.env\.ComSpec \|\| "cmd\.exe"/);
  assert.match(releaseStager, /\["\/d", "\/c", pnpmCommand, \.\.\.args\]/);
  assert.match(releaseStager, /"--config\.frozen-lockfile=false"/);
  assert.match(
    releaseStager,
    /"--config\.inject-workspace-packages=true",\s+"--filter"/,
  );
  assert.match(releaseStager, /stdio: "inherit"/);
  assert.match(releaseBuilder, /Windows release staging failed/);
  assert.match(pnpmWorkspace, /forceLegacyDeploy:\s*true/);
  assert.match(workflow, /PORT: "5000"/);
  assert.match(workflow, /BASE_PATH: "\/"/);
});

test("developer updater is Git-first with a verified archive fallback", () => {
  assert.match(updater, /gitCommand/);
  assert.match(updater, /pull --ff-only origin/);
  assert.match(updater, /sourceArtifactUrl/);
  assert.match(updater, /failed checksum verification/);
  assert.match(updater, /statusCode -eq 404/);
  assert.match(updater, /No verified GitHub release is published yet/);
  assert.match(updater, /current folder was left unchanged/);
});

test("developer startup launches the API directly and fails when that process exits", () => {
  assert.doesNotMatch(developerLauncher, /Start-Process -FilePath "cmd\.exe"/);
  assert.ok(developerLauncher.includes('--env-file=`"$envFile`"'));
  assert.ok(developerLauncher.includes('"`"$apiDist`""'));
  assert.match(developerLauncher, /-FilePath \$nodeCommand/);
  assert.match(developerLauncher, /\$env:PORT = "8080"/);
  assert.match(developerLauncher, /schema-ready\.json/);
  assert.match(developerLauncher, /Get-FileHash/);
  assert.match(developerLauncher, /\$env:WILLARD_SCHEMA_READY = "1"/);
  assert.match(developerLauncher, /dependencies-ready\.json/);
  assert.match(developerLauncher, /pnpm-lock\.yaml/);
  assert.match(developerLauncher, /"pnpm\.cmd", "pnpm\.exe"/);
  assert.doesNotMatch(
    developerLauncher,
    /Get-Command pnpm -ErrorAction SilentlyContinue\)\.Source/,
  );
  assert.doesNotMatch(developerLauncher, /pull --ff-only origin/);
  assert.doesNotMatch(developerLauncher, /Checking for safe updates/);
  assert.doesNotMatch(
    developerLauncher,
    /Start-Process -FilePath \$powershellCommand/,
  );
  assert.match(
    developerLauncher,
    /Wait-ForUrl \$ApiUrl "your library service" \$apiReadyTimeout \$services\.api\.Id/,
  );
  assert.match(developerLauncher, /\$apiReadyTimeout = 180/);
  assert.doesNotMatch(developerLauncher, /automatic restart/);
  assert.doesNotMatch(
    developerLauncher,
    /Read-Host "  Press Enter to close this launcher window"/,
  );
  assert.match(launcherCommon, /process exited before it became ready/);
  assert.match(launcherCommon, /Get-LogTail/);
  assert.match(launcherCommon, /function Wait-ForDatabase/);
  assert.match(developerLauncher, /Wait-ForDatabase 30/);
  assert.doesNotMatch(developerLauncher, /Show-Failure \$friendly \$technical/);
  assert.match(launcherCommon, /Get-CimInstance -ClassName Win32_Process/);
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
  assert.match(launcherCommon, /Get-UnsafeDeveloperWorktreeEntries/);
  assert.match(launcherCommon, /setup-quarantine/);
  assert.match(launcherCommon, /Restore-SetupQuarantineNonConflicting/);
  assert.doesNotMatch(launcherCommon, /gitCommand -C \$Root add -A/);
  assert.match(updater, /signed release archive remains a fallback/);
});

test("developer updates preserve local reference assets without ignoring source edits", () => {
  assert.match(updater, /attached_assets/);
  assert.match(updater, /status --porcelain=v1 --untracked-files=all/);
  assert.match(updater, /StartsWith\("\?\?"\)/);
  assert.match(
    updater,
    /Copy-PreservedDeveloperState \$candidate -IncludeLogs/,
  );
  assert.match(updater, /tracked source edits/);
});

test("Windows launchers generate cryptographic session secrets for new installs", () => {
  assert.match(launcherCommon, /RandomNumberGenerator\]::Create\(\)/);
  assert.match(launcherCommon, /\$secretBytes = New-Object byte\[\] 32/);
  assert.match(launcherCommon, /\$rng\.GetBytes\(\$secretBytes\)/);
  assert.doesNotMatch(launcherCommon, /\$secret = -join .*Get-Random/);
  const helperNames = [];
  let hereStringTerminator = null;
  for (const line of launcherCommon.split(/\r?\n/)) {
    if (hereStringTerminator) {
      if (line.trim() === hereStringTerminator) hereStringTerminator = null;
      continue;
    }
    const match = line.match(/^\s*function\s+([A-Za-z0-9_-]+)/);
    if (match) helperNames.push(match[1]);
    const opener = line.match(/=\s*@(['"])\s*$/);
    if (opener) hereStringTerminator = opener[1] === "'" ? "'@" : '"@';
  }
  assert.equal(new Set(helperNames).size, helperNames.length, "PowerShell launcher helpers must not be duplicated");
  const finalHelperStart = launcherCommon.lastIndexOf("function Wait-ForUrl(");
  assert.ok(finalHelperStart >= 0, "the final shared helper must be present");
  const finalHelper = launcherCommon.slice(finalHelperStart);
  assert.match(finalHelper, /return \$false\r?\n\}\s*$/, "shared PowerShell helpers must end at the complete Wait-ForUrl function");
  assert.doesNotMatch(finalHelper, /,\s*"SESSION_SECRET=\$secret"/, "orphaned secret-write fragments must not remain after the final helper");
  const ensureEnvStart = launcherCommon.indexOf("function Ensure-EnvFile {");
  const ensureEnvEnd = launcherCommon.indexOf("\nfunction New-WillardShortcut", ensureEnvStart);
  const ensureEnv = launcherCommon.slice(ensureEnvStart, ensureEnvEnd);
  assert.match(launcherCommon, /\[System\.Text\.UTF8Encoding\]::new\(\$false\)/);
  assert.match(launcherCommon, /\[System\.IO\.File\]::WriteAllLines\(\$envPath, \[string\[\]\]\$updatedEnv, \$utf8NoBom\)/);
  assert.ok(
    ensureEnv.includes("[System.IO.File]::WriteAllLines($envPath, [string[]]$updatedEnv, $utf8NoBom)"),
    "Ensure-EnvFile must persist the generated secret as UTF-8 without a BOM",
  );
  assert.doesNotMatch(ensureEnv, /Set-Content/);
  assert.match(launcher, /RandomNumberGenerator\]::Create\(\)/);
  assert.match(launcher, /\$sessionSecretBytes = New-Object byte\[\] 32/);
  assert.match(launcher, /\$sessionSecretRng\.GetBytes\(\$sessionSecretBytes\)/);
  assert.match(launcher, /SESSION_SECRET=\$sessionSecret/);
  assert.doesNotMatch(launcher, /SESSION_SECRET=.*Get-Random/);
});

test("Windows backup credentials use native user-scoped DPAPI with legacy compatibility", () => {
  for (const credentialLauncher of [launcherCommon, launcher]) {
    assert.match(credentialLauncher, /ProtectedData\]::Protect/);
    assert.match(credentialLauncher, /ProtectedData\]::Unprotect/);
    assert.match(credentialLauncher, /DataProtectionScope\]::CurrentUser/);
    assert.match(credentialLauncher, /dpapi-v2:/);
    assert.match(credentialLauncher, /ConvertTo-SecureString \$stored/);
  }
  assert.match(setupLauncher, /-OfferCredentialReset/);
  assert.match(developerLauncher, /-OfferCredentialReset/);
  assert.match(repairLauncher, /Library backup protection is ready/);
});

test("database setup quotes special names and parameterizes catalog lookup", async () => {
  const calls = [];
  let instance = 0;
  class Client {
    constructor() {
      this.instance = instance++;
    }
    async connect() {
      if (this.instance === 0) {
        const error = new Error("database does not exist");
        error.code = "3D000";
        throw error;
      }
    }
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith("SELECT 1 FROM pg_database")) return { rows: [] };
      return { rows: [] };
    }
    async end() {}
  }

  const name = 'family archive"2026';
  assert.equal(
    getDatabaseName(
      "postgresql://user:pass@localhost:5432/family%20archive%222026",
    ),
    name,
  );
  assert.equal(quoteIdentifier(name), '"family archive""2026"');
  await ensureDatabase(
    "postgresql://user:pass@localhost:5432/family%20archive%222026",
    Client,
  );
  assert.deepEqual(calls[0], {
    sql: "SELECT 1 FROM pg_database WHERE datname = $1",
    params: [name],
  });
  assert.equal(calls[1].sql, 'CREATE DATABASE "family archive""2026"');
});

test("database setup rejects invalid names and explains restricted roles safely", async () => {
  assert.throws(
    () => getDatabaseName("postgresql://user:pass@localhost:5432/%ZZ"),
    /not a valid PostgreSQL connection string/,
  );
  assert.throws(
    () =>
      getDatabaseName(
        "postgresql://user:pass@localhost:5432/" + "a".repeat(64),
      ),
    /no longer than 63 bytes/,
  );

  let ended = false;
  let restrictedInstance = 0;
  class RestrictedClient {
    constructor() {
      this.instance = restrictedInstance++;
    }
    async connect() {
      if (this.instance === 0) {
        const error = new Error("database does not exist");
        error.code = "3D000";
        throw error;
      }
    }
    async query(sql) {
      if (sql.startsWith("SELECT 1 FROM pg_database")) return { rows: [] };
      const error = new Error("permission denied to create database");
      error.code = "42501";
      throw error;
    }
    async end() {
      ended = true;
    }
  }
  await assert.rejects(
    ensureDatabase(
      "postgresql://reader:pass@localhost:5432/family",
      RestrictedClient,
    ),
    /cannot create databases.*grant CREATEDB/i,
  );
  assert.equal(ended, true);

  let clientCount = 0;
  class ExistingDatabaseClient {
    constructor() {
      clientCount += 1;
    }
    async connect() {}
    async query() {
      throw new Error("existing target should not query maintenance database");
    }
    async end() {}
  }
  await ensureDatabase(
    "postgresql://reader:pass@localhost:5432/existing",
    ExistingDatabaseClient,
  );
  assert.equal(clientCount, 1);

  let maintenanceDeniedInstance = 0;
  class MaintenanceDeniedClient {
    constructor() {
      this.instance = maintenanceDeniedInstance++;
    }
    async connect() {
      const error = new Error(
        this.instance === 0
          ? "database does not exist"
          : "permission denied for database postgres",
      );
      error.code = this.instance === 0 ? "3D000" : "42501";
      throw error;
    }
    async end() {}
  }
  await assert.rejects(
    ensureDatabase(
      "postgresql://reader:pass@localhost:5432/missing",
      MaintenanceDeniedClient,
    ),
    /cannot access the maintenance database.*administrator/i,
  );
});

test("launcher database helper also uses target-first least-privilege setup", () => {
  assert.match(launcherCommon, /datname = \$1/);
  assert.doesNotMatch(launcherCommon, /datname = [`'"]?\s*\+/);
  assert.match(launcherCommon, /error\.code !== '3D000'/);
  assert.match(launcherCommon, /if \(targetExists\) return/);
  assert.match(launcherCommon, /cannot access[\s\S]*maintenance database/);
});

test("Windows startup smoke test covers readiness, ownership, and web failure diagnostics", () => {
  assert.match(workflow, /startup-smoke\.ps1/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(
    workflow,
    /Install PostgreSQL for the source launcher smoke test/,
  );
  assert.match(workflow, /postgresql-16\.15-1-windows-x64-binaries\.zip/);
  assert.match(startupSmoke, /\$env:WILLARD_NO_PAUSE = "1"/);
  assert.match(
    startupSmoke,
    /\$env:LOCALAPPDATA = Join-Path \$env:RUNNER_TEMP "willard-startup-localappdata"/,
  );
  assert.match(startupSmoke, /\$env:WILLARD_SKIP_BROWSER = "1"/);
  assert.match(startupSmoke, /\$env:WILLARD_CI_BACKUP_PASSPHRASE = /);
  assert.match(
    launcherCommon,
    /\$env:CI -eq "true" -and \$env:WILLARD_CI_BACKUP_PASSPHRASE/,
  );
  assert.match(developerLauncher, /\$env:WILLARD_SKIP_BROWSER -ne "1"/);
  assert.match(
    startupSmoke,
    /\$env:WILLARD_RECOVERY_EXPORT_PATH = Join-Path \$env:RUNNER_TEMP/,
  );
  assert.match(startupSmoke, /\$env:WILLARD_RECOVERY_EXPORT_PASSPHRASE = /);
  assert.match(
    startupSmoke,
    /\$launcherArguments = @\([^)]*\) \+ @\(\$arguments\)/,
  );
  assert.match(startupSmoke, /\$powershell = \(Get-Process -Id \$PID\)\.Path/);
  assert.match(startupSmoke, /-ArgumentList \$launcherArguments/);
  assert.match(startupSmoke, /\$process\.WaitForExit\(240000\)/);
  assert.doesNotMatch(startupSmoke, /-PassThru -Wait/);
  assert.match(
    startupSmoke,
    /Launcher process did not exit within 240 seconds[\s\S]*Read-Text \$outputPath[\s\S]*Read-Text \(\$outputPath \+ "\.err"\)/,
  );
  assert.match(
    startupSmoke,
    /Invoke-Launcher @\("-File", \$Start\) \$SmokeOutput/,
  );
  assert.doesNotMatch(startupSmoke, /Invoke-Launcher @\("-File", \$Batch\)/);
  assert.match(
    startupSmoke,
    /echo deliberate web startup failure\r?\nexit \/b 1/,
  );
  assert.match(
    workflow,
    /25e6fcdfb8caec38691bf461125e7564508760666f7b8e5dc6a5f0818f58f81e/,
  );
  assert.match(workflow, /pg_ctl\.exe/);
  assert.match(workflow, /pg_isready\.exe/);
  assert.doesNotMatch(workflow, /choco install postgresql/);
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

test("Windows release runs replacement recovery from the packaged payload", () => {
  assert.match(workflow, /replacement-recovery-smoke\.ps1/);
  assert.match(replacementRecoverySmoke, /source checkout, package manager/);
  assert.match(replacementRecoverySmoke, /runtime\\node\.exe/);
  assert.match(replacementRecoverySmoke, /desktop\\database-backup\.mjs/);
  assert.match(replacementRecoverySmoke, /WILLARD_RECOVERY_EXPORT_PASSPHRASE/);
  assert.match(replacementRecoverySmoke, /wrong-passphrase/);
  assert.match(replacementRecoverySmoke, /missing-nas/);
  assert.match(replacementRecoverySmoke, /partial-backup/);
  assert.match(replacementRecoverySmoke, /recovery-attempts/);
  assert.match(replacementRecoverySmoke, /"COMPLETE"/);
  assert.match(replacementRecoverySmoke, /\/api\/healthz/);
  assert.match(replacementRecoverySmoke, /New-LocalUser/);
  assert.match(replacementRecoverySmoke, /-Credential \$Credential -LoadUserProfile/);
});

test("installer coordinates upgrades and repair reports failures", async () => {
  const repair = await readFile(
    new URL("../launcher/repair.ps1", import.meta.url),
    "utf8",
  );
  assert.match(config, /PrepareToInstall/);
  assert.match(config, /WillardMediaCenter\.ps1[\s\S]*-Stop/);
  assert.match(repair, /\$problems\.Count -gt 0\) \{ exit 1 \}/);
});

test("developer updater journal replacement is atomic without backup artifacts", () => {
  assert.match(launcherCommon, /\$replacementBackup = "\$journalPath\.\$writeId\.bak"/);
  assert.match(
    launcherCommon,
    /\[System\.IO\.File\]::Replace\(\$temporary, \$journalPath, \$replacementBackup\)/,
  );
  assert.match(
    launcherCommon,
    /Remove-Item -LiteralPath \$replacementBackup -Force -ErrorAction SilentlyContinue/,
  );
  assert.doesNotMatch(
    launcherCommon,
    /\[System\.IO\.File\]::Replace\(\$temporary, \$journalPath, \$null\)/,
  );
  assert.doesNotMatch(launcherCommon, /\$journalBackup/);
});

test("developer fallback stages a complete source archive", async () => {
  const updater = await readFile(
    new URL("../launcher/update.ps1", import.meta.url),
    "utf8",
  );
  assert.match(updater, /sourceArtifactUrl/);
  assert.match(updater, /sourceSha256/);
  assert.match(updater, /Expand-Archive/);
  assert.match(updater, /The developer-source archive was empty or malformed/);
  assert.match(updater, /failed checksum verification/);
  assert.match(updater, /robocopy/);
  assert.match(updater, /Copy-PreservedDeveloperState/);
  assert.match(updater, /Complete-DeveloperUpdate/);
  assert.match(launcherCommon, /Invoke-DeveloperVersionSwap/);
  assert.match(launcherCommon, /Write-DeveloperUpdateJournal/);
});

test("developer updater preserves full runnable versions and rolls back failed candidate updates", () => {
  assert.match(updater, /status --porcelain/);
  assert.match(updater, /Detected:/);
  assert.match(updater, /New-CandidateDirectory/);
  assert.match(updater, /clone --quiet --no-hardlinks/);
  assert.match(updater, /--branch \$GithubBranch --single-branch \$GithubRepo/);
  assert.match(
    updater,
    /New-Item -ItemType Directory -Force \(Join-Path \$candidate "logs"\)/,
  );
  assert.match(
    updater,
    /Copy-PreservedDeveloperState \$candidate -IncludeLogs/,
  );
  assert.match(updater, /Exclude @\("update\.log"\)/);
  assert.match(updater, /Copy-PreservedDeveloperState \$candidate/);
  assert.match(updater, /Start-ExternalDeveloperVersionSwap/);
  assert.match(updater, /Get-Process -Id \$UpdaterPid/);
  assert.match(updater, /Start-Process -FilePath "powershell\.exe"/);
  assert.match(updater, /WILLARD_UPDATE_FAIL_AT/);
  assert.match(updater, /--ignore-scripts/);
  assert.match(updater, /api-server run build/);
  assert.match(updater, /Test-FileLockFailure/);
  assert.match(updater, /Stopping Willard-owned services and retrying/);
  assert.match(updater, /Start-Sleep -Seconds 2/);
  assert.match(launcherCommon, /Restore-PendingDeveloperUpdate/);
  assert.match(launcherCommon, /Recover-InterruptedDeveloperUpdate/);
  assert.match(launcherCommon, /Confirm-DeveloperUpdateHealth/);
  assert.match(
    developerLauncher,
    /Verifying the updated version before removing its rollback copy/,
  );
  assert.match(
    developerLauncher,
    /previous runnable version was restored after the update did not become healthy/,
  );
});

test("local developer launch clears stale Willard service workers before loading Vite", () => {
  assert.match(webIndex, /navigator\.serviceWorker\.controller/);
  assert.match(webIndex, /fetch\("\/@vite\/client"/);
  assert.match(webIndex, /willard-shell-/);
  assert.match(webIndex, /registration\.unregister\(\)/);
  assert.match(webIndex, /location\.reload\(\)/);
});

test("Windows update swaps are journaled and recoverable across copied, locked, or interrupted versions", () => {
  assert.match(updater, /candidate-copy/);
  assert.match(updater, /install/);
  assert.match(updater, /build/);
  assert.match(launcherCommon, /swap-after-backup/);
  assert.match(launcher, /WILLARD_PACKAGED_UPDATE_FAIL_AT/);
  assert.match(launcher, /candidate-copy/);
  assert.match(launcher, /swap-after-backup/);
  assert.match(launcher, /backup-created/);
  assert.match(launcher, /Remove-UpdateJournal/);
});

test("updater smoke can create its temporary branch from a detached source checkout", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "willard-detached-update-smoke-"));
  const source = join(temporaryRoot, "source");
  const remote = join(temporaryRoot, "remote");
  const runGit = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  try {
    mkdirSync(source, { recursive: true });
    runGit(["init", "--quiet", source]);
    runGit(["-C", source, "config", "user.email", "smoke@example.invalid"]);
    runGit(["-C", source, "config", "user.name", "Detached checkout regression"]);
    writeFileSync(join(source, "README.md"), "source\n");
    runGit(["-C", source, "add", "README.md"]);
    runGit(["-C", source, "commit", "--quiet", "-m", "initial"]);
    const sourceHead = runGit(["-C", source, "rev-parse", "HEAD"]).trim();
    const sourceBranch = runGit(["-C", source, "branch", "--show-current"]).trim();
    runGit(["-C", source, "checkout", "--quiet", "--detach", sourceHead]);
    runGit(["-C", source, "update-ref", "-d", `refs/heads/${sourceBranch}`]);
    runGit(["clone", "--quiet", source, remote]);

    assert.equal(
      runGit(["-C", remote, "branch", "--show-current"]).trim(),
      "",
      "the cloned source should reproduce a detached CI checkout",
    );

    const branch = "smoke-update-regression";
    runGit(["-C", remote, "checkout", "--quiet", "-b", branch]);
    assert.equal(runGit(["-C", remote, "branch", "--show-current"]).trim(), branch);
    assert.match(updateSmoke, /git -C \$Remote checkout --quiet -b \$remoteBranch/);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Fast Validation updater smoke checks out complete Git history for its local remote", () => {
  const jobStart = fastValidationWorkflow.indexOf("windows-archive-and-updater-smoke:");
  assert.ok(jobStart >= 0, "Fast Validation must contain the Windows updater smoke job");
  const checkoutStart = fastValidationWorkflow.indexOf("uses: actions/checkout@", jobStart);
  const checkoutEnd = fastValidationWorkflow.indexOf("\n\n", checkoutStart);
  assert.ok(checkoutStart > jobStart && checkoutEnd > checkoutStart);
  assert.match(fastValidationWorkflow.slice(checkoutStart, checkoutEnd), /fetch-depth:\s*0/);
});

test("Windows update smoke test exercises Git, preservation, and rollback on a real runner", () => {
  assert.match(updateSmoke, /git clone/);
  assert.match(updateSmoke, /\$remoteBranch = "smoke-update-\$\(\[guid\]::NewGuid\(\)\.ToString\('N'\)\)"/);
  assert.match(updateSmoke, /git -C \$Remote checkout --quiet -b \$remoteBranch/);
  assert.doesNotMatch(updateSmoke, /git -C \$Remote branch --show-current/);
  assert.match(updateSmoke, /function Wait-ForUpdateSwap/);
  assert.match(updateSmoke, /Wait-ForUpdateSwap \$Install/);
  assert.match(updateSmoke, /Wait-ForUpdateSwap \$Install 60 "failed"/);
  assert.match(
    updater,
    /Injected update failure after creating the rollback version/,
  );
  assert.match(updateSmoke, /WILLARD_UPDATE_REPO/);
  assert.match(updateSmoke, /Local changes were not protected/);
  assert.match(updateSmoke, /unreachable\/willard-ai/);
  assert.match(updateSmoke, /failed rebuild did not restore/);
  assert.match(updateSmoke, /postgres-data\.marker/);
  assert.match(updateSmoke, /media-path\.txt/);
  assert.match(updateSmoke, /New-WillardShortcut/);
  assert.match(updateSmoke, /WScript\.Shell/);
  assert.match(updateSmoke, /node_modules/);
  assert.match(updateSmoke, /dist\\index\.mjs/);
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

test("Windows release stages only hash-verified official 7-Zip binaries", () => {
  assert.match(releaseStager, /prepare-official-7zip\.ps1/);
  assert.match(releaseStager, /vendor", "7zip"/);
  assert.match(launcher, /api-runtime\\vendor\\7zip\\7z\.exe/);
  assert.match(launcher, /WILLARD_7ZIP_PATH/);
  assert.match(officialSevenZipBootstrap, /Get-FileHash .*SHA256/);
  assert.match(officialSevenZipBootstrap, /9bf582b894dfa665f852d7e9112b02290a1c303c2d95a21fcdc41ffcb03143b7/);
  assert.match(officialSevenZipBootstrap, /f27a8f103c84785026edcba1f67faf1357225df9d19ddb0b7760d55947141bc7/);
  assert.match(officialSevenZipBootstrap, /fd99e86f57d8f429ef5ed045bf98315af962e2309b0f1ba87a147a44c71647d0/);
});


test("manual Windows installer validation can skip release publication", () => {
  assert.match(workflow, /validate_only:[\s\S]*?type: boolean[\s\S]*?default: true/);
  assert.match(
    workflow,
    /if: \$\{\{ github\.event_name != 'workflow_dispatch' \|\| inputs\.validate_only != true \}\}/,
  );
});


test("packaged updater enforces its signed minimum Windows requirement before downloading", () => {
  const signatureCheck = launcher.indexOf('"--verify"');
  const compatibilityCheck = launcher.indexOf('"Windows compatibility check"');
  const releaseDownload = launcher.indexOf('"release download"');
  assert.ok(signatureCheck >= 0, "The packaged updater must verify the release signature.");
  assert.ok(compatibilityCheck > signatureCheck, "Windows compatibility must be checked after signature verification.");
  assert.ok(releaseDownload > compatibilityCheck, "Windows compatibility must be checked before downloading the artifact.");
  assert.match(launcher, /Get-CimInstance -ClassName Win32_OperatingSystem/);
  assert.match(launcher, /--compare-windows/);
  assert.match(launcher, /minimumWindowsVersion/);
});

test("uninstaller stops the application after confirmation and aborts if shutdown fails", () => {
  const uninstallStart = config.indexOf("procedure CurUninstallStepChanged");
  const uninstall = config.slice(uninstallStart);
  const stopHelperStart = config.indexOf("function StopWillardServices");
  const stopHelperEnd = config.indexOf("\nfunction PrepareToInstall", stopHelperStart);
  const stopHelper = config.slice(stopHelperStart, stopHelperEnd);
  assert.match(uninstall, /CurUninstallStep = usUninstall/);
  assert.match(uninstall, /StopWillardServices\(True\)/);
  assert.match(uninstall, /SuppressibleMsgBox/);
  assert.match(uninstall, /Abort/);
  assert.match(stopHelper, /could not start its shutdown helper/);
});

test("installer upgrade and uninstall refuse to proceed when the packaged shutdown helper is missing", () => {
  const stopHelperStart = config.indexOf("function StopWillardServices");
  const stopHelperEnd = config.indexOf("\nfunction PrepareToInstall", stopHelperStart);
  const stopHelper = config.slice(stopHelperStart, stopHelperEnd);
  assert.match(stopHelper, /function StopWillardServices\(RequireLauncher: Boolean\)/);
  assert.match(stopHelper, /if not FileExists\(Launcher\) then/);
  assert.match(stopHelper, /if RequireLauncher then/);
  assert.match(stopHelper, /shutdown helper is missing/);
  assert.match(stopHelper, /reinstall or repair/i);

  const prepareStart = config.indexOf("function PrepareToInstall");
  const prepareEnd = config.indexOf("\nprocedure CurUninstallStepChanged", prepareStart);
  const prepare = config.slice(prepareStart, prepareEnd);
  assert.ok(prepare.includes("FileExists(ExistingRuntime)"),
    "Fresh installs may omit the old shutdown helper, but an existing packaged runtime must require it.");
  assert.ok(prepare.includes("StopWillardServices(FileExists(ExistingRuntime))"));

  const uninstall = config.slice(config.indexOf("procedure CurUninstallStepChanged"));
  assert.match(uninstall, /StopWillardServices\(True\)/);
});

test("packaged process-state and WMI failures fail closed instead of hiding running services", () => {
  const pidStart = launcher.indexOf("function Read-Pids {");
  const pidEnd = launcher.indexOf("\nfunction Get-ProcessIdentity", pidStart);
  const pidReader = launcher.slice(pidStart, pidEnd);
  assert.match(pidReader, /ConvertFrom-Json -ErrorAction Stop/);
  assert.match(pidReader, /services state file is unreadable or invalid/);
  assert.match(pidReader, /rename or delete this file/);
  assert.match(pidReader, /executable identity information/);
  assert.doesNotMatch(pidReader, /catch \{ return \$null \}/);

  const identityStart = launcher.indexOf("function Get-ProcessIdentity");
  const identityEnd = launcher.indexOf("\nfunction Test-ProcessIdentity", identityStart);
  const identityReader = launcher.slice(identityStart, identityEnd);
  assert.match(identityReader, /could not verify the identity of Willard process/);
  assert.match(identityReader, /did not return enough identity information/);
  assert.doesNotMatch(identityReader, /catch \{ return \$null \}/);
});

test("packaged launcher detects orphaned API and web processes before startup or shutdown", () => {
  const discoveryStart = launcher.indexOf("function Test-CommandLineContainsExactPath");
  const discoveryEnd = launcher.indexOf("\nfunction Is-Alive", discoveryStart);
  assert.ok(discoveryStart >= 0 && discoveryEnd > discoveryStart, "Packaged orphan discovery helpers must be present.");
  const discovery = launcher.slice(discoveryStart, discoveryEnd);
  assert.match(discovery, /Get-CimInstance -ClassName Win32_Process -ErrorAction Stop/);
  assert.match(discovery, /\$Node/);
  assert.match(discovery, /\$Api/);
  assert.match(discovery, /\$WebServer/);
  assert.match(discovery, /OrdinalIgnoreCase/);
  assert.match(discovery, /not safely recorded/);
  assert.doesNotMatch(discovery, /taskkill|Stop-Process|\.Kill\(|Remove-Item/);

  const stopStart = launcher.indexOf("function Stop-Services {");
  const stopEnd = launcher.indexOf("\nfunction Stop-StartedProcess", stopStart);
  const stop = launcher.slice(stopStart, stopEnd);
  assert.ok(stop.indexOf("Assert-NoUntrackedPackagedServices $pids") >= 0);
  assert.ok(stop.indexOf("Assert-NoUntrackedPackagedServices $pids") < stop.indexOf("taskkill"));

  const startupRead = launcher.indexOf("$existing = Read-Pids");
  const startupAssert = launcher.indexOf("Assert-NoUntrackedPackagedServices $existing", startupRead);
  const startupDecision = launcher.indexOf("if ($existing -and (Is-Alive", startupRead);
  assert.ok(startupRead >= 0 && startupAssert > startupRead && startupDecision > startupAssert,
    "The launcher must inspect untracked services before deciding that no services are running.");

  assert.match(updateJournalSmoke, /missing-journal/i);
  assert.match(updateJournalSmoke, /partial-journal/i);
  assert.match(updateJournalSmoke, /reused PID/i);
  assert.match(updateJournalSmoke, /synthetic packaged WMI failure/i);
});

test("installed lifecycle smoke uninstalls while both packaged services are running", () => {
  const start = installedLifecycleSmoke.indexOf('Invoke-InstalledLauncher "start" "uninstall-running-start"');
  const uninstall = installedLifecycleSmoke.indexOf('Invoke-AsLifecycleUser $uninstaller');
  assert.ok(start >= 0 && uninstall > start, "The lifecycle must start Willard before uninstalling.");
  assert.match(installedLifecycleSmoke, /Wait-PortClosed 8080/);
  assert.match(installedLifecycleSmoke, /Wait-PortClosed 5000/);
  assert.match(installedLifecycleSmoke, /services\.json/);
});

test("launcher retains the previous release if service shutdown cannot be verified", () => {
  const startupCatchStart = launcher.indexOf("\n} catch {\n  $startupError = $_");
  assert.ok(startupCatchStart >= 0, "The startup failure handler must preserve the original error.");
  const startupCatch = launcher.slice(startupCatchStart);
  const stop = startupCatch.indexOf("Stop-Services");
  const gate = startupCatch.indexOf("if ($servicesStopped)");
  const restore = startupCatch.indexOf("Restore-UpdateBackup");
  assert.ok(stop >= 0 && gate > stop && restore > gate, "Rollback must be gated after the service-stop attempt.");
  assert.match(startupCatch, /Stop-StartedProcess \$webProc/);
  assert.match(startupCatch, /Stop-StartedProcess \$apiProc/);
  assert.match(startupCatch, /prior release backup was retained/);
  const directStopStart = launcher.indexOf("function Stop-StartedProcess");
  const directStopEnd = launcher.indexOf("\nfunction Save-Services", directStopStart);
  const directStop = launcher.slice(directStopStart, directStopEnd);
  assert.match(directStop, /\.Kill\(\)/);
  assert.match(directStop, /WaitForExit\(10000\)/);
});

test("developer launcher fails closed on corrupt process state and WMI query failures", () => {
  const readerStart = launcherCommon.indexOf("function Read-TrackedPids");
  const readerEnd = launcherCommon.indexOf("\nfunction Get-ProcessIdentity", readerStart);
  const reader = launcherCommon.slice(readerStart, readerEnd);
  assert.match(reader, /ConvertFrom-Json -ErrorAction Stop/);
  assert.match(reader, /developer services state file is unreadable or invalid/);
  assert.match(reader, /rename or delete this file/);
  assert.doesNotMatch(reader, /catch \{ return \$null \}/);

  const identityStart = launcherCommon.indexOf("function Get-ProcessIdentity");
  const identityEnd = launcherCommon.indexOf("\nfunction Test-ProcessIdentity", identityStart);
  const identity = launcherCommon.slice(identityStart, identityEnd);
  assert.match(identity, /could not verify the identity of Willard process/);
  assert.match(identity, /did not return enough identity information/);
  assert.doesNotMatch(identity, /catch \{ return \$null \}/);

  const stopHandleStart = launcherCommon.indexOf("function Stop-LauncherStartedProcessHandle");
  const stopHandleEnd = launcherCommon.indexOf("\nfunction Read-TrackedPids", stopHandleStart);
  const stopHandle = launcherCommon.slice(stopHandleStart, stopHandleEnd);
  assert.match(stopHandle, /\.Kill\(\)/);
  assert.match(stopHandle, /WaitForExit\(10000\)/);

  const startServicesStart = developerLauncher.indexOf("function Start-WillardServices");
  const startServicesEnd = developerLauncher.indexOf("\n$services =", startServicesStart);
  const startServices = developerLauncher.slice(startServicesStart, startServicesEnd);
  assert.match(startServices, /Stop-LauncherStartedProcessHandle \$webProc/);
  assert.match(startServices, /Stop-LauncherStartedProcessHandle \$apiProc/);
});


test("developer launch, setup, repair, and update fail closed on unjournaled service listeners", () => {
  const portStart = launcherCommon.indexOf("function Get-DeveloperListeningPorts");
  const portEnd = launcherCommon.indexOf("\nfunction Get-PortOwnerPid", portStart);
  assert.ok(portStart >= 0 && portEnd > portStart, "Strict developer listener inspection must be shared.");
  const portInspection = launcherCommon.slice(portStart, portEnd);
  assert.match(portInspection, /Get-NetTCPConnection -LocalPort \$port -State Listen -ErrorAction Stop/);
  assert.match(portInspection, /CategoryInfo\.Category -eq \[System\.Management\.Automation\.ErrorCategory\]::ObjectNotFound/);
  assert.match(portInspection, /could not verify whether Willard service port/);
  assert.match(portInspection, /missing or incomplete/);

  const stopStart = launcherCommon.indexOf("function Stop-TrackedProcesses");
  const stopEnd = launcherCommon.indexOf("\nfunction Get-LogTail", stopStart);
  const stop = launcherCommon.slice(stopStart, stopEnd);
  assert.ok(stop.indexOf("Assert-NoUntrackedDeveloperServices $pids") >= 0);
  assert.ok(stop.indexOf("Get-DeveloperListeningPorts") > stop.indexOf("Wait-Process"));
  assert.ok(stop.indexOf("Get-DeveloperListeningPorts") < stop.indexOf("Clear-TrackedPids"));

  const startGuard = developerLauncher.indexOf("Assert-NoUntrackedDeveloperServices $entryTracked");
  const recovery = developerLauncher.indexOf("Recover-InterruptedDeveloperUpdate");
  assert.ok(startGuard >= 0 && startGuard < recovery, "Start must guard listeners before update recovery.");

  const repairGuard = repairLauncher.indexOf("Assert-NoUntrackedDeveloperServices $tracked");
  const repairMutation = repairLauncher.indexOf("Install-WillardMediaTools");
  assert.ok(repairGuard >= 0 && repairGuard < repairMutation, "Repair must guard listeners before repair mutations.");

  const setupGuard = setupLauncher.indexOf("Assert-NoUntrackedDeveloperServices $entryTracked");
  const setupMutation = setupLauncher.indexOf("Install-WillardMediaTools");
  assert.ok(setupGuard >= 0 && setupGuard < setupMutation, "Setup must guard listeners before setup mutations.");
  assert.match(setupLauncher, /if \\(\$entryTracked\\) \\{\\s+Stop-TrackedProcesses \\| Out-Null/);

  const repairTrackedStart = repairLauncher.indexOf("if ($tracked) {", repairGuard);
  const repairTrackedEnd = repairLauncher.indexOf("\n}\n\n# -- Helper programs", repairTrackedStart);
  assert.ok(repairTrackedStart >= 0 && repairTrackedEnd > repairTrackedStart);
  const repairTrackedBlock = repairLauncher.slice(repairTrackedStart, repairTrackedEnd);
  assert.match(repairTrackedBlock, /Stop-TrackedProcesses/);
  assert.doesNotMatch(repairTrackedBlock, /Clear-TrackedPids/);

  const updateGuard = updater.indexOf("Assert-NoUntrackedDeveloperServices $entryTracked");
  const updatePreparation = updater.indexOf("$candidate = New-CandidateDirectory $gitCommand");
  assert.ok(updateGuard >= 0 && updateGuard < updatePreparation, "Update must guard listeners before preparing a candidate.");
});


const auditInstallerLifecycleWorkflow = await readFile(
  new URL("../../.github/workflows/windows-installer-lifecycle-validation.yml", import.meta.url),
  "utf8",
);

test("audit installer lifecycle validation is isolated from release publishing", () => {
  assert.ok(auditInstallerLifecycleWorkflow.includes("pull_request:"));
  assert.match(auditInstallerLifecycleWorkflow, /types:\s*\n\s*- opened\s*\n\s*- reopened\s*\n\s*- synchronize/);

  assert.ok(auditInstallerLifecycleWorkflow.includes("audit/full-repository-review-2026-11"));
  assert.ok(auditInstallerLifecycleWorkflow.includes("workflow_dispatch:"));
  assert.ok(auditInstallerLifecycleWorkflow.includes("contents: read"));
  assert.ok(auditInstallerLifecycleWorkflow.includes("runs-on: windows-latest"));
  assert.ok(auditInstallerLifecycleWorkflow.includes("build-installer.ps1"));
  assert.ok(auditInstallerLifecycleWorkflow.includes("installer-lifecycle-smoke.ps1"));
  assert.ok(auditInstallerLifecycleWorkflow.includes("PGPASSWORD"));
  assert.doesNotMatch(auditInstallerLifecycleWorkflow, /secrets\./);
  assert.doesNotMatch(auditInstallerLifecycleWorkflow, /WILLARD_RELEASE_SIGNING_PRIVATE_KEY|WILLARD_WINDOWS_SIGNING_CERTIFICATE/);
  assert.doesNotMatch(auditInstallerLifecycleWorkflow, /softprops\/action-gh-release|gh release create|upload-artifact/);
  assert.doesNotMatch(auditInstallerLifecycleWorkflow, /contents:\s*write/);
  assert.ok(auditInstallerLifecycleWorkflow.includes('"scripts/windows/installer-lifecycle-smoke.ps1"'));
  assert.ok(auditInstallerLifecycleWorkflow.includes('"desktop/WillardMediaCenter.ps1"'));
  assert.doesNotMatch(auditInstallerLifecycleWorkflow, /^\s+- "scripts\/windows\/\*\*"$/m);
  assert.doesNotMatch(auditInstallerLifecycleWorkflow, /^\s+- "artifacts\/api-server\/\*\*"$/m);
  assert.doesNotMatch(auditInstallerLifecycleWorkflow, /^\s+- "artifacts\/willard-ai\/\*\*"$/m);
});
  
test("installer lifecycle validation only runs for installer and packaging inputs", () => {
  assert.ok(auditInstallerLifecycleWorkflow.includes('"installer/**"'));
  assert.ok(auditInstallerLifecycleWorkflow.includes('"scripts/windows/build-installer.ps1"'));
  assert.ok(auditInstallerLifecycleWorkflow.includes('"artifacts/api-server/package.json"'));
  assert.ok(auditInstallerLifecycleWorkflow.includes('"pnpm-lock.yaml"'));

});
