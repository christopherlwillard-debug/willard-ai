# Update Willard AI from a published, checksum-verified Windows release.
# This command is intentionally separate from the normal startup path.
. (Join-Path $PSScriptRoot "common.ps1")

Assert-LocalWindows
Set-Location $Root
Ensure-LogDir

Write-Banner "Updating Willard AI..."

$updateLog = Join-Path $LogDir "update.log"
$manifestUrl = "$GithubRepo/releases/latest/download/release-manifest.json"
$archive = Join-Path $env:TEMP "willard-source-update.zip"
$stage = Join-Path $env:TEMP ("willard-source-" + [guid]::NewGuid().ToString())
$backup = Join-Path $LogDir ("update-backup-" + (Get-Date -Format "yyyyMMddHHmmss"))
$backupReady = $false

function Update-Fail($stageName, $message) {
    Write-Bad ("Update failed during " + $stageName + ".")
    Write-Host ("  " + $message) -ForegroundColor DarkGray
    Write-Host ("  Logs: " + $updateLog) -ForegroundColor Gray
    Pause-BeforeClose
    exit 1
}

function Invoke-Robocopy($source, $destination) {
    & robocopy $source $destination /E /PURGE `
        /XD (Join-Path $source "node_modules") (Join-Path $source "logs") (Join-Path $source ".git") `
        /XF ".env" | Out-Null
    if ($LASTEXITCODE -gt 7) {
        throw "File copy failed with robocopy exit code $LASTEXITCODE."
    }
}

try {
    Add-Content $updateLog ("[update] Started " + (Get-Date).ToString("o"))

    Write-Info "Reading the latest release manifest..."
    $manifestResponse = Invoke-WebRequest -Uri $manifestUrl -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
    $manifest = $manifestResponse.Content | ConvertFrom-Json
    if (-not $manifest.version -or $manifest.version -notmatch '^\d+\.\d+\.\d+(?:-[\w.-]+)?$') {
        throw "The release manifest contains an invalid version."
    }
    if (-not $manifest.sourceArtifactUrl -or $manifest.sourceArtifactUrl -notmatch '^https://') {
        throw "This release does not contain a secure developer-source download address."
    }
    if (-not $manifest.sourceSha256 -or $manifest.sourceSha256 -notmatch '^[a-fA-F0-9]{64}$') {
        throw "The release manifest does not contain a valid developer-source checksum."
    }

    Write-Info ("Downloading Willard AI " + $manifest.version + "...")
    Remove-Item $archive -Force -ErrorAction SilentlyContinue
    Invoke-WebRequest -Uri $manifest.sourceArtifactUrl -OutFile $archive -UseBasicParsing -TimeoutSec 180 -ErrorAction Stop
    $actualHash = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $manifest.sourceSha256.ToLowerInvariant()) {
        throw "The downloaded release failed checksum verification."
    }
    Write-Ok "Release download verified"

    Write-Info "Staging and validating the release..."
    Expand-Archive -Path $archive -DestinationPath $stage -Force
    $sourceRoot = if (Test-Path (Join-Path $stage "package.json")) {
        Get-Item $stage
    } else {
        Get-ChildItem $stage -Directory | Select-Object -First 1
    }
    if (-not $sourceRoot -or -not (Test-Path (Join-Path $sourceRoot.FullName "package.json"))) {
        throw "The developer-source archive was empty or malformed."
    }
    $required = @(
        "package.json",
        "pnpm-lock.yaml",
        "setup-db.cjs",
        "artifacts\api-server\package.json",
        "artifacts\willard-ai\package.json",
        "scripts\launcher\start.ps1",
        "scripts\launcher\setup.ps1"
    )
    foreach ($entry in $required) {
        if (-not (Test-Path (Join-Path $sourceRoot.FullName $entry))) {
            throw "The developer-source archive is incomplete: $entry"
        }
    }
    Write-Ok "Release contents validated"

    Write-Info "Backing up the current installation..."
    New-Item -ItemType Directory -Force $backup | Out-Null
    Invoke-Robocopy $Root $backup
    $backupReady = $true

    Write-Info "Installing the verified release..."
    Invoke-Robocopy $sourceRoot.FullName $Root

    Write-Info "Refreshing local packages..."
    $installLog = Join-Path $LogDir "update-install.log"
    $pnpmCommand = Get-WillardPnpmCommand
    if (-not $pnpmCommand) { throw "pnpm.cmd or pnpm.exe could not be found." }
    & $pnpmCommand install --ignore-scripts *> $installLog
    if ($LASTEXITCODE -ne 0) {
        throw "Package refresh failed. See $installLog."
    }

    Write-Info "Rebuilding the library service..."
    $buildLog = Join-Path $LogDir "update-build.log"
    & $pnpmCommand --filter @workspace/api-server run build *> $buildLog
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $Root "artifacts\api-server\dist\index.mjs"))) {
        throw "The API rebuild failed. See $buildLog."
    }

    Remove-Item $backup -Recurse -Force -ErrorAction SilentlyContinue
    $backupReady = $false
    Write-Ok ("Willard AI " + $manifest.version + " is ready.")
    Write-Host "  Start Willard AI.bat to launch the updated local copy." -ForegroundColor White
} catch {
    $message = $_.Exception.Message
    Add-Content $updateLog ("[update] " + $message)
    if ($backupReady -and (Test-Path $backup)) {
        try {
            Write-Warn "Restoring the previous installation..."
            Invoke-Robocopy $backup $Root
            Write-Ok "The previous installation was restored."
        } catch {
            Add-Content $updateLog ("[update] Restore failed: " + $_.Exception.Message)
            $message = $message + " Restore also failed; see the update log."
        }
    }
    Update-Fail "release installation" $message
} finally {
    Remove-Item $archive -Force -ErrorAction SilentlyContinue
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}

Pause-BeforeClose
exit 0