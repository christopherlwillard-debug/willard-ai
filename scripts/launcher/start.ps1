# Launch Willard AI from the local developer installation.
. (Join-Path $PSScriptRoot "common.ps1")

Assert-LocalWindows
Set-Location $Root
Ensure-LogDir

Write-Banner "Preparing your media library..."

function Stop-And-Exit($friendly, $technical, $code = 1) {
    try {
        if (Restore-PendingDeveloperUpdate) {
            Write-Warn "The previous runnable version was restored after the update did not start."
        }
    } catch {
        $technical = $technical + " Rollback could not complete: " + $_.Exception.Message
    }
    Write-Bad $friendly
    Write-Host ("  " + $technical) -ForegroundColor DarkGray
    Write-Host ("  Logs: " + $LogDir) -ForegroundColor Gray
    exit $code
}

function Invoke-LoggedCommand($label, $logPath, [scriptblock]$command) {
    Write-Info $label
    $savedPref = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    & $command *> $logPath
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $savedPref
    return $exitCode
}

# -- Existing state -------------------------------------------------------------
Recover-InterruptedDeveloperUpdate
$pendingDeveloperUpdate = Read-DeveloperUpdateJournal
if ($pendingDeveloperUpdate -and $pendingDeveloperUpdate.phase -eq "swapped") {
    Write-Info "Verifying the updated version before removing its rollback copy..."
}
$tracked = Read-TrackedPids
if ($tracked -and (Test-ProcessAlive $tracked.api) -and (Test-ProcessAlive $tracked.web)) {
    Write-Ok "Willard AI is already running."
    Start-Process $AppUrl
    exit 0
}
if ($tracked) {
    Write-Info "Recovering from an interrupted launch..."
    Stop-TrackedProcesses | Out-Null
    Start-Sleep -Seconds 1
}

# -- Required helpers -----------------------------------------------------------
if (-not (Test-Command "node")) {
    Stop-And-Exit "Willard AI needs Node.js before it can open." `
        "Node.js was not found on PATH. Install the LTS version from https://nodejs.org."
}

try {
    $nodeVersion = (& node --version).TrimStart("v")
    $parsedNodeVersion = [version]$nodeVersion
    if (($parsedNodeVersion.Major -lt 20) -or
        ($parsedNodeVersion.Major -eq 20 -and $parsedNodeVersion.Minor -lt 6)) {
        Stop-And-Exit "Willard AI needs a newer Node.js version." `
            ("Found Node.js " + $nodeVersion + ". Install Node.js 24 LTS, then launch again.")
    }
} catch {
    Stop-And-Exit "Willard AI couldn't verify Node.js." `
        "The installed Node.js version could not be read. Install Node.js 24 LTS, then launch again."
}

$nodeCommand = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeCommand) {
    Stop-And-Exit "Willard AI couldn't locate Node.js." "Node.js was found but its executable path could not be resolved."
}

$script:WillardRunToken = [guid]::NewGuid().ToString()

if (-not (Test-Command "pnpm")) {
    if (Test-Command "npm") {
        Write-Info "Installing a small package helper..."
        & npm install -g pnpm *> (Join-Path $LogDir "repair.log")
    }
    if (-not (Test-Command "pnpm")) {
        Stop-And-Exit "Willard AI couldn't install its package helper." `
            "pnpm was not found and automatic installation failed. Run: npm install -g pnpm"
    }
    Write-Ok "Package helper ready"
}
$pnpmCommand = Get-WillardPnpmCommand
if (-not $pnpmCommand) {
    Stop-And-Exit "Willard AI couldn't locate its package helper." `
        "pnpm was found, but its Windows executable wrapper (pnpm.cmd or pnpm.exe) could not be resolved."
}
# Keep the supported Windows wrapper names visible in this entry point too:
# "pnpm.cmd", "pnpm.exe". The shared resolver prefers them in that order.

# -- Configuration --------------------------------------------------------------
if (Ensure-EnvFile) { Write-Ok "Created your settings file automatically." }
if (-not (Test-Path (Join-Path $Root ".env"))) {
    Stop-And-Exit "Willard AI couldn't find its settings file." `
        "Neither .env nor .env.example is available in the application folder."
}

