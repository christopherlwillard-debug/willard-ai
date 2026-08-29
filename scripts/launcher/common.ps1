# Willard AI launcher - shared helpers.
# Friendly, non-technical output in the happy path; technical detail goes to
# log files and is shown only on request.

$ErrorActionPreference = "Continue"

# GitHub mirror - this is the only place the URL lives.
# update.ps1 and setup.ps1 both read these constants.
$script:GithubRepo    = if ($env:WILLARD_UPDATE_REPO) { $env:WILLARD_UPDATE_REPO } else { "https://github.com/christopherlwillard-debug/willard-ai" }
$script:GithubBranch  = if ($env:WILLARD_UPDATE_BRANCH) { $env:WILLARD_UPDATE_BRANCH } else { "main" }
$script:GithubRawBase = if ($env:WILLARD_UPDATE_RAW_BASE) { $env:WILLARD_UPDATE_RAW_BASE } else { "https://raw.githubusercontent.com/christopherlwillard-debug/willard-ai/main" }

# Project root = two levels up from this script
$script:Root    = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script:LogDir  = Join-Path $Root "logs"
$script:PidFile = Join-Path $LogDir "willard.pids.json"
$script:ApiLog  = Join-Path $LogDir "api.log"
$script:WebLog  = Join-Path $LogDir "web.log"
$script:ApiUrl  = "http://127.0.0.1:8080/api/healthz"
$script:WebUrl  = "http://127.0.0.1:5000"
$script:AppUrl  = "http://localhost:5000"
$script:MaxLauncherLogBytes = 10MB
$script:MaxLauncherLogGenerations = 5
$script:BackupProtectionRoot = Join-Path $env:LOCALAPPDATA "Willard Media Center\backup-protection"
$script:BackupCredentialFile = Join-Path $BackupProtectionRoot "automation-credential.dpapi"
$script:BackupRecoveryMarker = Join-Path $BackupProtectionRoot "recovery-export-ready.json"

function Assert-LocalWindows {
    # Replit / cloud / non-Windows safety: these scripts are for a personal
    # Windows machine only. Exit silently everywhere else.
    if ($env:REPL_ID) { exit 0 }
    if (-not ($env:OS -eq "Windows_NT" -or $IsWindows)) { exit 0 }
}

function Write-Banner($subtitle) {
    Write-Host ""
    Write-Host "  Willard AI" -ForegroundColor Cyan
    Write-Host "  $subtitle" -ForegroundColor Gray
    Write-Host ""
}

function Write-Ok($msg)   { Write-Host ("  [OK] " + $msg) -ForegroundColor Green }
function Write-Info($msg) { Write-Host ("  ...  " + $msg) -ForegroundColor Gray }
function Write-Warn($msg) { Write-Host ("  [!]  " + $msg) -ForegroundColor Yellow }
function Write-Bad($msg)  { Write-Host ("  [X]  " + $msg) -ForegroundColor Red }

function Pause-BeforeClose {
    if ($env:WILLARD_NO_PAUSE -eq "1") { return }
    Write-Host ""
    Read-Host "  Press Enter to close this window" | Out-Null
}

