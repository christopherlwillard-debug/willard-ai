# Update the Windows developer checkout from GitHub without ever preparing an
# update inside the live runnable directory. Git is preferred; the signed release archive remains a fallback.
# A complete candidate is validated
# first, then the two version directories are renamed under an external journal.
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

function Test-FileLockMessage($message) {
    return ([string]$message -match "(?i)being used by another process|sharing violation|EBUSY|EPERM|resource busy|file.+locked|cannot access.+file|process cannot access|access is denied")
}

function Test-FileLockFailure($logPath) {
    if (-not (Test-Path $logPath)) { return $false }
    try {
        $content = Get-Content $logPath -Raw -ErrorAction Stop
        return (Test-FileLockMessage $content)
    } catch {
        return $false
    }
}

function Invoke-WithFileLockRetry([string]$label, [scriptblock]$command) {
    $savedPref = $ErrorActionPreference
    $ErrorActionPreference = "Stop"
    try {
        try {
            & $command
            return
        } catch {
            if (-not (Test-FileLockMessage $_.Exception.Message)) { throw }
            Write-Warn "Windows reported a file lock while $label. Stopping Willard-owned services and retrying..."
            Stop-TrackedProcesses | Out-Null
            Start-Sleep -Seconds 2
            & $command
        }
    } finally {
        $ErrorActionPreference = $savedPref
    }
}

function Start-ExternalDeveloperVersionSwap($candidate, $backup) {
    $parent = Split-Path -Parent $Root
    $leaf = Split-Path -Leaf $Root
    $journal = Join-Path $parent ("." + $leaf + ".willard-update.json")
    $result = Join-Path $parent ("." + $leaf + ".willard-update-result.json")
    $helper = Join-Path $env:TEMP ("willard-update-swap-" + [guid]::NewGuid().ToString() + ".ps1")
    $helperSource = @'
param(
    [string]$Root,
    [string]$Candidate,
    [string]$Backup,
    [string]$Journal,
    [string]$Result,
    [string]$UpdateLabel,
    [int]$UpdaterPid
)
$ErrorActionPreference = "Stop"
$parent = Split-Path -Parent $Root
function Write-Journal($phase) {
    @{
        version = 1
        phase = $phase
        live = $Root
        candidate = $Candidate
        backup = $Backup
        updatedAt = (Get-Date).ToString("o")
    } | ConvertTo-Json | Set-Content $Journal -Encoding UTF8
}
function Write-Result($status, $message) {
    @{
        status = $status
        message = $message
        completedAt = (Get-Date).ToString("o")
    } | ConvertTo-Json | Set-Content $Result -Encoding UTF8
}
Set-Location $parent
try {
    for ($attempt = 0; $attempt -lt 1200; $attempt++) {
        if (-not (Get-Process -Id $UpdaterPid -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 250
    }
    if (Get-Process -Id $UpdaterPid -ErrorAction SilentlyContinue) {
        throw "The updater window did not close in time for the safe folder swap."
    }
    if (-not (Test-Path $Candidate)) { throw "The prepared update version is missing." }
    if (Test-Path $Backup) { throw "A previous update backup is still present: $Backup" }
    Write-Journal "prepared"
    Move-Item -LiteralPath $Root -Destination $Backup -ErrorAction Stop
    Write-Journal "backup-created"
    Move-Item -LiteralPath $Candidate -Destination $Root -ErrorAction Stop
    Write-Journal "swapped"
    Write-Result "ok" $UpdateLabel
} catch {
    try {
        if (-not (Test-Path $Root) -and (Test-Path $Backup)) {
            Move-Item -LiteralPath $Backup -Destination $Root -ErrorAction Stop
        }
    } catch {
        $message = $_.Exception.Message
    }
    Write-Result "failed" $_.Exception.Message
} finally {
    Remove-Item $PSCommandPath -Force -ErrorAction SilentlyContinue
}
'@
    $helperSource | Set-Content $helper -Encoding UTF8
    $quote = { param($value) '"' + ([string]$value).Replace('"', '\"') + '"' }
    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", (& $quote $helper),
        "-Root", (& $quote $Root),
        "-Candidate", (& $quote $candidate),
        "-Backup", (& $quote $backup),
        "-Journal", (& $quote $journal),
        "-Result", (& $quote $result),
        "-UpdateLabel", (& $quote "Update completed"),
        "-UpdaterPid", $PID
    )
    Set-Location $env:TEMP
    Start-Process -FilePath "powershell.exe" -ArgumentList ($arguments -join " ") -WorkingDirectory $parent -WindowStyle Hidden | Out-Null
}

function Invoke-PreparationCommand($label, $logPath, [scriptblock]$command) {
    $exitCode = Invoke-LoggedCommand $label $logPath $command
    if ($exitCode -eq 0 -and -not (Test-FileLockFailure $logPath)) { return $exitCode }
    if (-not (Test-FileLockFailure $logPath)) { return $exitCode }

    Write-Warn "Windows reported a file lock while preparing the update. Stopping Willard-owned services and retrying..."
    Stop-TrackedProcesses | Out-Null
    # taskkill returns before every descendant has released its file handles.
    Start-Sleep -Seconds 2
    return (Invoke-LoggedCommand ($label + " (retry)") $logPath $command)
}

function Test-InjectedUpdateFailure($point) {
    if ($env:WILLARD_UPDATE_FAIL_AT -eq $point) {
        throw ("Injected update failure at " + $point + ".")
    }
}

function Invoke-Robocopy($source, $destination, [switch]$Merge, [string[]]$Exclude) {
    New-Item -ItemType Directory -Force $destination | Out-Null
    $arguments = @($source, $destination)
    $arguments += if ($Merge) { "/E" } else { "/MIR" }
    $arguments += @("/COPY:DAT", "/DCOPY:DAT", "/XJ", "/R:2", "/W:1")
    if ($Exclude -and $Exclude.Count -gt 0) {
        $arguments += @("/XF") + $Exclude
    }
    & robocopy @arguments | Out-Null
    if ($LASTEXITCODE -gt 7) { throw "File copy failed with robocopy exit code $LASTEXITCODE." }
}

function New-CandidateDirectory($gitCommand) {
    $parent = Split-Path -Parent $Root
    $leaf = Split-Path -Leaf $Root
    $candidate = Join-Path $parent ("." + $leaf + ".candidate-" + [guid]::NewGuid().ToString())
    Write-Info "Preparing a clean update workspace..."
    # Never clone from the live runnable folder. Windows services, log writers,
    # or virus scanning can hold handles there while an update is prepared.
    & $gitCommand clone --quiet --no-hardlinks --branch $GithubBranch --single-branch $GithubRepo $candidate 2>> $updateLog
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $candidate ".git"))) {
        throw "Git could not prepare a clean update workspace. See $updateLog."
    }
    & $gitCommand -C $candidate remote set-url origin $GithubRepo 2>> $updateLog
    if ($LASTEXITCODE -ne 0) {
        throw "This folder's GitHub update source could not be configured."
    }
    New-Item -ItemType Directory -Force (Join-Path $candidate "logs") | Out-Null
    return $candidate
}