$installLog = Join-Path $LogDir "setup.log"
$dependencyMarkerPath = Join-Path $LogDir "dependencies-ready.json"
$dependencySources = @(
    (Join-Path $Root "package.json"),
    (Join-Path $Root "pnpm-lock.yaml")
) + @(Get-ChildItem (Join-Path $Root "artifacts") -Filter "package.json" -File -Recurse -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty FullName)
$dependencyFingerprint = (($dependencySources | ForEach-Object {
    if (Test-Path $_) { (Get-FileHash $_ -Algorithm SHA256).Hash }
}) -join ":")
$dependenciesReady = $false
if ($dependencyFingerprint -and (Test-Path $dependencyMarkerPath) -and (Test-Path (Join-Path $Root "node_modules"))) {
    try {
        $dependencyMarker = Get-Content $dependencyMarkerPath -Raw | ConvertFrom-Json
        $dependenciesReady = ($dependencyMarker.version -eq 1 -and
            $dependencyMarker.fingerprint -eq $dependencyFingerprint)
    } catch { $dependenciesReady = $false }
}
if ($dependenciesReady) {
    Write-Ok "Application components already ready"
} else {
    $installCode = Invoke-LoggedCommand "Checking application components..." $installLog {
        & $pnpmCommand install --ignore-scripts --silent
    }
    if ($installCode -ne 0) {
        Write-Warn "The first package check needs another try..."
        $installCode = Invoke-LoggedCommand "Repairing application components..." $installLog {
            & $pnpmCommand install --force --ignore-scripts --silent
        }
    }
    if ($installCode -ne 0) {
        Stop-And-Exit "Willard AI couldn't finish setting itself up." `
            ("Package repair failed. Details are in " + $installLog)
    }
    @{
        version = 1
        fingerprint = $dependencyFingerprint
        completedAt = (Get-Date).ToString("o")
    } | ConvertTo-Json | Set-Content $dependencyMarkerPath
    Write-Ok "Application components ready"
}

# -- Build when first-run or after a local dependency change -------------------
$apiDist = Join-Path $Root "artifacts\api-server\dist\index.mjs"
if (-not (Test-WillardApiBuild $Root)) {
    $buildLog = Join-Path $LogDir "startup-build.log"
    $buildCode = Invoke-LoggedCommand "Preparing the library service..." $buildLog {
        & $pnpmCommand --filter @workspace/api-server run build
    }
    if ($buildCode -ne 0 -or -not (Test-WillardApiBuild $Root)) {
        Stop-And-Exit "Willard AI couldn't prepare its library service." `
            ("The service build is incomplete. Details are in " + $buildLog)
    }
}
Write-Ok "Library service ready"

# -- Database bootstrap and additive migrations --------------------------------
Write-Info "Checking your media database..."
$env:DATABASE_URL = Get-EnvValue "DATABASE_URL"
if (-not (Wait-ForDatabase 30)) {
    Write-Info "Waiting for PostgreSQL to accept connections..."
    Ensure-AppDatabase | Out-Null
}
if (-not (Wait-ForDatabase 10)) {
    Stop-And-Exit "Willard AI couldn't reach the media database." `
        ("PostgreSQL is unavailable or DATABASE_URL is incorrect. Details are in " + $ApiLog)
}
$dbMigrateLog = Join-Path $LogDir "db-migrate.log"
$schemaSources = @(
    (Join-Path $Root "setup-db.cjs"),
    (Join-Path $Root "artifacts\api-server\src\app.ts")
)
$schemaFingerprint = (($schemaSources | ForEach-Object {
    if (Test-Path $_) { (Get-FileHash $_ -Algorithm SHA256).Hash }
}) -join ":")
$schemaMarkerPath = Join-Path $LogDir "schema-ready.json"
$schemaReady = $false
if ($schemaFingerprint -and (Test-Path $schemaMarkerPath)) {
    try {
        $schemaMarker = Get-Content $schemaMarkerPath -Raw | ConvertFrom-Json
        $schemaReady = ($schemaMarker.version -eq 1 -and $schemaMarker.fingerprint -eq $schemaFingerprint)
    } catch { $schemaReady = $false }
}
if ($schemaReady) {
    Write-Ok "Database schema already ready"
} else {
    $migrationCode = Invoke-LoggedCommand "Applying safe database updates..." $dbMigrateLog {
        & node (Join-Path $Root "setup-db.cjs")
    }
    if ($migrationCode -ne 0) {
        Stop-And-Exit "Willard AI couldn't finish a safe database update." `
            ("No services were started. Details are in " + $dbMigrateLog)
    }
    @{
        version = 1
        fingerprint = $schemaFingerprint
        completedAt = (Get-Date).ToString("o")
    } | ConvertTo-Json | Set-Content $schemaMarkerPath
}
Write-Ok "Database ready"
$env:WILLARD_SCHEMA_READY = "1"
try {
    Initialize-WillardBackupProtection $true -OfferCredentialReset | Out-Null
} catch {
    Stop-And-Exit "Library backup protection is not ready." $_.Exception.Message
}

