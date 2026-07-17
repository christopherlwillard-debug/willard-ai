# Willard AI — First-time setup (run once per machine, safe to re-run).
. (Join-Path $PSScriptRoot "common.ps1")

Assert-LocalWindows
Set-Location $Root
Ensure-LogDir

Write-Banner "Willard AI Setup"
Write-Host "  This runs once to get Willard AI ready on your computer." -ForegroundColor Gray
Write-Host "  Grab a coffee — it takes 2-5 minutes." -ForegroundColor Gray
Write-Host ""

# ── Node.js ───────────────────────────────────────────────────────────────────
if (-not (Test-Command "node")) {
    Write-Bad "Node.js is required but not found."
    Write-Host ""
    Write-Host "  Download and install it from:  https://nodejs.org  (choose the LTS version)" -ForegroundColor White
    Write-Host "  Then double-click 'Setup Willard AI.bat' again." -ForegroundColor White
    Pause-BeforeClose; exit 1
}
Write-Ok ("Node.js " + (& node --version) + " found")

# ── pnpm ──────────────────────────────────────────────────────────────────────
if (-not (Test-Command "pnpm")) {
    Write-Info "Installing pnpm package manager..."
    & npm install -g pnpm --silent
    if ($LASTEXITCODE -ne 0) {
        Show-Failure "Couldn't install pnpm automatically." "npm install -g pnpm failed."
        Write-Host "  Try running:  npm install -g pnpm" -ForegroundColor White
        Pause-BeforeClose; exit 1
    }
}
Write-Ok "pnpm ready"

# ── Settings file (.env) ──────────────────────────────────────────────────────
if (Ensure-EnvFile) {
    Write-Ok "Created settings file"
}

# ── PostgreSQL password setup ─────────────────────────────────────────────────
$dbUrl = Get-EnvValue "DATABASE_URL"
$needsPassword = (-not $dbUrl) -or ($dbUrl -match "your.password|change.me|<password>|PASSWORD")
if ($needsPassword) {
    Write-Host ""
    Write-Host "  PostgreSQL setup needed." -ForegroundColor Yellow
    Write-Host "  Enter the password you chose when you installed PostgreSQL:" -ForegroundColor White
    $pgPass = Read-Host "  Password"
    $dbUrl = "postgresql://postgres:$pgPass@localhost:5432/willard"
    $envPath = Join-Path $Root ".env"
    $envContent = Get-Content $envPath -Raw
    $envContent = $envContent -replace '(?m)^DATABASE_URL=.*$', "DATABASE_URL=$dbUrl"
    Set-Content $envPath -Value $envContent -Encoding UTF8
    Write-Ok "Database connection configured"
}

# ── Packages ──────────────────────────────────────────────────────────────────
Write-Info "Installing packages (largest step — a few minutes)..."
$installLog = Join-Path $LogDir "setup-install.log"
& pnpm install *> $installLog
if ($LASTEXITCODE -ne 0) {
    Show-Failure "Package installation failed." ("pnpm install failed — see " + $installLog)
    Pause-BeforeClose; exit 1
}
Write-Ok "Packages installed"

# ── Database ──────────────────────────────────────────────────────────────────
Write-Info "Setting up database..."
$env:DATABASE_URL = Get-EnvValue "DATABASE_URL"
$dbLog = Join-Path $LogDir "setup-db.log"
& node (Join-Path $Root "setup-db.cjs") *> $dbLog
if ($LASTEXITCODE -ne 0) {
    Show-Failure "Database setup failed. Is PostgreSQL running?" ("setup-db.cjs failed — see " + $dbLog)
    Write-Host "  Make sure PostgreSQL is running, then try again." -ForegroundColor White
    Pause-BeforeClose; exit 1
}
Write-Ok "Database ready"

# ── Build API server ──────────────────────────────────────────────────────────
Write-Info "Building API server..."
$buildLog = Join-Path $LogDir "setup-build.log"
& pnpm --filter @workspace/api-server run build *> $buildLog
if ($LASTEXITCODE -ne 0) {
    Show-Failure "API build failed." ("Build failed — see " + $buildLog)
    Pause-BeforeClose; exit 1
}
Write-Ok "API server built"

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ──────────────────────────────────────────────────" -ForegroundColor Green
Write-Host "  Setup complete!  Willard AI is ready to use." -ForegroundColor Green
Write-Host "  ──────────────────────────────────────────────────" -ForegroundColor Green
Write-Host ""
Write-Host "  Next step:  double-click 'Start Willard AI.bat'" -ForegroundColor White
Write-Host ""

$answer = Read-Host "  Start Willard AI now? (Y/n)"
if ($answer -notmatch '^[Nn]') {
    & (Join-Path $PSScriptRoot "start.ps1")
} else {
    Read-Host "  Press Enter to close" | Out-Null
}