function Copy-PreservedDeveloperState($destination, [switch]$IncludeLogs) {
    # Archive fallbacks do not contain the local settings, library data, or
    # diagnostics. Carry them forward deliberately; the full old version stays
    # intact as the rollback directory until the next healthy start.
    $entries = @(".env", "library-data", "media-path.txt")
    if ($IncludeLogs) { $entries = @(".env", "logs", "library-data", "media-path.txt") }
    foreach ($entry in $entries) {
        $source = Join-Path $Root $entry
        if (-not (Test-Path $source)) { continue }
        $target = Join-Path $destination $entry
        if ((Get-Item $source).PSIsContainer) {
            if ($entry -eq "logs") {
                # This updater writes update.log itself. Preserve the remaining
                # diagnostics without depending on copying an active log handle.
                Invoke-Robocopy $source $target -Merge -Exclude @("update.log")
            } else {
                Invoke-Robocopy $source $target
            }
        } else {
            New-Item -ItemType Directory -Force (Split-Path -Parent $target) | Out-Null
            Copy-Item $source $target -Force
        }
    }
}

function Prepare-DeveloperCandidate($candidate) {
    $pnpmCommand = Get-WillardPnpmCommand
    if (-not $pnpmCommand) { throw "pnpm.cmd or pnpm.exe could not be found." }

    $candidateLogDir = Join-Path $candidate "logs"
    New-Item -ItemType Directory -Force $candidateLogDir | Out-Null
    $installLog = Join-Path $candidateLogDir "update-install.log"
    $buildLog = Join-Path $candidateLogDir "update-build.log"

    Push-Location $candidate
    try {
        $installCode = Invoke-PreparationCommand "Preparing the complete updated application..." $installLog {
            & $pnpmCommand install --ignore-scripts
        }
        if ($installCode -ne 0) { throw "Package refresh failed. See $installLog." }
        Test-InjectedUpdateFailure "install"

        $buildCode = Invoke-PreparationCommand "Building the updated library service..." $buildLog {
            & $pnpmCommand --filter @workspace/api-server run build
        }
        if ($buildCode -ne 0 -or -not (Test-Path (Join-Path $candidate "artifacts\api-server\dist\index.mjs"))) {
            throw "The API rebuild failed. See $buildLog."
        }
        Test-InjectedUpdateFailure "build"
    } finally {
        Pop-Location
    }

    foreach ($required in @("package.json", "node_modules", "artifacts\api-server\dist\index.mjs")) {
        if (-not (Test-Path (Join-Path $candidate $required))) {
            throw "The prepared update is missing a runnable component: $required"
        }
    }
}