# -- Ports ----------------------------------------------------------------------
foreach ($port in 8080, 5000) {
    if (-not (Test-PortFree $port)) {
        $ownerPid = Get-PortOwnerPid $port
        $ownerName = ""
        try { $ownerName = (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue).ProcessName } catch { }
        Stop-And-Exit "Another program is using a Willard AI connection." `
            ("Port " + $port + " is in use by process " + $ownerPid + " (" + $ownerName + "). Close that program, then launch again.")
    }
}

# -- Start both services --------------------------------------------------------
function Start-WillardServices {
    Write-Info "Opening the library service and Media Center..."
    $env:PORT = "8080"
    $envFile = Join-Path $Root ".env"
    $apiProc = $null
    try {
        $apiProc = Start-Process -FilePath $nodeCommand `
            -ArgumentList @("--enable-source-maps", "--env-file=`"$envFile`"", "`"$apiDist`"") `
            -WorkingDirectory (Join-Path $Root "artifacts\api-server") `
            -RedirectStandardOutput $ApiLog -RedirectStandardError (Join-Path $LogDir "api-error.log") `
            -WindowStyle Minimized -PassThru
        # Persist ownership immediately so a web startup failure can clean up
        # the API process as well.
        Save-TrackedPids $apiProc.Id $null
        $env:PORT = "5000"
        if (-not $pnpmCommand) {
            throw "The package helper was found but no Windows executable wrapper (pnpm.cmd or pnpm.exe) was available."
        }
        $webProc = Start-Process -FilePath $pnpmCommand `
            -ArgumentList @("--filter", "@workspace/willard-ai", "run", "dev") `
            -WorkingDirectory $Root -RedirectStandardOutput $WebLog `
            -RedirectStandardError (Join-Path $LogDir "web-error.log") `
            -WindowStyle Minimized -PassThru
        Save-TrackedPids $apiProc.Id $webProc.Id
        if (-not (Test-ProcessAlive $webProc.Id)) {
            throw "The Media Center process exited immediately after launch. See " +
                $WebLog + ". Recent output: " + (Get-LogTail $WebLog)
        }
        return @{ api = $apiProc; web = $webProc }
    } catch {
        Stop-TrackedProcesses | Out-Null
        throw
    }
}

$services = Start-WillardServices

function Fail-And-CleanUp($friendly, $technical) {
    Stop-TrackedProcesses | Out-Null
    try {
        if (Restore-PendingDeveloperUpdate) {
            Write-Warn "The previous runnable version was restored after the update did not become healthy."
        }
    } catch {
        $technical = $technical + " Rollback could not complete: " + $_.Exception.Message
    }
    Write-Bad $friendly
    Write-Host ("  " + $technical) -ForegroundColor DarkGray
    Write-Host ("  Logs: " + $LogDir) -ForegroundColor Gray
    exit 1
}

# -- Readiness ------------------------------------------------------------------
$apiReadyTimeout = 180
if (-not (Wait-ForUrl $ApiUrl "your library service" $apiReadyTimeout $services.api.Id $ApiLog)) {
    $apiErrorTail = Get-LogTail (Join-Path $LogDir "api-error.log")
    Fail-And-CleanUp "Willard AI couldn't start its library service." `
        (($script:LastWaitFailureReason) + " Error output: " + $apiErrorTail)
}
Write-Ok "Media library ready"

if (-not (Wait-ForUrl $WebUrl "Media Center" 60 $services.web.Id $WebLog)) {
    Fail-And-CleanUp "Willard AI couldn't open the Media Center." `
        (($script:LastWaitFailureReason) + " See " + $WebLog + " and " + (Join-Path $LogDir "web-error.log"))
}
Write-Ok "Media Center ready"

try {
    Confirm-DeveloperUpdateHealth
} catch {
    Write-Warn ("The updated version is healthy, but its rollback copy was retained: " + $_.Exception.Message)
}

if (-not (Test-Command "ffmpeg")) {
    Write-Warn "Media previews are limited until FFmpeg is installed."
}

Write-Host ""
Write-Host "  Opening Willard Media Center..." -ForegroundColor Cyan
if ($env:WILLARD_SKIP_BROWSER -ne "1") {
    Start-Process $AppUrl
}
Write-Host ""
Write-Host "  Willard Media Center is ready." -ForegroundColor Green
Write-Host ("  Logs: " + $LogDir) -ForegroundColor Gray
Write-Host "  The app will keep running in its minimized service windows." -ForegroundColor Gray
Write-Host ""
exit 0