# Start Willard AI - friendly media-center style launcher.
. (Join-Path $PSScriptRoot "common.ps1")

Assert-LocalWindows
Set-Location $Root
Ensure-LogDir

Write-Banner "Preparing your media library..."

# -- Already running? ---------------------------------------------------------
$tracked = Read-TrackedPids
if ($tracked -and (Test-ProcessAlive $tracked.api) -and (Test-ProcessAlive $tracked.web)) {
    Write-Ok "Willard AI is already running."
    $answer = Read-Host "  Open it in your browser (O), restart it (R), or do nothing (Enter)?"
    if ($answer -match '^[Oo]') { Start-Process $AppUrl; exit 0 }
    if ($answer -match '^[Rr]') {
        Write-Info "Restarting Willard AI..."
        Stop-TrackedProcesses | Out-Null
        Start-Sleep -Seconds 2
    } else { exit 0 }
} elseif ($tracked) {
    # Stale state from a crashed previous run - clear it silently.
    Stop-TrackedProcesses | Out-Null
}

# -- Required helper programs -------------------------------------------------
if (-not (Test-Command "node")) {
    Show-Failure "Willard AI needs one more program before it can start: Node.js." `
        "Node.js was not found on PATH."
    Write-Host "  Please install it from:  https://nodejs.org  (choose the LTS version)" -ForegroundColor White
    Write-Host "  Then double-click 'Start Willard AI.bat' again." -ForegroundColor White
    Pause-BeforeClose; exit 1
}
if (-not (Test-Command "pnpm")) {
    Show-Failure "Willard AI needs one more small helper before it can start." `
        "pnpm was not found on PATH."
    Write-Host "  Open a command window and run:   npm install -g pnpm" -ForegroundColor White
    Write-Host "  Then double-click 'Start Willard AI.bat' again." -ForegroundColor White
    Pause-BeforeClose; exit 1
}

# -- Optional media component (warn only) -------------------------------------
$ffmpegOk = Test-Command "ffmpeg"

# -- Configuration ------------------------------------------------------------
if (Ensure-EnvFile) {
    Write-Ok "Created your settings file automatically."
}

# -- Packages (only if missing) -----------------------------------------------
$nodeModules = Join-Path $Root "node_modules"
$needInstall = -not (Test-Path $nodeModules)
if (-not $needInstall) {
    $probe = Join-Path $Root "node_modules\.pnpm"
    if (-not (Test-Path $probe)) { $needInstall = $true }
}
if ($needInstall) {
    Write-Info "Installing packages (first launch takes a few minutes)..."
    $installLog = Join-Path $LogDir "setup.log"
    & pnpm install --ignore-scripts --silent *> $installLog
    if ($LASTEXITCODE -ne 0) {
        Show-Failure "Willard AI couldn't finish setting itself up." `
            ("pnpm install failed - see " + $installLog)
        Pause-BeforeClose; exit 1
    }
}
Write-Ok "Packages ready"

# -- First-run check ----------------------------------------------------------
$apiDist = Join-Path $Root "artifacts\api-server\dist\index.mjs"
if (-not (Test-Path $apiDist)) {
    Show-Failure "Willard AI hasn't been set up yet on this computer." `
        ("API dist not found at: " + $apiDist)
    Write-Host ""
    Write-Host "  Please double-click 'Setup Willard AI.bat' first." -ForegroundColor White
    Pause-BeforeClose; exit 1
}

# -- Database -----------------------------------------------------------------
Write-Info "Checking database..."
if (-not (Test-DatabaseConnection)) {
    Show-Failure "Willard AI couldn't start. The media database isn't available." `
        ("Could not connect to PostgreSQL. Is it running? Check DATABASE_URL in .env. See " + $ApiLog)
    Write-Host "  If this is a fresh install, run 'Setup Willard AI.bat' first." -ForegroundColor White
    Pause-BeforeClose; exit 1
}
Write-Ok "Database Ready"

# -- Ports --------------------------------------------------------------------
foreach ($port in 8080, 5000) {
    if (-not (Test-PortFree $port)) {
        $ownerPid = Get-PortOwnerPid $port
        $ownerName = ""
        try { $ownerName = (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue).ProcessName } catch { }
        Show-Failure "Another program is blocking Willard AI from starting." `
            ("Port " + $port + " is in use by process " + $ownerPid + " (" + $ownerName + "). Close that program or restart, then try again.")
        Pause-BeforeClose; exit 1
    }
}

# -- Optional update check (only if this copy is a Git clone) -----------------
if ((Test-Path (Join-Path $Root ".git")) -and (Test-Command "git")) {
    $answer = Read-Host "  Check for updates before starting? (y/N)"
    if ($answer -match '^[Yy]') {
        Write-Info "Checking for updates..."
        & git -C $Root pull --ff-only *> (Join-Path $LogDir "update.log")
        if ($LASTEXITCODE -eq 0) { Write-Ok "Up to date." } else { Write-Warn "Couldn't check for updates right now (that's fine)." }
    }
}

# -- Start both parts of the app ----------------------------------------------
Write-Info "Starting Willard AI..."

$apiProc = Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c", "title Willard AI - Library Service && node --enable-source-maps --env-file-if-exists=.env artifacts\api-server\dist\index.mjs >> `"$ApiLog`" 2>&1" `
    -WorkingDirectory $Root -WindowStyle Minimized -PassThru
$webProc = Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c", "title Willard AI - App && pnpm --filter @workspace/willard-ai run dev >> `"$WebLog`" 2>&1" `
    -WorkingDirectory $Root -WindowStyle Minimized -PassThru

Save-TrackedPids $apiProc.Id $webProc.Id

function Fail-And-CleanUp($friendly, $technical) {
    Stop-TrackedProcesses | Out-Null
    Show-Failure $friendly $technical
    Pause-BeforeClose
    exit 1
}

# -- Wait for readiness (no fixed sleeps; up to 60s each) ---------------------
if (-not (Wait-ForUrl $ApiUrl "your library" 60)) {
    Fail-And-CleanUp "Willard AI couldn't start. The library service never became ready." `
        ("The API did not respond on port 8080 within 60 seconds. See " + $ApiLog)
}
Write-Ok "Media Library Ready"

if (-not (Wait-ForUrl $WebUrl "the app" 60)) {
    Fail-And-CleanUp "Willard AI couldn't start. The app never became ready." `
        ("The web app did not respond on port 5000 within 60 seconds. See " + $WebLog)
}
Write-Ok "App Ready"

if (-not $ffmpegOk) {
    Write-Warn "Thumbnails are off until FFmpeg is installed (winget install Gyan.FFmpeg)."
}

# -- Open browser -------------------------------------------------------------
Write-Host ""
Write-Host "  Opening Willard AI..." -ForegroundColor Cyan
Start-Process $AppUrl

Write-Host ""
Write-Host "  Willard AI is running." -ForegroundColor Green
Write-Host ("    App:   " + $AppUrl) -ForegroundColor White
Write-Host ("    Logs:  " + $LogDir) -ForegroundColor Gray
Write-Host "    Stop:  close the two minimized 'Willard AI' windows," -ForegroundColor Gray
Write-Host "           or double-click 'Stop Willard AI.bat'." -ForegroundColor Gray
Write-Host ""
Read-Host "  You can close this window now (Willard AI keeps running). Press Enter" | Out-Null
exit 0