function Complete-DeveloperUpdate($candidate, $label) {
    $backup = $Root + ".previous-" + (Get-Date -Format "yyyyMMddHHmmss")
    Stop-TrackedProcesses | Out-Null
    Start-Sleep -Milliseconds 750
    # Mutable state is copied only after the app processes have released their
    # Windows file handles. The prepared source and dependencies remain isolated.
    Invoke-WithFileLockRetry "preserving local settings and diagnostics" {
        Copy-PreservedDeveloperState $candidate -IncludeLogs
    }
    Test-InjectedUpdateFailure "candidate-copy"
    Start-ExternalDeveloperVersionSwap $candidate $backup
    Write-Ok ($label + " Windows is finishing the safe folder swap. Start Willard AI after this window closes.")
}

function Invoke-ArchiveFallback {
    $manifestUrl = "$GithubRepo/releases/latest/download/release-manifest.json"
    $archive = Join-Path $env:TEMP "willard-source-update.zip"
    $stage = Join-Path $env:TEMP ("willard-source-" + [guid]::NewGuid().ToString())
    $candidate = $null

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

        $candidate = Join-Path (Split-Path -Parent $Root) ("." + (Split-Path -Leaf $Root) + ".candidate-" + [guid]::NewGuid().ToString())
        Invoke-Robocopy $sourceRoot.FullName $candidate
        Prepare-DeveloperCandidate $candidate
        Complete-DeveloperUpdate $candidate "Developer archive update installed."
        $candidate = $null
    } finally {
        Remove-Item $archive -Force -ErrorAction SilentlyContinue
        Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
        if ($candidate) { Remove-Item $candidate -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

try {
    Add-Content $updateLog ("[update] Started " + (Get-Date).ToString("o"))
    $gitCommand = Get-WillardGitCommand

    if ($gitCommand -and (Test-Path (Join-Path $Root ".git"))) {
        $before = (& $gitCommand -C $Root rev-parse HEAD 2>$null).Trim()
        if ($LASTEXITCODE -ne 0) { throw "This developer folder has an invalid Git checkout. Run setup again to repair it." }
        $dirty = @(& $gitCommand -C $Root status --porcelain)
        if ($dirty.Count -gt 0) {
            $dirtyPaths = @(
                $dirty | ForEach-Object {
                    $line = ([string]$_)
                    if ($line.Length -gt 3) { $line.Substring(3).Trim() } else { $line.Trim() }
                } | Select-Object -First 8
            )
            $suffix = if ($dirtyPaths.Count -gt 0) { " Detected: " + ($dirtyPaths -join ", ") + "." } else { "" }
            throw ("Local code changes are present. Save or revert them before running Update Willard AI." + $suffix)
        }

        $candidate = New-CandidateDirectory $gitCommand
        try {
            $pullLog = Join-Path $candidate "logs\update-git.log"
            $pullCode = Invoke-LoggedCommand "Checking GitHub for the latest Willard AI..." $pullLog {
                & $gitCommand -C $candidate pull --ff-only origin $GithubBranch
            }
            if ($pullCode -ne 0) { throw "GitHub could not prepare the update. Check your connection or run setup again." }

            $after = (& $gitCommand -C $candidate rev-parse HEAD 2>$null).Trim()
            if ($before -eq $after) {
                Remove-Item $candidate -Recurse -Force -ErrorAction SilentlyContinue
                $candidate = $null
                Write-Ok "Willard AI is already up to date."
            } else {
                Prepare-DeveloperCandidate $candidate
                Complete-DeveloperUpdate $candidate ("Updated to " + $after.Substring(0, [Math]::Min(8, $after.Length)) + ".")
                $candidate = $null
            }
        } finally {
            if ($candidate) { Remove-Item $candidate -Recurse -Force -ErrorAction SilentlyContinue }
        }
    } else {
        Write-Warn "A Git checkout is not available, so the verified ZIP update path will be used."
        Invoke-ArchiveFallback
    }
} catch {
    Add-Content $updateLog ("[update] " + $_.Exception.Message)
    Update-Fail "update preparation" $_.Exception.Message
}

Write-Host "  Start Willard AI.bat to launch the updated local copy." -ForegroundColor White
Pause-BeforeClose
exit 0