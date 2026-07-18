# Repair Willard AI - self-heals common problems, then gives a plain verdict.
. (Join-Path $PSScriptRoot "common.ps1")

Assert-LocalWindows
Set-Location $Root
Ensure-LogDir

Write-Banner "Checking and repairing your installation..."

$problems = @()

# -- Clear stale state from a crashed previous run ----------------------------
$tracked = Read-TrackedPids
if ($tracked) {
    $apiAlive = Test-ProcessAlive $tracked.api
    $webAlive = Test-ProcessAlive $tracked.web
    if ($apiAlive -or $webAlive) {
        Write-Info "Willard AI is currently running - stopping it so it can be repaired..."
        Stop-TrackedProcesses | Out-Null
        Start-Sleep -Seconds 2
        Write-Ok "Stopped the running copy."
    } else {
        Clear-TrackedPids
        Write-Ok "Cleared leftover state from a previous run."
    }
}

# -- Helper programs ----------------------------------------------------------
if (Test-Command "node") {
    Write-Ok "Node.js is installed."
} else {
    Write-Bad "Node.js is missing."
    $problems += "Install Node.js from https://nodejs.org (LTS), then run Repair again."
}

if (Test-Command "pnpm") {
    Write-Ok "Package tools are installed."
} elseif (Test-Command "npm") {
    Write-Info "Installing a missing helper (pnpm)..."
    & npm install -g pnpm *> (Join-Path $LogDir "repair.log")
    if (Test-Command "pnpm") { Write-Ok "Helper installed." }
    else {
        Write-Bad "A required helper (pnpm) could not be installed."
        $problems += "Open a command window and run: npm install -g pnpm"
    }
} else {
    Write-Bad "Package tools are missing (they come with Node.js)."
    $problems += "Install Node.js first, then run Repair again."
}

if (Test-Command "ffmpeg") {
    Write-Ok "Media processing is available."
} else {
    Write-Warn "Media processing (FFmpeg) is not installed. Willard AI still works, but thumbnails/previews will be off."
    Write-Host "        To add it:  winget install Gyan.FFmpeg" -ForegroundColor Gray
}

# -- Configuration ------------------------------------------------------------
$envPath = Join-Path $Root ".env"
if (Test-Path $envPath) {
    Write-Ok "Settings file is present."
} elseif (Ensure-EnvFile) {
    Write-Ok "Settings file was missing - recreated it."
} else {
    Write-Bad "Settings file is missing and could not be recreated."
    $problems += "The file .env.example is missing from the folder. Re-download Willard AI."
}

# -- Application components ---------------------------------------------------
if ((Test-Command "pnpm") -and (Test-Command "node")) {
    Write-Info "Checking application components (this can take a few minutes)..."
    & pnpm install --ignore-scripts --silent *> (Join-Path $LogDir "repair-install.log")
    if ($LASTEXITCODE -eq 0) {
        Write-Ok "Application components are complete."
    } else {
        Write-Bad "Application components could not be repaired."
        $problems += ("Component repair failed - see " + (Join-Path $LogDir "repair-install.log"))
    }
}

# -- Database connection -------------------------------------------------------
if ((Test-Command "node") -and (Test-Path $envPath)) {
    if (Test-DatabaseConnection) {
        Write-Ok "Media database connection works."
    } else {
        Write-Bad "The media database isn't available."
        $problems += "Make sure PostgreSQL is installed and running, and that DATABASE_URL in .env points to your database. (Install: https://www.postgresql.org/download/windows/)"
    }
}


# -- Verdict ------------------------------------------------------------------
Write-Host ""
if ($problems.Count -eq 0) {
    Write-Host "  Everything looks good - double-click 'Start Willard AI.bat'." -ForegroundColor Green
} else {
    Write-Host "  A few things still need your attention:" -ForegroundColor Yellow
    foreach ($p in $problems) {
        Write-Host ("   - " + $p) -ForegroundColor White
    }
}
Pause-BeforeClose
exit 0
