# End-to-end installed-app lifecycle smoke for a disposable Windows runner.
# It intentionally uses the actual Inno Setup executable and a standard local
# account. PostgreSQL is external to the installer and is preserved until the
# assertions complete.
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Version = if ($env:WILLARD_VERSION) { $env:WILLARD_VERSION } else { throw "WILLARD_VERSION is required." }
$FirstInstaller = Join-Path $Root "build\installer\WillardMediaCenter-$Version-Setup.exe"
$PostgresBin = Join-Path $env:RUNNER_TEMP "postgresql\pgsql\bin"
$Psql = Join-Path $PostgresBin "psql.exe"
$Createdb = Join-Path $PostgresBin "createdb.exe"
$Dropdb = Join-Path $PostgresBin "dropdb.exe"
$TempRoot = Join-Path $env:RUNNER_TEMP "willard-installer-lifecycle-$([guid]::NewGuid().ToString())"
$UserName = "wl_life_$([guid]::NewGuid().ToString("N").Substring(0, 8))"
$Password = ConvertTo-SecureString "WillardLifecycle!1" -AsPlainText -Force
$Credential = [pscredential]::new(".\$UserName", $Password)
$Database = "willard_lifecycle_$([guid]::NewGuid().ToString("N").Substring(0, 8))"
$InstallRoot = Join-Path $env:SystemDrive "WillardLifecycle\$UserName"
$MediaRoot = Join-Path $TempRoot "external-media"
$Runner = Join-Path $TempRoot "run-installed-launcher.ps1"
$script:UserLocalAppData = $null
$script:DataRoot = $null
$script:LifecyclePassed = $false

function Assert-True($condition, $message) {
  if (-not $condition) { throw $message }
}

function Read-Text($path) {
  if (Test-Path $path) { return Get-Content $path -Raw }
  return ""
}

function Wait-Http($url, $predicate, $timeoutSeconds = 150) {
  $until = (Get-Date).AddSeconds($timeoutSeconds)
  while ((Get-Date) -lt $until) {
    try {
      $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -eq 200 -and (& $predicate ([string]$response.Content))) { return }
    } catch {}
    Start-Sleep -Seconds 2
  }
  throw "Timed out waiting for $url"
}

function Invoke-AsLifecycleUser($filePath, $argumentLine, $label) {
  $stdout = Join-Path $TempRoot "$label.out.log"
  $stderr = Join-Path $TempRoot "$label.err.log"
  $process = Start-Process -FilePath $filePath -ArgumentList $argumentLine `
    -Credential $Credential -LoadUserProfile -WorkingDirectory $TempRoot `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -Wait
  return @{
    exitCode = $process.ExitCode
    output = (Read-Text $stdout) + (Read-Text $stderr)
  }
}

