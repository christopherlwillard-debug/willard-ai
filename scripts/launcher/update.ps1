# Update the Windows developer checkout from GitHub.
# Git is the normal path; the signed release archive remains a fallback for
# machines that do not have Git installed.
. (Join-Path $PSScriptRoot "common.ps1")

Assert-LocalWindows
Set-Location $Root
Ensure-LogDir

Write-Banner "Updating Willard AI..."

$updateLog = Join-Path $LogDir "update.log"

function Update-Fail($stageName, $message) {
    Write-Bad ("Update failed during " + $stageName + ".")
    Write-Host ("  " + $message) -ForegroundColor DarkGray
    Write-Host ("  Your current installation was not replaced. Logs: " + $updateLog) -ForegroundColor Gray
    Pause-BeforeClose
    exit 1
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

function Invoke-ArchiveFallback {
    $manifestUrl = "$GithubRepo/releases/latest/download/release-manifest.json"
    $archive = Join-Path $env:TEMP "willard-source-update.zip"
    $stage = Join-Path $env:TEMP ("willard-source-" + [guid]::NewGuid().ToString())
    $backup = Join-Path $LogDir ("update-backup-" + (Get-Date -Format "yyyyMMddHHmmss"))
    $backupReady = $false

    function Invoke-Robocopy($source, $destination) {
        & robocopy $source $destination /E /PURGE `
            /XD (Join-Path $source "node_modules") (Join-Path $source "logs") (Join-Path $source ".git") `
            /XF ".env" | Out-Null
        if ($LASTEXITCODE -gt 7) { throw "File copy failed with robocopy exit code $LASTEXITCODE." }
    }

    try {
        Write-Info "Reading the latest release manifest..."
        try {
            $manifest = (Invoke-WebRequest -Uri $manifestUrl -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop).Content | ConvertFrom-Json
        } catch {
            $statusCode = 0
            try { $statusCode = [int]$_.Exception.Response.StatusCode } catch {}
            if ($statusCode -eq 404) {
                Write-Warn "No verified GitHub release is published yet. Your current folder was left unchanged."
                Add-Content $updateLog "[update] No release manifest was published at $manifestUrl"
                return
            }
            throw
        }
        if (-not $manifest.sourceArtifactUrl -or -not $manifest.sourceSha256) {
            throw "This release does not contain a developer-source archive."
        }
        Write-Info "Downloading the developer update..."
        Remove-Item $archive -Force -ErrorAction SilentlyContinue
        Invoke-WebRequest -Uri $manifest.sourceArtifactUrl -OutFile $archive -UseBasicParsing -TimeoutSec 180 -ErrorAction Stop
        if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.sourceSha256.ToLowerInvariant()) {
            throw "The downloaded release failed checksum verification."
        }
        Expand-Archive -Path $archive -DestinationPath $stage -Force
        $sourceRoot = if (Test-Path (Join-Path $stage "package.json")) { Get-Item $stage } else { Get-ChildItem $stage -Directory | Select-Object -First 1 }
        if (-not $sourceRoot -or -not (Test-Path (Join-Path $sourceRoot.FullName "package.json"))) {
            throw "The developer-source archive was empty or malformed."
        }
        New-Item -ItemType Directory -Force $backup | Out-Null
        Invoke-Robocopy $Root $backup
        $backupReady = $true
        Invoke-Robocopy $sourceRoot.FullName $Root
        $pnpmCommand = Get-WillardPnpmCommand
        if (-not $pnpmCommand) { throw "pnpm.cmd or pnpm.exe could not be found." }
        $installLog = Join-Path $LogDir "update-install.log"
        & $pnpmCommand install --ignore-scripts *> $installLog
        if ($LASTEXITCODE -ne 0) { throw "Package refresh failed. See $installLog." }
        $buildLog = Join-Path $LogDir "update-build.log"
        & $pnpmCommand --filter @workspace/api-server run build *> $buildLog
        if ($LASTEXITCODE -ne 0) { throw "The API rebuild failed. See $buildLog." }
        Remove-Item $backup -Recurse -Force -ErrorAction SilentlyContinue
        $backupReady = $false
        Write-Ok "Developer update installed."
    } catch {
        if ($backupReady -and (Test-Path $backup)) {
            Write-Warn "Restoring the previous installation..."
            Invoke-Robocopy $backup $Root
            Write-Ok "The previous installation was restored."
        }
        throw
    } finally {
        Remove-Item $archive -Force -ErrorAction SilentlyContinue
        Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}

try {
    Add-Content $updateLog ("[update] Started " + (Get-Date).ToString("o"))
    $gitCommand = Get-WillardGitCommand
    $gitBefore = $null
    $gitPulled = $false

    if ($gitCommand -and (Test-Path (Join-Path $Root ".git"))) {
        Stop-TrackedProcesses | Out-Null
        $remote = Get-GitRemoteUrl $gitCommand
        if ($remote -ne $GithubRepo) {
            & $gitCommand -C $Root remote set-url origin $GithubRepo 2>$null
            if ($LASTEXITCODE -ne 0) { throw "This folder's GitHub update source could not be configured." }
        }

        $before = (& $gitCommand -C $Root rev-parse HEAD 2>$null).Trim()
        $gitBefore = $before
        if ($LASTEXITCODE -ne 0) { throw "This developer folder has an invalid Git checkout. Run setup again to repair it." }
        $dirty = & $gitCommand -C $Root status --porcelain
        if ($dirty) {
            throw "Local code changes are present. Save or revert them before running Update Willard AI."
        }

        $pullLog = Join-Path $LogDir "update-git.log"
        $pullCode = Invoke-LoggedCommand "Checking GitHub for the latest Willard AI..." $pullLog {
            & $gitCommand -C $Root pull --ff-only origin $GithubBranch
        }
        if ($pullCode -ne 0) { throw "GitHub could not update this folder. Check your connection or run setup again." }
        $gitPulled = ($before -ne ((& $gitCommand -C $Root rev-parse HEAD 2>$null).Trim()))
        $after = (& $gitCommand -C $Root rev-parse HEAD 2>$null).Trim()
        $changed = if ($before -ne $after) { @(& $gitCommand -C $Root diff --name-only $before $after) } else { @() }
        if ($changed.Count -eq 0) {
            Write-Ok "Willard AI is already up to date."
        } else {
            $packageChanged = $changed | Where-Object { $_ -match '(^|/)(package\.json|pnpm-lock\.yaml)$' }
            $apiChanged = $changed | Where-Object { $_ -match '(^|/)(artifacts/api-server/|lib/|setup-db\.cjs)' }
            $pnpmCommand = Get-WillardPnpmCommand
            if (-not $pnpmCommand) { throw "pnpm.cmd or pnpm.exe could not be found." }
            if ($packageChanged) {
                $installLog = Join-Path $LogDir "update-install.log"
                $installCode = Invoke-LoggedCommand "Refreshing changed application components..." $installLog {
                    & $pnpmCommand install --ignore-scripts
                }
                if ($installCode -ne 0) { throw "Package refresh failed. See $installLog." }
            }
            if ($apiChanged -or $packageChanged) {
                $buildLog = Join-Path $LogDir "update-build.log"
                $buildCode = Invoke-LoggedCommand "Rebuilding the updated library service..." $buildLog {
                    & $pnpmCommand --filter @workspace/api-server run build
                }
                if ($buildCode -ne 0 -or -not (Test-Path (Join-Path $Root "artifacts\api-server\dist\index.mjs"))) {
                    throw "The API rebuild failed. See $buildLog."
                }
            }
            Write-Ok ("Updated to " + $after.Substring(0, [Math]::Min(8, $after.Length)) + ".")
        }
    } elseif ($gitCommand) {
        # A source ZIP has no .git directory. Connect it and finish the same
        # dependency/API preparation as a normal update instead of stopping
        # after the first run and making the user repeat the operation.
        $connected = Initialize-DeveloperGitCheckout
        if (-not $connected) {
            throw "This folder is not connected to GitHub. Run Setup Willard AI.bat and allow GitHub updates."
        }
        $pnpmCommand = Get-WillardPnpmCommand
        if (-not $pnpmCommand) { throw "pnpm.cmd or pnpm.exe could not be found." }
        $installLog = Join-Path $LogDir "update-install.log"
        $installCode = Invoke-LoggedCommand "Preparing the updated application components..." $installLog {
            & $pnpmCommand install --ignore-scripts
        }
        if ($installCode -ne 0) { throw "Package refresh failed. See $installLog." }
        $buildLog = Join-Path $LogDir "update-build.log"
        $buildCode = Invoke-LoggedCommand "Preparing the updated library service..." $buildLog {
            & $pnpmCommand --filter @workspace/api-server run build
        }
        if ($buildCode -ne 0 -or -not (Test-Path (Join-Path $Root "artifacts\api-server\dist\index.mjs"))) {
            throw "The API rebuild failed. See $buildLog."
        }
        Write-Ok "This folder is connected and updated to the latest GitHub version."
    } else {
        Write-Warn "Git is not installed, so the verified ZIP update path will be used."
        Invoke-ArchiveFallback
    }
} catch {
    if ($gitPulled -and $gitCommand -and $gitBefore) {
        Write-Warn "The update could not be prepared. Restoring the previous code..."
        & $gitCommand -C $Root reset --hard $gitBefore *> (Join-Path $LogDir "update-rollback.log")
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "The previous developer version was restored."
        } else {
            Add-Content $updateLog "[update] Git rollback failed; run git reset --hard $gitBefore from this folder."
        }
    }
    Add-Content $updateLog ("[update] " + $_.Exception.Message)
    Update-Fail "GitHub update" $_.Exception.Message
}

Write-Host "  Start Willard AI.bat to launch the updated local copy." -ForegroundColor White
Pause-BeforeClose
exit 0