import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
const workflow = await readFile(
  new URL("../../.github/workflows/windows-release.yml", import.meta.url),
  "utf8",
);
const backendAudit = await readFile(
  new URL("../../artifacts/api-server/audit.mjs", import.meta.url),
  "utf8",
);
const backupCoordinator = await readFile(
  new URL("../../artifacts/api-server/src/lib/backup-coordinator.ts", import.meta.url),
  "utf8",
);
const rootPackage = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
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
  assert.match(launcher, /ProtectedData\]::Protect/);
  assert.match(launcher, /WILLARD_BACKUP_RECOVERY_EXPORT_READY/);
  assert.match(launcher, /portable recovery export/i);
  assert.match(launcher, /credentialFingerprint/);
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
  assert.ok(launcher.includes('--env-file=`"$EnvFile`"'));
  assert.ok(launcher.includes('"`"$Api`""'));
  assert.ok(launcher.includes('--root=`"$Web`"'));
  assert.match(launcher, /untrusted host/);
  assert.match(launcher, /release-assets\.githubusercontent\.com/);
  assert.match(launcher, /Start-LoadingScreen/);
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

test("installer deliberately leaves external services outside its payload", () => {
  const installSources = config
    .split(/\r?\n/)
    .filter((line) => /^\s*Source:/i.test(line));
  assert.doesNotMatch(installSources.join("\n"), /postgres|PostgreSQL|ffmpeg/i);
});

test("source Setup and Repair automatically restore thumbnail media tools", () => {
  assert.match(launcherCommon, /function Install-WillardMediaTools/);
  assert.match(launcherCommon, /winget install --id Gyan\.FFmpeg --exact --silent/);
  assert.match(launcherCommon, /choco install ffmpeg -y --no-progress/);
  assert.match(launcherCommon, /GetEnvironmentVariable\("Path", "Machine"\)/);
  assert.match(launcherCommon, /GetEnvironmentVariable\("Path", "User"\)/);
  assert.match(setupLauncher, /if \(Install-WillardMediaTools\)/);
  assert.match(setupLauncher, /Setup stopped before scans could create repeated thumbnail failures/);
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
  assert.match(backupCoordinator, /\["\/PID", String\(child\.pid\), "\/T", "\/F"\]/);
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
  assert.match(workflow, /runs-on: windows-latest/);
  assert.match(
    workflow,
    /group:\s*windows-release-\$\{\{\s*github\.ref\s*\}\}/,
  );
  assert.match(workflow, /cancel-in-progress:\s*true/);
  assert.match(workflow, /make-release\.ps1/);
  assert.match(workflow, /WILLARD_NODE_RUNTIME/);
  assert.match(installerCompiler, /MyAppVersion=\$Version/);
  assert.match(workflow, /release-manifest\.json/);
  assert.match(workflow, /WillardMediaCenter-.*-Setup\.exe/);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/);
  assert.match(workflow, /softprops\/action-gh-release@[0-9a-f]{40}/);
  assert.match(workflow, /WILLARD_RELEASE_SIGNING_PRIVATE_KEY/);
  assert.match(workflow, /Reject an existing release tag/);
  assert.match(workflow, /git ls-remote --exit-code --tags origin/);
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

test("packaged startup closes its owned loader and preserves actionable diagnostics on failure", () => {
  assert.match(launcher, /function Start-LoadingScreen/);
  assert.match(launcher, /Start-Process -FilePath \$LoadingScreen -PassThru/);
  assert.match(launcher, /function Close-LoadingScreen/);
  assert.match(launcher, /CloseMainWindow\(\)/);
  assert.match(launcher, /startup-failure\.log/);
  assert.match(launcher, /System\.Windows\.MessageBox/);
  assert.match(launcher, /Recover-InterruptedUpdateSwap/);
  assert.match(
    launcher,
    /\$env:PORT = "8080"\s*\n\s*Start-LoadingScreen\s*\n\s*\$apiProc/,
  );
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
  assert.match(loaderPage, /const elapsed = document\.getElementById\("elapsed"\)/);
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
  assert.match(installerCompiler, /--messages-jsonl/);
  assert.ok(
    installerCompiler.includes('"(?:type|kind|severity)"\\s*:\\s*"warning"'),
  );
  assert.match(installerCompiler, /Inno Setup emitted warnings/);
  assert.match(localBuildInstaller, /compile-installer\.ps1/);
  assert.match(workflow, /compile-installer\.ps1/);
});

test("Windows release gate proves the installed lifecycle with external data", () => {
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
  assert.match(updater, /Copy-PreservedDeveloperState \$candidate -IncludeLogs/);
  assert.match(updater, /tracked source edits/);
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
  assert.match(startupSmoke, /\$env:LOCALAPPDATA = Join-Path \$env:RUNNER_TEMP "willard-startup-localappdata"/);
  assert.match(startupSmoke, /\$env:WILLARD_SKIP_BROWSER = "1"/);
  assert.match(startupSmoke, /\$env:WILLARD_CI_BACKUP_PASSPHRASE = /);
  assert.match(launcherCommon, /\$env:CI -eq "true" -and \$env:WILLARD_CI_BACKUP_PASSPHRASE/);
  assert.match(developerLauncher, /\$env:WILLARD_SKIP_BROWSER -ne "1"/);
  assert.match(startupSmoke, /\$env:WILLARD_RECOVERY_EXPORT_PATH = Join-Path \$env:RUNNER_TEMP/);
  assert.match(startupSmoke, /\$env:WILLARD_RECOVERY_EXPORT_PASSPHRASE = /);
  assert.match(startupSmoke, /\$launcherArguments = @\([^)]*\) \+ @\(\$arguments\)/);
  assert.match(startupSmoke, /\$powershell = \(Get-Process -Id \$PID\)\.Path/);
  assert.match(startupSmoke, /-ArgumentList \$launcherArguments/);
  assert.match(startupSmoke, /\$process\.WaitForExit\(240000\)/);
  assert.doesNotMatch(startupSmoke, /-PassThru -Wait/);
  assert.match(startupSmoke, /Launcher process did not exit within 240 seconds[\s\S]*Read-Text \$outputPath[\s\S]*Read-Text \(\$outputPath \+ "\.err"\)/);
  assert.match(startupSmoke, /Invoke-Launcher @\("-File", \$Start\) \$SmokeOutput/);
  assert.doesNotMatch(startupSmoke, /Invoke-Launcher @\("-File", \$Batch\)/);
  assert.match(startupSmoke, /echo deliberate web startup failure\r?\nexit \/b 1/);
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

test("installer coordinates upgrades and repair reports failures", async () => {
  const repair = await readFile(
    new URL("../launcher/repair.ps1", import.meta.url),
    "utf8",
  );
  assert.match(config, /PrepareToInstall/);
  assert.match(config, /WillardMediaCenter\.ps1[\s\S]*-Stop/);
  assert.match(repair, /\$problems\.Count -gt 0\) \{ exit 1 \}/);
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
  assert.match(updater, /New-Item -ItemType Directory -Force \(Join-Path \$candidate "logs"\)/);
  assert.match(updater, /Copy-PreservedDeveloperState \$candidate -IncludeLogs/);
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

test("Windows update smoke test exercises Git, preservation, and rollback on a real runner", () => {
  assert.match(updateSmoke, /git clone/);
  assert.match(updateSmoke, /function Wait-ForUpdateSwap/);
  assert.match(updateSmoke, /Wait-ForUpdateSwap \$Install/);
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
