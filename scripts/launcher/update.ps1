# Update Willard AI - pulls the latest fixes from GitHub.
# Uses git pull when git is available; falls back to direct file download.
. (Join-Path $PSScriptRoot "common.ps1")

Assert-LocalWindows
Set-Location $Root
Ensure-LogDir

Write-Banner "Checking for updates..."

if ($GithubRepo -match 'OWNER') {
    Write-Host ""
    Write-Bad "Update channel is not configured yet."
    Write-Host ""
    Write-Host "  To enable one-click updates:" -ForegroundColor White
    Write-Host "    1. Create a public GitHub repository for Willard AI." -ForegroundColor Gray
    Write-Host "    2. Open scripts\launcher\common.ps1 in Notepad." -ForegroundColor Gray
    Write-Host "    3. Replace OWNER with your GitHub username on the GithubRepo line." -ForegroundColor Gray
    Write-Host "    4. Run this again." -ForegroundColor Gray
    Pause-BeforeClose; exit 1
}

$updateLog = Join-Path $LogDir "update.log"
$hasGit    = Test-Command "git"
$hasGitDir = Test-Path (Join-Path $Root ".git")
$updatedViaGit = $false

# Strategy A: git pull (fastest - only downloads what changed)
if ($hasGit -and $hasGitDir) {
    Write-Info "Downloading updates..."
    $savedPref = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    $prevHead = (& git -C $Root rev-parse HEAD 2>$null)
    & git -C $Root pull --ff-only origin $GithubBranch *>> $updateLog
    $pullOk = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = $savedPref
    if ($pullOk) {
        $newHead = (& git -C $Root rev-parse HEAD 2>$null)
        if ($prevHead -eq $newHead) {
            Write-Ok "Already up to date - no changes."
            Pause-BeforeClose; exit 0
        }
        Write-Ok "Downloaded latest updates."
        $updatedViaGit = $true
        # Check if API server source changed so we know whether to rebuild
        $savedPref = $ErrorActionPreference
        $ErrorActionPreference = "SilentlyContinue"
        $changedFiles = (& git -C $Root diff --name-only $prevHead $newHead 2>$null)
        $ErrorActionPreference = $savedPref
        $script:ApiSourceChanged = ($changedFiles -match "artifacts[/\\]api-server[/\\]src")
    } else {
        Write-Warn "git pull failed - check your internet connection or see " + $updateLog
        Write-Info "Trying direct download instead..."
    }
}

# Strategy B: set up git for the first time, then pull
if ($hasGit -and -not $hasGitDir -and -not $updatedViaGit) {
    Write-Info "Connecting to update channel (one-time setup)..."
    $savedPref = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    & git -C $Root init *>> $updateLog
    & git -C $Root remote add origin $GithubRepo *>> $updateLog
    & git -C $Root fetch origin $GithubBranch *>> $updateLog
    & git -C $Root reset --hard "origin/$GithubBranch" *>> $updateLog
    $gitOk = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = $savedPref
    if ($gitOk) {
        Write-Ok "Connected and updated. Future updates will use git pull."
        $updatedViaGit = $true
        $script:ApiSourceChanged = $true
    } else {
        Write-Warn "Could not connect via git - trying direct download instead..."
    }
}

# Strategy C: no git, or git failed - download key files directly
if (-not $updatedViaGit) {
    $filesToUpdate = @(
        "package.json",
        "pnpm-lock.yaml",
        "setup-db.cjs",
        "scripts/launcher/common.ps1",
        "scripts/launcher/setup.ps1",
        "scripts/launcher/start.ps1",
        "scripts/launcher/stop.ps1",
        "scripts/launcher/repair.ps1",
        "scripts/launcher/update.ps1",
        "Setup Willard AI.bat",
        "Start Willard AI.bat",
        "Stop Willard AI.bat",
        "Repair Willard AI.bat",
        "Update Willard AI.bat"
    )
    Write-Info ("Downloading " + $filesToUpdate.Count + " files from GitHub...")
    $failed = @()
    foreach ($file in $filesToUpdate) {
        $encodedFile = $file -replace ' ', '%20'
        $url  = "$GithubRawBase/$encodedFile"
        $dest = Join-Path $Root ($file -replace '/', '\')
        $destDir = Split-Path $dest
        if ($destDir -and -not (Test-Path $destDir)) {
            New-Item -ItemType Directory -Path $destDir -Force | Out-Null
        }
        try {
            $savedPref = $ErrorActionPreference
            $ErrorActionPreference = "SilentlyContinue"
            Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -ErrorAction Stop
            $ErrorActionPreference = $savedPref
        } catch {
            $ErrorActionPreference = $savedPref
            $failed += $file
            Add-Content $updateLog ("[update] Failed to download: $file - $_")
        }
    }
    if ($failed.Count -gt 0) {
        Write-Warn ("Could not download " + $failed.Count + " file(s): " + ($failed -join ", "))
        Write-Info ("Check your internet connection and try again. Details: " + $updateLog)
        Pause-BeforeClose; exit 1
    }
    Write-Ok ("Downloaded " + $filesToUpdate.Count + " launcher and config files.")
    # Direct download cannot fetch API source trees - only scripts and config
    # are updated. API source requires git. Rebuild is skipped accordingly.
    $script:ApiSourceChanged = $false
    Write-Info "Note: API source updates require git. Install git and re-run for full updates."
}

# Refresh packages
Write-Info "Refreshing packages..."
$installLog = Join-Path $LogDir "update-install.log"
$savedPref = $ErrorActionPreference
$ErrorActionPreference = "SilentlyContinue"
& pnpm install --ignore-scripts *> $installLog
$installOk = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = $savedPref
if ($installOk) {
    Write-Ok "Packages up to date."
} else {
    Write-Warn "Package refresh had a problem. The update may still work - see " + $installLog
}

# Rebuild API server only when source files changed
if ($script:ApiSourceChanged -ne $false) {
    Write-Info "Rebuilding API server..."
    $buildLog = Join-Path $LogDir "update-build.log"
    $savedPref = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    & pnpm --filter @workspace/api-server run build *> $buildLog
    $buildOk = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = $savedPref
    if ($buildOk) {
        Write-Ok "API server rebuilt."
    } else {
        Show-Failure "API server build failed after update." ("Build failed - see " + $buildLog)
        Pause-BeforeClose; exit 1
    }
}

Write-Host ""
Write-Host "  Update complete." -ForegroundColor Green
Write-Host "  Double-click 'Start Willard AI.bat' to launch with the latest version." -ForegroundColor White
Write-Host ""
Pause-BeforeClose
exit 0
