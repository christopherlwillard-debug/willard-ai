# Launch Willard AI - one automatic path for first launch, restart, update,
# dependency repair, and recoverable startup failures.
. (Join-Path $PSScriptRoot "common.ps1")

Assert-LocalWindows
Set-Location $Root
Ensure-LogDir

Write-Banner "Preparing your media library..."

function Stop-And-Exit($friendly, $technical, $code = 1) {
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

# -- Configuration --------------------------------------------------------------
if (Ensure-EnvFile) { Write-Ok "Created your settings file automatically." }
if (-not (Test-Path (Join-Path $Root ".env"))) {
    Stop-And-Exit "Willard AI couldn't find its settings file." `
        "Neither .env nor .env.example is available in the application folder."
}

# -- Safe update and dependency repair -----------------------------------------
$apiSourceChanged = $false
$launcherChanged = $false
$updateLog = Join-Path $LogDir "update.log"
if ((Test-Path (Join-Path $Root ".git")) -and (Test-Command "git")) {
    Write-Info "Checking for safe updates..."
    $savedPref = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    $prevHead = (& git -C $Root rev-parse HEAD 2>$null)
    & git -C $Root pull --ff-only origin $GithubBranch *>> $updateLog
    $pullOk = ($LASTEXITCODE -eq 0)
    $newHead = (& git -C $Root rev-parse HEAD 2>$null)
    if ($pullOk -and $prevHead -and $newHead -and ($prevHead -ne $newHead)) {
        $changedFiles = (& git -C $Root diff --name-only $prevHead $newHead 2>$null)
        $apiSourceChanged = [bool]($changedFiles -match "artifacts[/\\]api-server[/\\]src")
        $launcherChanged = [bool]($changedFiles -match "scripts[/\\]launcher[/\\]")
        Write-Ok "Safe updates applied"
    } elseif ($pullOk) {
        Write-Ok "Already up to date"
    } else {
        Write-Warn "Update check was unavailable; continuing with this copy"
        Add-Content $updateLog "[launcher] git pull failed; current files were left unchanged."
    }
    $ErrorActionPreference = $savedPref
}
if ($launcherChanged) {
    Write-Info "Restarting with the updated launcher..."
    $powershellCommand = (Get-Command powershell.exe -ErrorAction SilentlyContinue).Source
    if (-not $powershellCommand) { $powershellCommand = Join-Path $PSHOME "powershell.exe" }
    Start-Process -FilePath $powershellCommand `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $PSCommandPath) `
        -WorkingDirectory $Root -WindowStyle Normal
    exit 0
}

$installLog = Join-Path $LogDir "setup.log"
$installCode = Invoke-LoggedCommand "Checking application components..." $installLog {
    & pnpm install --ignore-scripts --silent
}
if ($installCode -ne 0) {
    Write-Warn "The first package check needs another try..."
    $installCode = Invoke-LoggedCommand "Repairing application components..." $installLog {
        & pnpm install --force --ignore-scripts --silent
    }
}
if ($installCode -ne 0) {
    Stop-And-Exit "Willard AI couldn't finish setting itself up." `
        ("Package repair failed. Details are in " + $installLog)
}
Write-Ok "Application components ready"

# -- Build when first-run or after an API update -------------------------------
$apiDist = Join-Path $Root "artifacts\api-server\dist\index.mjs"
if ($apiSourceChanged -or -not (Test-Path $apiDist)) {
    $buildLog = Join-Path $LogDir "startup-build.log"
    $buildCode = Invoke-LoggedCommand "Preparing the library service..." $buildLog {
        & pnpm --filter @workspace/api-server run build
    }
    if ($buildCode -ne 0 -or -not (Test-Path $apiDist)) {
        Stop-And-Exit "Willard AI couldn't prepare its library service." `
            ("The service build failed. Details are in " + $buildLog)
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
$migrationCode = Invoke-LoggedCommand "Applying safe database updates..." $dbMigrateLog {
    & node (Join-Path $Root "setup-db.cjs")
}
if ($migrationCode -ne 0) {
    Stop-And-Exit "Willard AI couldn't finish a safe database update." `
        ("No services were started. Details are in " + $dbMigrateLog)
}
Write-Ok "Database ready"

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
    $apiProc = Start-Process -FilePath $nodeCommand `
        -ArgumentList @("--enable-source-maps", "--env-file=$envFile", $apiDist) `
        -WorkingDirectory (Join-Path $Root "artifacts\api-server") `
        -RedirectStandardOutput $ApiLog -RedirectStandardError (Join-Path $LogDir "api-error.log") `
        -WindowStyle Minimized -PassThru
    $env:PORT = "5000"
    $pnpmCommand = $null
    foreach ($candidate in @("pnpm.cmd", "pnpm.exe")) {
        $resolved = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($resolved) {
            $pnpmCommand = $resolved.Source
            break
        }
    }
    if (-not $pnpmCommand) {
        Stop-And-Exit "Willard AI couldn't locate pnpm." `
            "The package helper was found but no Windows executable wrapper (pnpm.cmd or pnpm.exe) was available."
    }
    $webProc = Start-Process -FilePath $pnpmCommand `
        -ArgumentList @("--filter", "@workspace/willard-ai", "run", "dev") `
        -WorkingDirectory $Root -RedirectStandardOutput $WebLog `
        -RedirectStandardError (Join-Path $LogDir "web-error.log") `
        -WindowStyle Minimized -PassThru
    Save-TrackedPids $apiProc.Id $webProc.Id
    return @{ api = $apiProc; web = $webProc }
}

$services = Start-WillardServices

function Fail-And-CleanUp($friendly, $technical) {
    Stop-TrackedProcesses | Out-Null
    Write-Bad $friendly
    Write-Host ("  " + $technical) -ForegroundColor DarkGray
    Write-Host ("  Logs: " + $LogDir) -ForegroundColor Gray
    exit 1
}

# -- Readiness ------------------------------------------------------------------
if (-not (Wait-ForUrl $ApiUrl "your library service" 60 $services.api.Id $ApiLog)) {
    Fail-And-CleanUp "Willard AI couldn't start its library service." `
        (($script:LastWaitFailureReason) + " See " + $ApiLog + " and " + (Join-Path $LogDir "api-error.log"))
}
Write-Ok "Media library ready"

if (-not (Wait-ForUrl $WebUrl "Media Center" 60 $services.web.Id $WebLog)) {
    Fail-And-CleanUp "Willard AI couldn't open the Media Center." `
        (($script:LastWaitFailureReason) + " See " + $WebLog + " and " + (Join-Path $LogDir "web-error.log"))
}
Write-Ok "Media Center ready"

if (-not (Test-Command "ffmpeg")) {
    Write-Warn "Media previews are limited until FFmpeg is installed."
}

Write-Host ""
Write-Host "  Opening Willard Media Center..." -ForegroundColor Cyan
Start-Process $AppUrl
Write-Host ""
Write-Host "  Willard Media Center is ready." -ForegroundColor Green
Write-Host ("  Logs: " + $LogDir) -ForegroundColor Gray
Write-Host "  The app will keep running in its minimized service windows." -ForegroundColor Gray
Write-Host ""
exit 0