function ConvertFrom-WillardSecureString($secureValue) {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function Protect-WillardBackupCredential($plainText) {
    $plainBytes = [Text.Encoding]::UTF8.GetBytes($plainText)
    $protectedBytes = [Security.Cryptography.ProtectedData]::Protect(
        $plainBytes,
        $null,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    return "dpapi-v2:" + [Convert]::ToBase64String($protectedBytes)
}

function Read-WillardBackupCredential {
    $stored = (Get-Content $BackupCredentialFile -Raw -ErrorAction Stop).Trim()
    if ($stored.StartsWith("dpapi-v2:")) {
        $protectedBytes = [Convert]::FromBase64String($stored.Substring(8))
        $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
            $protectedBytes,
            $null,
            [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        return [Text.Encoding]::UTF8.GetString($plainBytes)
    }

    # Read the original PowerShell SecureString format for existing installs.
    return ConvertFrom-WillardSecureString (ConvertTo-SecureString $stored)
}

function New-WillardBackupCredential {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $generated = [Convert]::ToBase64String($bytes)
    $protected = Protect-WillardBackupCredential $generated
    $protected | Set-Content $BackupCredentialFile -Encoding ASCII
}

function Initialize-WillardBackupProtection([bool]$RequireRecoveryExport = $false, [switch]$OfferCredentialReset) {
    New-Item -ItemType Directory -Force -Path $BackupProtectionRoot | Out-Null
    if (-not (Test-Path $BackupCredentialFile)) {
        New-WillardBackupCredential
    }

    try {
        $env:WILLARD_BACKUP_PASSPHRASE = Read-WillardBackupCredential
    } catch {
        if (-not $OfferCredentialReset) {
            throw "Windows could not unlock the locally protected backup credential for this account."
        }

        Write-Host ""
        Write-Warn "An older Windows backup credential belongs to a different account or Windows profile."
        Write-Host "  The old credential will be preserved, and a new one can be created for this account." -ForegroundColor White
        Write-Host "  Existing encrypted backups may require the old credential or a portable recovery export." -ForegroundColor Yellow
        $answer = Read-Host "  Create a new backup credential for this account? (y/N)"
        if ($answer -notmatch '^[Yy]') {
            throw "Windows could not unlock the locally protected backup credential for this account."
        }

        $preservedCredential = $BackupCredentialFile + ".unreadable-" + [guid]::NewGuid().ToString()
        Move-Item -LiteralPath $BackupCredentialFile -Destination $preservedCredential -Force -ErrorAction Stop
        New-WillardBackupCredential
        try {
            $env:WILLARD_BACKUP_PASSPHRASE = Read-WillardBackupCredential
        } catch {
            throw "Windows could not create a locally protected backup credential for this account."
        }
    }
    $env:WILLARD_BACKUP_SCRIPT = Join-Path $Root "desktop\database-backup.mjs"

    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $hashBytes = $hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($env:WILLARD_BACKUP_PASSPHRASE))
        $credentialFingerprint = ([BitConverter]::ToString($hashBytes)).Replace("-", "").ToLowerInvariant()
    } finally {
        $hasher.Dispose()
    }
    if (Test-Path $BackupRecoveryMarker) {
        try {
            $marker = Get-Content $BackupRecoveryMarker -Raw | ConvertFrom-Json
            if ($marker.version -eq 1 -and $marker.credentialFingerprint -eq $credentialFingerprint) {
                $env:WILLARD_BACKUP_RECOVERY_EXPORT_READY = "1"
                return $true
            }
        } catch { }
    }
    if (-not $RequireRecoveryExport) { return $false }

    Write-Host ""
    Write-Host "  Protect your library recovery key." -ForegroundColor Yellow
    Write-Host "  Save the portable recovery export on a USB drive or another location" -ForegroundColor White
    Write-Host "  that is NOT inside the library's WillardAI\backups folder." -ForegroundColor White
    $defaultFolder = [Environment]::GetFolderPath("MyDocuments")
    $defaultExport = Join-Path $defaultFolder "Willard-Library-Recovery.willard-recovery.json"
    $exportPath = if ($env:WILLARD_RECOVERY_EXPORT_PATH) {
        $env:WILLARD_RECOVERY_EXPORT_PATH
    } else {
        Read-Host ("  Recovery export path [" + $defaultExport + "]")
    }
    if (-not $exportPath) { $exportPath = $defaultExport }
    if ($exportPath -match "(?i)[\\/]WillardAI[\\/]backups(?:[\\/]|$)") {
        throw "The portable recovery export must not be stored beside the NAS backups."
    }
    $exportPassphrase = $env:WILLARD_RECOVERY_EXPORT_PASSPHRASE
    if (-not $exportPassphrase) {
        $exportPassphrase = ConvertFrom-WillardSecureString (Read-Host "  Recovery export passphrase (12+ characters)" -AsSecureString)
    }
    if (-not $exportPassphrase -or $exportPassphrase.Length -lt 12) {
        throw "The recovery export passphrase must contain at least 12 characters."
    }
    $env:WILLARD_RECOVERY_EXPORT_PASSPHRASE = $exportPassphrase
    try {
        & node $env:WILLARD_BACKUP_SCRIPT export-recovery --output $exportPath
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $exportPath)) {
            throw "The portable recovery export could not be created."
        }
        @{
            version = 1
            createdAt = (Get-Date).ToString("o")
            credentialFingerprint = $credentialFingerprint
        } | ConvertTo-Json | Set-Content $BackupRecoveryMarker -Encoding UTF8
        $env:WILLARD_BACKUP_RECOVERY_EXPORT_READY = "1"
        Write-Ok "Portable recovery export created"
        Write-Warn "Keep the export and its passphrase away from the NAS. Both are needed after laptop loss."
        return $true
    } finally {
        Remove-Item Env:\WILLARD_RECOVERY_EXPORT_PASSPHRASE -ErrorAction SilentlyContinue
        $exportPassphrase = $null
    }
}