function Invoke-InstalledLauncher($mode, $label) {
  $launcher = Join-Path $InstallRoot "desktop\WillardMediaCenter.ps1"
  $argumentLine = "-NoProfile -ExecutionPolicy Bypass -File `"$Runner`" -Launcher `"$launcher`" -Mode $mode"
  return Invoke-AsLifecycleUser (Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe") $argumentLine $label
}

function Stop-InstalledWillard {
  if (-not (Test-Path (Join-Path $InstallRoot "desktop\WillardMediaCenter.ps1"))) { return }
  $result = Invoke-InstalledLauncher "stop" "stop-$([guid]::NewGuid().ToString("N"))"
  Assert-True ($result.exitCode -eq 0) ("Installed stop command failed:`n" + $result.output)
}

function Assert-ExternalState {
  Assert-True ((Read-Text (Join-Path $MediaRoot "family-media.marker")) -match "original media") "External media marker changed."
  Assert-True ((Read-Text (Join-Path $script:DataRoot "settings.marker")) -match "preserve settings") "External settings marker changed."
  $marker = & $Psql -h localhost -U postgres -d $Database -Atc "SELECT marker FROM willard_lifecycle_marker LIMIT 1"
  Assert-True ($LASTEXITCODE -eq 0 -and ([string]$marker).Trim() -eq "preserve database") "External PostgreSQL marker changed."
}

try {
  Assert-True ($env:OS -eq "Windows_NT" -or $IsWindows) "This lifecycle smoke must run on Windows."
  Assert-True (Test-Path $FirstInstaller) "The compiled Setup.exe is missing: $FirstInstaller"
  Assert-True (Test-Path $Psql) "PostgreSQL 16 client tools are missing."
  New-Item -ItemType Directory -Force -Path $TempRoot, $MediaRoot | Out-Null
  Set-Content (Join-Path $MediaRoot "family-media.marker") "original media" -Encoding UTF8
  & $Createdb -h localhost -U postgres $Database
  if ($LASTEXITCODE -ne 0) { throw "Could not create lifecycle PostgreSQL database $Database." }

  New-LocalUser -Name $UserName -Password $Password -AccountNeverExpires -PasswordNeverExpires | Out-Null
  $administrators = @(Get-LocalGroupMember -Group "Administrators" | ForEach-Object Name)
  Assert-True ($administrators -notcontains "$env:COMPUTERNAME\$UserName") "Lifecycle account must remain a standard user."
  New-Item -ItemType Directory -Force (Split-Path -Parent $InstallRoot) | Out-Null
  $tempAclOutput = & icacls $TempRoot /grant "$env:COMPUTERNAME\${UserName}:(OI)(CI)F" /T /C 2>&1
  Assert-True ($LASTEXITCODE -eq 0) ("Could not grant lifecycle user access to the test workspace:`n" + ($tempAclOutput -join "`n"))
  $installAclOutput = & icacls (Split-Path -Parent $InstallRoot) /grant "$env:COMPUTERNAME\${UserName}:(OI)(CI)F" /T /C 2>&1
  Assert-True ($LASTEXITCODE -eq 0) ("Could not grant lifecycle user access to the install root:`n" + ($installAclOutput -join "`n"))

  # Create the user profile and discover the exact per-user local app-data path.
  $profileProbe = Join-Path $TempRoot "profile-probe.ps1"
  Set-Content $profileProbe @'
"USERNAME=$env:USERNAME"
"USERPROFILE=$env:USERPROFILE"
"LOCALAPPDATA=$env:LOCALAPPDATA"
'@ -Encoding ASCII
  $profileResult = Invoke-AsLifecycleUser (Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe") `
    "-NoProfile -ExecutionPolicy Bypass -File `"$profileProbe`"" "profile-probe"
  Assert-True ($profileResult.exitCode -eq 0) ("Could not initialize the standard-user profile:`n" + $profileResult.output)
  Assert-True (($profileResult.output -split "\r?\n") -contains "USERNAME=$UserName") `
    ("Lifecycle process did not run as the disposable standard user:`n" + $profileResult.output)
  $localAppDataLine = @($profileResult.output -split "\r?\n" | Where-Object { $_ -like "LOCALAPPDATA=*" })[0]
  $script:UserLocalAppData = $localAppDataLine.Substring("LOCALAPPDATA=".Length).Trim()
  Assert-True $script:UserLocalAppData "The standard-user profile did not provide LOCALAPPDATA."
  $script:DataRoot = Join-Path $script:UserLocalAppData "Willard Media Center"
  $userProfile = Split-Path -Parent (Split-Path -Parent $script:UserLocalAppData)
  New-Item -ItemType Directory -Force $script:DataRoot | Out-Null
  @(
    "DATABASE_URL=postgresql://postgres:postgres@localhost:5432/$Database",
    "PORT=8080",
    "SESSION_SECRET=installer-lifecycle-session-secret"
  ) | Set-Content (Join-Path $script:DataRoot ".env") -Encoding UTF8
  Set-Content (Join-Path $script:DataRoot "settings.marker") "preserve settings" -Encoding UTF8

  @'
param(
  [Parameter(Mandatory = $true)][string]$Launcher,
  [Parameter(Mandatory = $true)][ValidateSet("start", "stop", "failure")][string]$Mode
)
$env:WILLARD_SKIP_UPDATE = "1"
if ($Mode -eq "failure") { $env:WILLARD_SUPPRESS_STARTUP_DIALOG = "1" }
if ($Mode -eq "stop") { & $Launcher -Stop } else { & $Launcher }
exit $LASTEXITCODE
'@ | Set-Content $Runner -Encoding ASCII

  $firstInstallLog = Join-Path $TempRoot "first-install-setup.log"
  $firstInstallerForUser = Join-Path $TempRoot "first-install-Setup.exe"
  Copy-Item $FirstInstaller $firstInstallerForUser -Force
  $installResult = Invoke-AsLifecycleUser $firstInstallerForUser "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /LOG=`"$firstInstallLog`" /DIR=`"$InstallRoot`"" "first-install"
  Assert-True ($installResult.exitCode -eq 0) ("Setup.exe first install failed with exit code $($installResult.exitCode):`n" + $installResult.output + "`n" + (Read-Text $firstInstallLog))
  Assert-True (Test-Path (Join-Path $InstallRoot "desktop\WillardMediaCenter.ps1")) "First install did not include the native launcher."
  $desktopShortcut = Join-Path $userProfile "Desktop\Willard Media Center.lnk"
  $startMenuRoot = Join-Path $userProfile "AppData\Roaming\Microsoft\Windows\Start Menu\Programs"
  Assert-True (Test-Path $desktopShortcut) "First install did not create the standard-user desktop shortcut."
  Assert-True (@(Get-ChildItem $startMenuRoot -Filter "Willard Media Center.lnk" -Recurse -ErrorAction SilentlyContinue).Count -eq 1) `
    "First install did not create the standard-user Start Menu shortcut."

  $startResult = Invoke-InstalledLauncher "start" "first-start"
  Assert-True ($startResult.exitCode -eq 0) ("Installed launcher failed after first install:`n" + $startResult.output)
  Wait-Http "http://127.0.0.1:8080/api/healthz" { param($content) $content -match '"status"\s*:\s*"ok"' }
  Wait-Http "http://127.0.0.1:5000" { param($content) $content -match "<html|<!doctype html" }
  & $Psql -h localhost -U postgres -d $Database -c "CREATE TABLE IF NOT EXISTS willard_lifecycle_marker (marker text NOT NULL); DELETE FROM willard_lifecycle_marker; INSERT INTO willard_lifecycle_marker (marker) VALUES ('preserve database');"
  if ($LASTEXITCODE -ne 0) { throw "Could not seed external PostgreSQL lifecycle marker." }
  Assert-ExternalState
  Stop-InstalledWillard

  # Upgrade through a newer Setup.exe version while retaining the same external
  # database, app-data settings, and media root.
  $upgradeVersion = "0.1.$([int]$env:GITHUB_RUN_NUMBER + 1)"
  $env:WILLARD_VERSION = $upgradeVersion
  & (Join-Path $Root "scripts\windows\compile-installer.ps1")
  $upgradeInstaller = Join-Path $Root "build\installer\WillardMediaCenter-$upgradeVersion-Setup.exe"
  Assert-True (Test-Path $upgradeInstaller) "The newer upgrade Setup.exe was not compiled."
  $upgradeInstallLog = Join-Path $TempRoot "upgrade-install-setup.log"
  $upgradeInstallerForUser = Join-Path $TempRoot "upgrade-install-Setup.exe"
  Copy-Item $upgradeInstaller $upgradeInstallerForUser -Force
  $upgradeResult = Invoke-AsLifecycleUser $upgradeInstallerForUser "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /LOG=`"$upgradeInstallLog`" /DIR=`"$InstallRoot`"" "upgrade-install"
  Assert-True ($upgradeResult.exitCode -eq 0) ("Setup.exe upgrade failed with exit code $($upgradeResult.exitCode):`n" + $upgradeResult.output + "`n" + (Read-Text $upgradeInstallLog))
  Assert-ExternalState

  $upgradeStart = Invoke-InstalledLauncher "start" "upgrade-start"
  Assert-True ($upgradeStart.exitCode -eq 0) ("Installed launcher failed after upgrade:`n" + $upgradeStart.output)
  Wait-Http "http://127.0.0.1:8080/api/healthz" { param($content) $content -match '"status"\s*:\s*"ok"' }
  Stop-InstalledWillard

  # Simulate a power loss after a packaged version swap. The next installed
  # launcher must restore its sibling backup before starting services.
  $backup = $InstallRoot + ".lifecycle-backup"
  $candidate = $InstallRoot + ".lifecycle-candidate"
  Copy-Item $InstallRoot $candidate -Recurse -Force
  Set-Content (Join-Path $candidate "candidate-only.marker") "discard candidate" -Encoding UTF8
  Set-Content (Join-Path $InstallRoot "backup-only.marker") "restore backup" -Encoding UTF8
  Move-Item -LiteralPath $InstallRoot -Destination $backup -ErrorAction Stop
  Move-Item -LiteralPath $candidate -Destination $InstallRoot -ErrorAction Stop
  $journalPath = Join-Path $script:DataRoot "updates\swap-journal.json"
  New-Item -ItemType Directory -Force (Split-Path $journalPath) | Out-Null
  @{
    version = 1
    phase = "swapped"
    installRoot = $InstallRoot
    candidate = $candidate
    backup = $backup
    updatedAt = (Get-Date).ToString("o")
  } | ConvertTo-Json | Set-Content $journalPath -Encoding UTF8

  $recoveryStart = Invoke-InstalledLauncher "start" "interrupted-update-recovery"
  Assert-True ($recoveryStart.exitCode -eq 0) ("Installed launcher did not recover the interrupted update:`n" + $recoveryStart.output)
  Wait-Http "http://127.0.0.1:8080/api/healthz" { param($content) $content -match '"status"\s*:\s*"ok"' }
  Assert-True (Test-Path (Join-Path $InstallRoot "backup-only.marker")) "The prior packaged version was not restored."
  Assert-True (-not (Test-Path (Join-Path $InstallRoot "candidate-only.marker"))) "The interrupted candidate remained active."
  Assert-True (-not (Test-Path $journalPath)) "Interrupted packaged update journal was not cleared."
  Assert-ExternalState
  Stop-InstalledWillard

  # A database failure must persist diagnostics and return control without a
  # modal dialog in this noninteractive test run.
  $envFile = Join-Path $script:DataRoot ".env"
  Copy-Item $envFile ($envFile + ".good") -Force
  @(
    "DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:1/$Database",
    "PORT=8080",
    "SESSION_SECRET=installer-lifecycle-session-secret"
  ) | Set-Content $envFile -Encoding UTF8
  $failure = Invoke-InstalledLauncher "failure" "database-failure"
  Assert-True ($failure.exitCode -ne 0) "The injected external database failure unexpectedly succeeded."
  Assert-True ((Read-Text (Join-Path $script:DataRoot "logs\startup-failure.log")) -match "database") `
    "Database startup failure did not preserve actionable diagnostics."
  Move-Item ($envFile + ".good") $envFile -Force
  Assert-ExternalState

  $uninstaller = Join-Path $InstallRoot "unins000.exe"
  Assert-True (Test-Path $uninstaller) "Installed copy did not contain Inno Setup uninstaller."
  $uninstallResult = Invoke-AsLifecycleUser $uninstaller "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART" "uninstall"
  Assert-True ($uninstallResult.exitCode -eq 0) ("Setup.exe uninstall failed:`n" + $uninstallResult.output)
  Assert-True (-not (Test-Path (Join-Path $InstallRoot "desktop\WillardMediaCenter.ps1"))) "Uninstall left packaged launcher files behind."
  Assert-True (-not (Test-Path $desktopShortcut)) "Uninstall left the desktop shortcut behind."
  Assert-ExternalState
  $script:LifecyclePassed = $true
  Write-Host "Installed lifecycle smoke passed: standard user, install, start, upgrade, rollback, diagnostics, and uninstall."
} finally {
  try { Stop-InstalledWillard } catch {}
  if (Test-Path $Dropdb) {
    try { & $Dropdb -h localhost -U postgres --if-exists $Database | Out-Null } catch {}
  }
  try { Remove-LocalUser -Name $UserName -ErrorAction SilentlyContinue } catch {}
  Remove-Item $InstallRoot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item ($InstallRoot + ".lifecycle-backup") -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item ($InstallRoot + ".lifecycle-candidate") -Recurse -Force -ErrorAction SilentlyContinue
  if ($script:LifecyclePassed) {
    Remove-Item $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    Write-Host "Lifecycle diagnostics preserved at $TempRoot" -ForegroundColor Yellow
    if (Test-Path $TempRoot) {
      Get-ChildItem $TempRoot -Recurse -File -ErrorAction SilentlyContinue |
        ForEach-Object {
          Write-Host "Lifecycle file: $($_.FullName)"
          if ($_.Extension -eq ".log") {
            Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue
          }
        }
    }
  }
}