function Show-Failure($friendly, $technical) {
    Write-Host ""
    Write-Bad $friendly
    if ($technical) {
        $answer = Read-Host "  Show technical details? (y/N)"
        if ($answer -match '^[Yy]') {
            Write-Host ""
            Write-Host ("  " + $technical) -ForegroundColor DarkGray
        }
    }
    Write-Host ""
    Write-Host "  If this keeps happening, double-click 'Repair Willard AI.bat'." -ForegroundColor Gray
    Write-Host ("  Log files: " + $LogDir) -ForegroundColor Gray
}

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Refresh-WillardPath {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $segments = @($machinePath, $userPath) | Where-Object { $_ }
    if ($segments.Count -gt 0) {
        $env:Path = $segments -join ";"
    }
}

function Test-WillardMediaTools {
    return (Test-Command "ffmpeg") -and (Test-Command "ffprobe")
}

function Install-WillardMediaTools {
    if (Test-WillardMediaTools) { return $true }

    Ensure-LogDir
    $installLog = Join-Path $LogDir "media-tools-install.log"
    Write-Info "Installing media support for thumbnails and previews..."

    if (Test-Command "winget") {
        & winget install --id Gyan.FFmpeg --exact --silent `
            --accept-package-agreements --accept-source-agreements *> $installLog
    } elseif (Test-Command "choco") {
        & choco install ffmpeg -y --no-progress *> $installLog
    } else {
        "Neither winget nor Chocolatey is available." | Set-Content $installLog -Encoding ASCII
        return $false
    }

    Refresh-WillardPath
    return (Test-WillardMediaTools)
}

function Get-WillardGitCommand {
    foreach ($candidate in @("git.exe", "git")) {
        $resolved = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($resolved) { return $resolved.Source }
    }
    return $null
}

function Get-GitRemoteUrl($gitCommand = (Get-WillardGitCommand)) {
    if (-not $gitCommand -or -not (Test-Path (Join-Path $Root ".git"))) { return $null }
    $remote = & $gitCommand -C $Root remote get-url origin 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return ([string]$remote).Trim()
}

function Get-UnsafeDeveloperWorktreeEntries($gitCommand) {
    $entries = @(& $gitCommand -C $Root status --porcelain=v1 --untracked-files=all --ignored=matching 2>$null)
    if ($LASTEXITCODE -ne 0) {
        throw "Git could not inspect this developer folder safely."
    }
    $unsafe = @()
    foreach ($entry in $entries) {
        if (-not $entry) { continue }
        $path = ([string]$entry).Substring([Math]::Min(3, ([string]$entry).Length)).Replace("\", "/")
        # These are launcher-owned runtime outputs/settings. They are ignored
        # by Git and are explicitly preserved by setup/update flows.
        if ($entry -match "^!! " -and
            ($path -match "^\.env(?:\.[^/]*)?$" -or
             $path -match "^logs(?:/|$)" -or
             $path -match "^node_modules(?:/|$)")) {
            continue
        }
        $unsafe += $path
    }
    return $unsafe
}

function Restore-SetupQuarantineCompletely($quarantine) {
    if (-not $quarantine -or -not (Test-Path $quarantine)) { return }
    foreach ($entry in @(Get-ChildItem $quarantine -Force)) {
        $target = Join-Path $Root $entry.Name
        if (Test-Path $target) { continue }
        Move-Item -LiteralPath $entry.FullName -Destination $target -Force -ErrorAction SilentlyContinue
    }
    if (@(Get-ChildItem $quarantine -Force -ErrorAction SilentlyContinue).Count -eq 0) {
        Remove-Item $quarantine -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Restore-SetupQuarantineNonConflicting($quarantine, $gitCommand) {
    if (-not $quarantine -or -not (Test-Path $quarantine)) { return }
    $tracked = @(& $gitCommand -C $Root ls-tree -r --name-only "origin/$GithubBranch" 2>$null) |
        ForEach-Object { ([string]$_).Replace("\", "/") }
    $trackedSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($path in $tracked) { [void]$trackedSet.Add($path) }

    foreach ($entry in @(Get-ChildItem $quarantine -Force)) {
        $relative = $entry.Name.Replace("\", "/")
        $hasTrackedDescendant = $false
        foreach ($trackedPath in $trackedSet) {
            if ($trackedPath -eq $relative -or $trackedPath.StartsWith($relative + "/")) {
                $hasTrackedDescendant = $true
                break
            }
        }
        if (-not $hasTrackedDescendant) {
            $target = Join-Path $Root $entry.Name
            if (-not (Test-Path $target)) {
                Move-Item -LiteralPath $entry.FullName -Destination $target -Force -ErrorAction SilentlyContinue
            }
            continue
        }

        $files = if ($entry.PSIsContainer) {
            @(Get-ChildItem $entry.FullName -File -Recurse -Force)
        } else {
            @($entry)
        }
        foreach ($file in $files) {
            $fileRelative = $file.FullName.Substring($quarantine.Length + 1).Replace("\", "/")
            $target = Join-Path $Root ($fileRelative.Replace("/", "\"))
            if ($trackedSet.Contains($fileRelative)) {
                if ((Test-Path $target) -and
                    (Get-FileHash $file.FullName -Algorithm SHA256).Hash -eq
                    (Get-FileHash $target -Algorithm SHA256).Hash) {
                    Remove-Item $file.FullName -Force -ErrorAction SilentlyContinue
                }
                continue
            }
            if (Test-Path $target) { continue }
            New-Item -ItemType Directory -Force (Split-Path -Parent $target) | Out-Null
            Move-Item -LiteralPath $file.FullName -Destination $target -Force -ErrorAction SilentlyContinue
        }
    }

    Get-ChildItem $quarantine -Directory -Recurse -Force -ErrorAction SilentlyContinue |
        Sort-Object { $_.FullName.Length } -Descending |
        ForEach-Object {
            if (@(Get-ChildItem $_.FullName -Force -ErrorAction SilentlyContinue).Count -eq 0) {
                Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
            }
        }
    $remaining = @(Get-ChildItem $quarantine -Force -Recurse -ErrorAction SilentlyContinue)
    if ($remaining.Count -eq 0) {
        Remove-Item $quarantine -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Initialize-DeveloperGitCheckout {
    $gitCommand = Get-WillardGitCommand
    if (-not $gitCommand) { return $false }

    $gitDir = Join-Path $Root ".git"
    if (Test-Path $gitDir) {
        $unsafe = @(Get-UnsafeDeveloperWorktreeEntries $gitCommand)
        if ($unsafe.Count -gt 0) {
            throw ("Setup stopped before changing local files. Save, move, or remove these files and run setup again: " +
                (($unsafe | Select-Object -First 8) -join ", "))
        }
        $remote = Get-GitRemoteUrl $gitCommand
        if ($remote -ne $GithubRepo) {
            & $gitCommand -C $Root remote set-url origin $GithubRepo 2>$null
            if ($LASTEXITCODE -ne 0) {
                & $gitCommand -C $Root remote add origin $GithubRepo 2>$null
            }
        }
        return ($LASTEXITCODE -eq 0 -or (Get-GitRemoteUrl $gitCommand) -eq $GithubRepo)
    }

    Write-Host ""
    Write-Host "  Connect this developer copy to GitHub for one-click updates? (Y/n)" -ForegroundColor White
    $answer = if ($env:WILLARD_SETUP_CONNECT -eq "1") { "Y" } elseif ($env:WILLARD_SETUP_CONNECT -eq "0") { "N" } else { Read-Host "  Connect updates" }
    if ($answer -match '^[Nn]') {
        Write-Warn "GitHub updates skipped. You can still use the manual Update shortcut."
        return $false
    }

    $parent = Split-Path -Parent $Root
    $leaf = Split-Path -Leaf $Root
    $quarantine = Join-Path $parent ("." + $leaf + ".setup-quarantine-" + [guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Force $quarantine | Out-Null
    try {
        foreach ($entry in @(Get-ChildItem $Root -Force)) {
            Move-Item -LiteralPath $entry.FullName -Destination $quarantine -Force -ErrorAction Stop
        }
        New-Item -ItemType Directory -Force $Root | Out-Null

        Write-Info "Connecting this developer copy to GitHub without overwriting local files..."
        & $gitCommand -C $Root init --quiet
        if ($LASTEXITCODE -ne 0) { throw "Git could not initialize this developer folder." }
        & $gitCommand -C $Root remote add origin $GithubRepo 2>$null
        if ($LASTEXITCODE -ne 0) {
            & $gitCommand -C $Root remote set-url origin $GithubRepo
        }
        if ($LASTEXITCODE -ne 0) { throw "Git could not configure the Willard AI update source." }
        & $gitCommand -C $Root fetch --quiet origin $GithubBranch
        if ($LASTEXITCODE -ne 0) { throw "Git could not reach GitHub. Local files remain in the setup quarantine." }
        & $gitCommand -C $Root checkout --quiet -B $GithubBranch "origin/$GithubBranch"
        if ($LASTEXITCODE -ne 0) { throw "Git could not attach this folder to the Willard AI source branch." }

        Restore-SetupQuarantineNonConflicting $quarantine $gitCommand
        Write-Ok "One-click GitHub updates enabled"
        return $true
    } catch {
        Restore-SetupQuarantineCompletely $quarantine
        throw
    } finally {
        if (Test-Path $quarantine) {
            Write-Warn ("Setup preserved local files in this quarantine for review: " + $quarantine)
        }
    }
}

function Get-WillardPnpmCommand {
    # Windows PowerShell can resolve `pnpm` to pnpm.ps1, which wraps native
    # output as a NativeCommandError even when pnpm exits successfully. Always
    # prefer the executable wrapper for launcher-owned child processes.
    foreach ($candidate in @("pnpm.cmd", "pnpm.exe")) {
        $resolved = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($resolved) { return $resolved.Source }
    }
    return $null
}

function Ensure-LogDir {
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
    Get-ChildItem -Path $LogDir -Filter "*.log" -File -ErrorAction SilentlyContinue |
        ForEach-Object { Rotate-LauncherLog $_.FullName }
}

function Rotate-LauncherLog($path) {
    if (-not (Test-Path $path)) { return }
    try {
        if ((Get-Item $path).Length -lt $MaxLauncherLogBytes) { return }
        for ($index = $MaxLauncherLogGenerations - 1; $index -ge 1; $index--) {
            $older = $path + "." + $index
            $newer = $path + "." + ($index + 1)
            if (Test-Path $older) { Move-Item $older $newer -Force -ErrorAction SilentlyContinue }
        }
        Move-Item $path ($path + ".1") -Force -ErrorAction SilentlyContinue
    } catch {
        # A full or unavailable log disk must not prevent the launcher from
        # explaining the primary startup failure.
    }
}

function Get-DeveloperUpdateJournalPath {
    $parent = Split-Path -Parent $Root
    $leaf = Split-Path -Leaf $Root
    return (Join-Path $parent ("." + $leaf + ".willard-update.json"))
}

function Read-DeveloperUpdateJournal {
    $journalPath = Get-DeveloperUpdateJournalPath
    if (-not (Test-Path $journalPath)) { return $null }
    try { return Get-Content $journalPath -Raw | ConvertFrom-Json } catch { return $null }
}

function Write-DeveloperUpdateJournal($phase, $candidate, $backup) {
    $journalPath = Get-DeveloperUpdateJournalPath
    @{
        version = 1
        phase = $phase
        live = $Root
        candidate = $candidate
        backup = $backup
        updatedAt = (Get-Date).ToString("o")
    } | ConvertTo-Json | Set-Content $journalPath -Encoding UTF8
}

function Remove-DeveloperUpdateJournal {
    Remove-Item (Get-DeveloperUpdateJournalPath) -Force -ErrorAction SilentlyContinue
}

function Invoke-DeveloperVersionSwap($candidate, $backup) {
    if (-not (Test-Path $candidate)) { throw "The prepared update version is missing." }
    if (Test-Path $backup) { throw "A previous update backup is still present: $backup" }

    $parent = Split-Path -Parent $Root
    $liveMoved = $false
    Write-DeveloperUpdateJournal "prepared" $candidate $backup
    Push-Location $parent
    try {
        Move-Item -LiteralPath $Root -Destination $backup -ErrorAction Stop
        $liveMoved = $true
        Write-DeveloperUpdateJournal "backup-created" $candidate $backup
        if ($env:WILLARD_UPDATE_FAIL_AT -eq "swap-after-backup") {
            throw "Injected update failure after the previous version was moved."
        }
        Move-Item -LiteralPath $candidate -Destination $Root -ErrorAction Stop
        Write-DeveloperUpdateJournal "swapped" $candidate $backup
    } catch {
        $restored = -not $liveMoved
        if ($liveMoved -and -not (Test-Path $Root) -and (Test-Path $backup)) {
            Move-Item -LiteralPath $backup -Destination $Root -ErrorAction Stop
            $restored = $true
        }
        if ($restored) { Remove-DeveloperUpdateJournal }
        throw
    } finally {
        Pop-Location
    }
}

function Restore-PendingDeveloperUpdate {
    $journal = Read-DeveloperUpdateJournal
    if (-not $journal -or $journal.phase -notin @("backup-created", "swapped") -or
        -not $journal.backup -or -not (Test-Path $journal.backup)) {
        return $false
    }

    $failed = $Root + ".failed-" + [guid]::NewGuid().ToString()
    $parent = Split-Path -Parent $Root
    Push-Location $parent
    try {
        if (Test-Path $Root) { Move-Item -LiteralPath $Root -Destination $failed -ErrorAction Stop }
        Move-Item -LiteralPath $journal.backup -Destination $Root -ErrorAction Stop
        Remove-Item $failed -Recurse -Force -ErrorAction SilentlyContinue
        Remove-DeveloperUpdateJournal
        return $true
    } catch {
        if (-not (Test-Path $Root) -and (Test-Path $failed)) {
            Move-Item -LiteralPath $failed -Destination $Root -ErrorAction SilentlyContinue
        }
        throw
    } finally {
        Pop-Location
    }
}

function Recover-InterruptedDeveloperUpdate {
    $journal = Read-DeveloperUpdateJournal
    if (-not $journal) { return }
    if ($journal.phase -in @("backup-created", "swapped")) {
        if (Restore-PendingDeveloperUpdate) {
            Write-Warn "An interrupted update was found; the previous runnable version was restored."
        }
        return
    }
    if ($journal.candidate -and (Test-Path $journal.candidate)) {
        Remove-Item $journal.candidate -Recurse -Force -ErrorAction SilentlyContinue
    }
    Remove-DeveloperUpdateJournal
}

function Confirm-DeveloperUpdateHealth {
    $journal = Read-DeveloperUpdateJournal
    if (-not $journal -or $journal.phase -ne "swapped") { return }
    if ($journal.backup -and (Test-Path $journal.backup)) {
        Remove-Item $journal.backup -Recurse -Force -ErrorAction Stop
    }
    Remove-DeveloperUpdateJournal
}

function Ensure-EnvFile {
    # Auto-create .env from the template; the user is only spoken to if the
    # database connection later needs their input.
    $envPath = Join-Path $Root ".env"
    $example = Join-Path $Root ".env.example"
    if (-not (Test-Path $envPath) -and (Test-Path $example)) {
        Copy-Item $example $envPath
        # Give the copy a real random session secret
        $secret = -join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
        (Get-Content $envPath) -replace '^SESSION_SECRET=.*$', "SESSION_SECRET=$secret" | Set-Content $envPath
        return $true
    }
    return $false
}

function New-WillardShortcut {
    param(
        [Parameter(Mandatory = $true)][string]$ShortcutPath,
        [Parameter(Mandatory = $true)][string]$TargetPath,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [string]$IconPath,
        [string]$Description = "Start your local Willard Media Center"
    )

    $shortcutDirectory = Split-Path -Parent $ShortcutPath
    if (-not (Test-Path $shortcutDirectory)) {
        New-Item -ItemType Directory -Path $shortcutDirectory -Force | Out-Null
    }

    # Target cmd.exe rather than the batch file itself so Windows honors the
    # working directory consistently, even when the shortcut is launched from
    # Explorer, Start, or a different current directory.
    $shell = New-Object -ComObject WScript.Shell
    try {
        $shortcut = $shell.CreateShortcut($ShortcutPath)
        $shortcut.TargetPath = Join-Path $env:SystemRoot "System32\cmd.exe"
        $shortcut.Arguments = '/d /c ""' + $TargetPath + '""'
        $shortcut.WorkingDirectory = $WorkingDirectory
        $shortcut.Description = $Description
        if ($IconPath -and (Test-Path $IconPath)) {
            $shortcut.IconLocation = $IconPath + ",0"
        }
        $shortcut.Save()
    } finally {
        if ($shortcut) {
            [Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) | Out-Null
        }
        if ($shell) {
            [Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null
        }
    }
}

function Get-EnvValue($key) {
    $envPath = Join-Path $Root ".env"
    if (-not (Test-Path $envPath)) { return $null }
    foreach ($line in Get-Content $envPath) {
        if ($line -match ("^\s*" + [regex]::Escape($key) + "\s*=\s*(.+)\s*$")) {
            return $Matches[1].Trim()
        }
    }
    return $null
}

function Test-DatabaseConnection {
    # TCP reachability check using Node's built-in net module - no npm
    # packages needed. Returns $true/$false; detail lands in the api log.
    $dbUrl = Get-EnvValue "DATABASE_URL"
    if (-not $dbUrl) { return $false }
    $testJs = @"
var net = require('net');
var url = new URL(process.env.WILLARD_DB_TEST_URL);
var port = parseInt(url.port) || 5432;
var host = url.hostname || 'localhost';
var s = net.createConnection({ port: port, host: host });
s.setTimeout(5000);
s.on('connect', function() { s.destroy(); process.exit(0); });
s.on('timeout', function() { s.destroy(); process.exit(1); });
s.on('error', function(e) { process.stderr.write(e.message + '\n'); process.exit(1); });
"@
    $tmp = Join-Path $env:TEMP "willard-db-test.js"
    Set-Content -Path $tmp -Value $testJs
    $env:WILLARD_DB_TEST_URL = $dbUrl
    try {
        $savedPref = $ErrorActionPreference
        $ErrorActionPreference = "SilentlyContinue"
        $out = & node $tmp 2>&1
        $okExit = ($LASTEXITCODE -eq 0)
        $ErrorActionPreference = $savedPref
        if (-not $okExit) { Add-Content $ApiLog ("[launcher] Database test failed: " + ($out -join " ")) }
        return $okExit
    } finally {
        Remove-Item $tmp -ErrorAction SilentlyContinue
        Remove-Item Env:\WILLARD_DB_TEST_URL -ErrorAction SilentlyContinue
    }
}

function Wait-ForDatabase($timeoutSeconds = 30) {
    $until = (Get-Date).AddSeconds($timeoutSeconds)
    while ((Get-Date) -lt $until) {
        if (Test-DatabaseConnection) { return $true }
        Start-Sleep -Seconds 2
    }
    return $false
}

function Ensure-AppDatabase {
    # Creates the Willard AI database if it doesn't exist yet, then verifies
    # the connection. Returns $true on success, $false on failure.
    $dbUrl = Get-EnvValue "DATABASE_URL"
    if (-not $dbUrl) { return $false }
    $createJs = @'
const { Client } = require('pg');
const url = new URL(process.env.WILLARD_DB_URL);
let dbName;
try {
  dbName = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
} catch {
  console.error('DATABASE_URL is not a valid PostgreSQL connection string.');
  process.exit(1);
}
if (!dbName || dbName.includes('\0') || Buffer.byteLength(dbName, 'utf8') > 63) {
  console.error('DATABASE_URL must contain a non-empty PostgreSQL database name no longer than 63 bytes.');
  process.exit(1);
}
function quoteIdentifier(identifier) {
  return '"' + identifier.replaceAll('"', '""') + '"';
}
(async () => {
  const target = new Client({ connectionString: process.env.WILLARD_DB_URL, connectionTimeoutMillis: 5000 });
  let targetExists = false;
  try {
    await target.connect();
    targetExists = true;
  } catch (error) {
    if (!error || error.code !== '3D000') {
      console.error('The configured PostgreSQL role could not connect to database "' + dbName + '": ' +
        (error && error.message ? error.message : 'connection failed'));
      process.exitCode = 1;
      return;
    }
  } finally {
    try { await target.end(); } catch {}
  }
  if (targetExists) return;

  url.pathname = '/postgres';
  const admin = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  try {
    await admin.connect();
    const result = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (result.rows.length === 0) {
      try {
        await admin.query('CREATE DATABASE ' + quoteIdentifier(dbName));
      } catch (error) {
        if (error && (error.code === '42501' || /permission denied.*database/i.test(error.message || ''))) {
          throw new Error('The configured PostgreSQL role cannot create database "' + dbName +
            '". Create it with an administrator or grant CREATEDB, then run setup again.');
        }
        throw error;
      }
    }
  } catch (error) {
    if (error && error.code === '42501') {
      console.error('Database "' + dbName + '" does not exist and the configured PostgreSQL role cannot access ' +
        'the maintenance database to create it. Ask an administrator to create the database and grant this role access.');
    } else {
      console.error(error.message);
    }
    process.exitCode = 1;
  } finally {
    try { await admin.end(); } catch {}
  }
})();
'@
    $tmp = Join-Path $env:TEMP "willard-db-create.js"
    Set-Content -Path $tmp -Value $createJs
    $env:WILLARD_DB_URL = $dbUrl
    try {
        $out = & node $tmp 2>&1
        $okExit = ($LASTEXITCODE -eq 0)
        if (-not $okExit) { Add-Content $ApiLog ("[launcher] Database create failed: " + ($out -join " ")) }
        return $okExit
    } finally {
        Remove-Item $tmp -ErrorAction SilentlyContinue
        Remove-Item Env:\WILLARD_DB_URL -ErrorAction SilentlyContinue
    }
}

function Test-PortFree($port) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    return (-not $conn)
}

function Get-PortOwnerPid($port) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { return $conn.OwningProcess }
    return $null
}

function Read-TrackedPids {
    if (-not (Test-Path $PidFile)) { return $null }
    try { return Get-Content $PidFile -Raw | ConvertFrom-Json } catch { return $null }
}

function Get-ProcessIdentity($processId) {
    if (-not $processId) { return $null }
    try {
        $process = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$processId) -ErrorAction Stop
        if (-not $process) { return $null }
        return @{
            pid = [int]$process.ProcessId
            path = [string]$process.ExecutablePath
            commandLine = [string]$process.CommandLine
            creationDate = [string]$process.CreationDate
        }
    } catch {
        return $null
    }
}

function Test-ProcessIdentity($tracked) {
    if (-not $tracked) { return $false }
    $trackedProcessId = if ($tracked.pid) { $tracked.pid } else { $tracked }
    $current = Get-ProcessIdentity $trackedProcessId
    if (-not $current) { return $false }
    # Refuse to act on legacy PID-only records. A reused PID must never be
    # mistaken for a Willard process.
    if (-not $tracked.path -or -not $tracked.commandLine) { return $false }
    return ($current.path -eq $tracked.path -and
        $current.commandLine -eq $tracked.commandLine -and
        (-not $tracked.creationDate -or $current.creationDate -eq $tracked.creationDate))
}

function Save-TrackedPids($apiPid, $webPid) {
    Ensure-LogDir
    $apiIdentity = Get-ProcessIdentity $apiPid
    $webIdentity = Get-ProcessIdentity $webPid
    @{ version = 2; runToken = $script:WillardRunToken; api = $apiIdentity; web = $webIdentity; startedAt = (Get-Date).ToString("o") } |
        ConvertTo-Json | Set-Content $PidFile
}

function Clear-TrackedPids {
    Remove-Item $PidFile -ErrorAction SilentlyContinue
}

function Test-ProcessAlive($processId) {
    if ($processId -is [psobject] -and $processId.pid) {
        return (Test-ProcessIdentity $processId)
    }
    if (-not $processId) { return $false }
    return [bool](Get-Process -Id $processId -ErrorAction SilentlyContinue)
}

function Stop-TrackedProcesses {
    # Stops ONLY what the launcher started (tracked PIDs + their children).
    $pids = Read-TrackedPids
    $stopped = 0
    if ($pids) {
        foreach ($p in @($pids.api, $pids.web)) {
            if ($p -and (Test-ProcessIdentity $p)) {
                # Stop the whole tree the tracked process spawned
                & taskkill /PID $p.pid /T /F 2>&1 | Out-Null
                $stopped++
            }
        }
    }
    Clear-TrackedPids
    return $stopped
}

function Get-LogTail($path, $lines = 20) {
    if (-not (Test-Path $path)) { return "(no log was written)" }
    try {
        return ((Get-Content $path -Tail $lines -ErrorAction Stop) -join " ")
    } catch {
        return "(log could not be read: " + $_.Exception.Message + ")"
    }
}

function Wait-ForUrl($url, $label, $timeoutSeconds = 60, $processId = $null, $logPath = $null) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $lastTick = -5
    while ($sw.Elapsed.TotalSeconds -lt $timeoutSeconds) {
        if ($processId -and -not (Test-ProcessAlive $processId)) {
            $script:LastWaitFailureReason = "$label process exited before it became ready. " +
                (Get-LogTail $logPath)
            return $false
        }
        try {
            $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
            $content = [string]$r.Content
            if ($r.StatusCode -eq 200) {
                if ($url -match "/api/healthz$") {
                    if ($content -match '"status"\s*:\s*"ok"') { return $true }
                } elseif ($content -match "<html|<!doctype html") {
                    return $true
                }
            }
        } catch { }
        $elapsed = [int]$sw.Elapsed.TotalSeconds
        if ($elapsed - $lastTick -ge 5) {
            Write-Info ("Still getting " + $label + " ready... (" + $elapsed + "s)")
            $lastTick = $elapsed
        }
        Start-Sleep -Milliseconds 800
    }
    $script:LastWaitFailureReason = "$label did not answer $url within $timeoutSeconds seconds. " +
        (Get-LogTail $logPath)
    return $false
}
