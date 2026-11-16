# Verify the installed Settings-driven mapped-drive backup and recovery flow.
# The Windows runner maps Z: to a disposable local folder; it cannot validate
# connectivity or authentication against the user's physical NAS.
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Version = if ($env:WILLARD_VERSION) { $env:WILLARD_VERSION } else { throw "WILLARD_VERSION is required." }
$InstallerSource = Join-Path $Root "build\installer\WillardMediaCenter-$Version-Setup.exe"
$ReleaseRoot = Join-Path $Root "build\windows"
$PostgresBin = Join-Path $env:RUNNER_TEMP "postgresql\pgsql\bin"
$Psql = Join-Path $PostgresBin "psql.exe"
$PgDump = Join-Path $PostgresBin "pg_dump.exe"
$PgRestore = Join-Path $PostgresBin "pg_restore.exe"
$Createdb = Join-Path $PostgresBin "createdb.exe"
$Dropdb = Join-Path $PostgresBin "dropdb.exe"
$TempRoot = Join-Path $env:RUNNER_TEMP "willard-nas-settings-$([guid]::NewGuid().ToString())"
$UserName = "wl_nas_$([guid]::NewGuid().ToString("N").Substring(0, 8))"
$UserPassword = ConvertTo-SecureString "WillardNasTest!1" -AsPlainText -Force
$Credential = [pscredential]::new(".\$UserName", $UserPassword)
$SettingsDatabase = "willard_nas_settings_$([guid]::NewGuid().ToString("N").Substring(0, 8))"
$RestoreDatabase = "willard_nas_restore_$([guid]::NewGuid().ToString("N").Substring(0, 8))"
$SettingsDatabaseUrl = "postgresql://postgres:postgres@127.0.0.1:5432/$SettingsDatabase"
$RestoreDatabaseUrl = "postgresql://postgres:postgres@127.0.0.1:5432/$RestoreDatabase"
$Installer = Join-Path $TempRoot "WillardMediaCenter-test-Setup.exe"
$InstallRoot = Join-Path $TempRoot "installed-app"
$NasBackingRoot = Join-Path $TempRoot "mapped-nas"
$RecoveryExport = Join-Path $TempRoot "Willard-Library-Recovery.willard-recovery.json"
$SavedNasPathFile = Join-Path $TempRoot "saved-settings-nas-path.txt"
$Runner = Join-Path $TempRoot "run-nas-settings-smoke.ps1"
$ExportPassphrase = "nas-settings-test-export-passphrase"
$SetupPassword = "Willard-NAS-Settings-Test!123"
$script:SmokePassed = $false
$script:UserCreated = $false
$script:PGPasswordWasSet = $false
$script:PreviousPGPassword = $null

function Assert-True($condition, $message) {
  if (-not $condition) { throw $message }
}

function Invoke-PackagedNode($node, $arguments, $environment) {
  $saved = @{}
  foreach ($entry in $environment.GetEnumerator()) {
    $saved[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, "Process")
    Set-Item "Env:$($entry.Key)" $entry.Value
  }
  try {
    $output = & $node @arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw ($output -join "`n")
    }
    return ([string]$output) -join "`n"
  } finally {
    foreach ($entry in $saved.GetEnumerator()) {
      if ($null -eq $entry.Value) {
        Remove-Item "Env:$($entry.Key)" -ErrorAction SilentlyContinue
      } else {
        Set-Item "Env:$($entry.Key)" $entry.Value
      }
    }
  }
}

function Invoke-AsNasTestUser($mode, $label, $timeoutSeconds = 900) {
  $stdout = Join-Path $TempRoot "$label.out.log"
  $stderr = Join-Path $TempRoot "$label.err.log"
  $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Runner`" -Mode $mode"
  $process = Start-Process -FilePath $powershell -ArgumentList $arguments `
    -Credential $Credential -LoadUserProfile -UseNewEnvironment -WorkingDirectory $TempRoot `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  if (-not $process.WaitForExit($timeoutSeconds * 1000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    $stdoutTail = if (Test-Path $stdout) { (Get-Content -LiteralPath $stdout -Tail 80 | Out-String).TrimEnd() } else { "" }
    $stderrTail = if (Test-Path $stderr) { (Get-Content -LiteralPath $stderr -Tail 80 | Out-String).TrimEnd() } else { "" }
    throw "$label timed out after $timeoutSeconds seconds.`n--- stdout tail ---`n$stdoutTail`n--- stderr tail ---`n$stderrTail"
  }
  $process.Refresh()
  $stdoutContent = if (Test-Path $stdout) { Get-Content $stdout -Raw } else { "" }
  $stderrContent = if (Test-Path $stderr) { Get-Content $stderr -Raw } else { "" }
  $result = @{
    exitCode = $process.ExitCode
    output = ([string]$stdoutContent) + ([string]$stderrContent)
  }
  return $result
}

function Invoke-Psql($database, $sql) {
  $output = & $Psql -h 127.0.0.1 -U postgres -d $database -Atc $sql 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "PostgreSQL query failed for $database`: $($output -join "`n")"
  }
  return ([string]$output).Trim()
}

try {
  Assert-True ($env:OS -eq "Windows_NT" -or $IsWindows) "This Settings-driven NAS smoke must run on Windows."
  Assert-True (Test-Path -LiteralPath $InstallerSource -PathType Leaf) "The compiled Setup.exe is missing: $InstallerSource"
  Assert-True (Test-Path -LiteralPath (Join-Path $ReleaseRoot "runtime\node.exe")) "The packaged Node runtime is missing."
  Assert-True (Test-Path -LiteralPath (Join-Path $ReleaseRoot "api-runtime\setup-db.cjs")) "The packaged database bootstrap is missing."
  Assert-True (Test-Path -LiteralPath $Psql -PathType Leaf) "PostgreSQL 16 client tools are missing."
  Assert-True (Test-Path -LiteralPath $PgDump -PathType Leaf) "The pinned PostgreSQL 16 pg_dump tool is missing."
  Assert-True (Test-Path -LiteralPath $PgRestore -PathType Leaf) "The pinned PostgreSQL 16 pg_restore tool is missing."

  New-Item -ItemType Directory -Force -Path $TempRoot, $NasBackingRoot | Out-Null
  Copy-Item -LiteralPath $InstallerSource -Destination $Installer
  $script:PreviousPGPassword = [Environment]::GetEnvironmentVariable("PGPASSWORD", "Process")
  $script:PGPasswordWasSet = $true
  $env:PGPASSWORD = "postgres"
  & $Createdb -h 127.0.0.1 -U postgres $SettingsDatabase
  if ($LASTEXITCODE -ne 0) { throw "Could not create the Settings-flow database." }
  & $Createdb -h 127.0.0.1 -U postgres $RestoreDatabase
  if ($LASTEXITCODE -ne 0) { throw "Could not create the Settings-flow restore database." }

  $node = Join-Path $ReleaseRoot "runtime\node.exe"
  $setupDb = Join-Path $ReleaseRoot "api-runtime\setup-db.cjs"
  $backupScript = Join-Path $ReleaseRoot "desktop\database-backup.mjs"
  Invoke-PackagedNode $node @($setupDb) @{ DATABASE_URL = $SettingsDatabaseUrl } | Out-Null

  $UserRule = "$env:COMPUTERNAME\${UserName}:(OI)(CI)F"
  New-LocalUser -Name $UserName -Password $UserPassword -AccountNeverExpires -PasswordNeverExpires | Out-Null
  $script:UserCreated = $true
  $administrators = @(Get-LocalGroupMember -Group "Administrators" | ForEach-Object Name)
  Assert-True ($administrators -notcontains "$env:COMPUTERNAME\$UserName") `
    "The NAS Settings workflow account must remain a standard Windows user."
  $aclOutput = & icacls $TempRoot /grant $UserRule /T /C 2>&1
  Assert-True ($LASTEXITCODE -eq 0) ("Could not grant the test account access to its disposable files:`n" + ($aclOutput -join "`n"))

  $installerLiteral = $Installer.Replace("'", "''")
  $installRootLiteral = $InstallRoot.Replace("'", "''")
  $nasRootLiteral = $NasBackingRoot.Replace("'", "''")
  $recoveryExportLiteral = $RecoveryExport.Replace("'", "''")
  $savedPathFileLiteral = $SavedNasPathFile.Replace("'", "''")
  $settingsDatabaseUrlLiteral = $SettingsDatabaseUrl.Replace("'", "''")
  $restoreDatabaseUrlLiteral = $RestoreDatabaseUrl.Replace("'", "''")
  $nodeLiteral = $node.Replace("'", "''")
  $backupScriptLiteral = $backupScript.Replace("'", "''")
  $psqlLiteral = $Psql.Replace("'", "''")
  $pgDumpLiteral = $PgDump.Replace("'", "''")
  $pgRestoreLiteral = $PgRestore.Replace("'", "''")
  $exportPassphraseLiteral = $ExportPassphrase.Replace("'", "''")
  $setupPasswordLiteral = $SetupPassword.Replace("'", "''")
  $usernameLiteral = $UserName.Replace("'", "''")

  $runnerContents = @'
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("settings-flow", "settings-restore", "cleanup")]
  [string]$Mode
)
$ErrorActionPreference = "Stop"
$installer = '__INSTALLER__'
$installRoot = '__INSTALL_ROOT__'
$nasBackingRoot = '__NAS_ROOT__'
$recoveryExport = '__RECOVERY_EXPORT__'
$savedPathFile = '__SAVED_PATH_FILE__'
$settingsDatabaseUrl = '__SETTINGS_DATABASE_URL__'
$restoreDatabaseUrl = '__RESTORE_DATABASE_URL__'
$node = '__NODE__'
$backupScript = '__BACKUP_SCRIPT__'
$psql = '__PSQL__'
$env:PSQL_BIN = '__PSQL__'
$env:PGDUMP_BIN = '__PGDUMP__'
$env:PGRESTORE_BIN = '__PGRESTORE__'
$exportPassphrase = '__EXPORT_PASSPHRASE__'
$setupPassword = '__SETUP_PASSWORD__'
$expectedUser = '__USERNAME__'
$dataRoot = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) "Willard Media Center"
$envPath = Join-Path $dataRoot ".env"
$launcher = Join-Path $dataRoot "WillardBootstrap.ps1"
$script:AppStarted = $false
$script:Mapped = $false

function Assert-True($condition, $message) {
  if (-not $condition) { throw $message }
}

function Write-TestProgress([string]$message) {
  [Console]::Out.WriteLine($message)
  [Console]::Out.Flush()
}

function Invoke-Api($method, $path, $body, $webSession) {
  $parameters = @{
    Uri = "http://127.0.0.1:8080/api$path"
    Method = $method
    TimeoutSec = 30
    UseBasicParsing = $true
  }
  if ($null -ne $webSession) { $parameters.WebSession = $webSession }
  if ($null -ne $body) {
    $parameters.ContentType = "application/json"
    $parameters.Body = ConvertTo-Json -InputObject $body -Depth 12 -Compress
  }
  return Invoke-RestMethod @parameters
}

function Wait-AppHealthy {
  for ($attempt = 1; $attempt -le 60; $attempt++) {
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:8080/api/healthz" -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -eq 200 -and ([string]$response.Content -match '"status"\s*:\s*"ok"')) {
        return
      }
    } catch {}
    Start-Sleep -Seconds 2
  }
  throw "The installed app API did not become healthy."
}

function Wait-SettingsPage {
  for ($attempt = 1; $attempt -le 30; $attempt++) {
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:5000/settings" -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -eq 200 -and ([string]$response.Content -match "<html|<!doctype html")) {
        return
      }
    } catch {}
    Start-Sleep -Seconds 2
  }
  throw "The installed Settings page did not become available."
}

function Wait-AppStopped {
  for ($attempt = 1; $attempt -le 45; $attempt++) {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 8080 -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0) { return }
    Start-Sleep -Seconds 1
  }
  throw "The installed app API did not stop within 45 seconds."
}

function Start-Willard {
  if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw "Installed Willard bootstrap is missing: $launcher"
  }
  $script:AppStarted = $true
  Write-TestProgress "launcher: invoking installed bootstrap"
  $output = & $launcher -InstallRoot $installRoot 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw ("Installed Willard did not start:`n" + ($output -join "`n"))
  }
  Write-TestProgress "launcher: bootstrap returned"
  Wait-AppHealthy
  Write-TestProgress "launcher: installed API is healthy"
}

function Stop-Willard {
  if (-not $script:AppStarted -or -not (Test-Path -LiteralPath $launcher -PathType Leaf)) { return }
  Write-TestProgress "launcher: invoking stop"
  $output = & $launcher -InstallRoot $installRoot -Stop 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw ("Installed Willard did not stop:`n" + ($output -join "`n"))
  }
  Wait-AppStopped
  $script:AppStarted = $false
  Write-TestProgress "launcher: services stopped"
}

function New-AuthenticatedSession {
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $login = Invoke-Api "POST" "/auth/login" @{ password = $setupPassword } $session
  Assert-True ($login.ok -eq $true) "Could not sign in to the installed app after restart."
  $status = Invoke-Api "GET" "/auth/status" $null $session
  Assert-True ($status.authenticated -eq $true) "The installed app did not retain an authenticated Settings session."
  return $session
}

function Invoke-ManualBackup($session, $expectedStatus) {
  $result = Invoke-Api "POST" "/settings/backup" $null $session
  Assert-True ($result.status -eq $expectedStatus) `
    ("Manual backup status was '$($result.status)', expected '$expectedStatus': $($result.lastError)")
  return $result
}

function Read-ProtectedBackupPassphrase {
  $credentialFile = Join-Path $dataRoot "backup-protection\automation-credential.dpapi"
  $stored = (Get-Content -LiteralPath $credentialFile -Raw -ErrorAction Stop).Trim()
  if ($stored.StartsWith("dpapi-v2:")) {
    $protectedBytes = [Convert]::FromBase64String($stored.Substring("dpapi-v2:".Length))
    $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
      $protectedBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    return [Text.Encoding]::UTF8.GetString($plainBytes)
  }
  $secureValue = ConvertTo-SecureString $stored
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Write-TestEnvironment($databaseUrl) {
  New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
  @(
    "DATABASE_URL=$databaseUrl",
    "PORT=8080",
    "HOST=127.0.0.1",
    "SESSION_SECRET=nas-settings-disposable-session-secret",
    "WILLARD_LOCAL_SETUP=true"
  ) | Set-Content -LiteralPath $envPath -Encoding ASCII
  $env:DATABASE_URL = $databaseUrl
  $env:PORT = "8080"
  $env:HOST = "127.0.0.1"
  $env:SESSION_SECRET = "nas-settings-disposable-session-secret"
  $env:WILLARD_LOCAL_SETUP = "true"
  $env:WILLARD_SKIP_UPDATE = "1"
  $env:WILLARD_SKIP_BROWSER = "1"
  $env:WILLARD_NO_PAUSE = "1"
  $env:WILLARD_SUPPRESS_STARTUP_DIALOG = "1"
  $env:WILLARD_RECOVERY_EXPORT_PATH = $recoveryExport
  $env:WILLARD_RECOVERY_EXPORT_PASSPHRASE = $exportPassphrase
}

try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  Assert-True ($identity -match "[\\/]$([regex]::Escape($expectedUser))$") `
    "The Settings workflow is not running under its disposable standard Windows user."

  if ($Mode -eq "settings-flow") {
    Assert-True (-not (Test-Path -LiteralPath "Z:\")) "Z: must be disconnected before installing Willard."
    Write-TestEnvironment $settingsDatabaseUrl
    $installLog = Join-Path (Split-Path -Parent $installer) "settings-install.log"
    $installArguments = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /LOG=`"$installLog`" /DIR=`"$installRoot`""
    $install = Start-Process -FilePath $installer -ArgumentList $installArguments -Wait -PassThru -WindowStyle Hidden
    Assert-True ($install.ExitCode -eq 0) "Willard Setup.exe failed before the NAS was connected."
    Write-TestProgress "settings-flow: installer completed with Z: disconnected"
    Assert-True (-not (Test-Path -LiteralPath "Z:\")) "The installer unexpectedly required a connected Z: drive."

    Write-TestProgress "settings-flow: starting installed app for first-run setup"
    Start-Willard
    Assert-True (-not (Test-Path -LiteralPath "Z:\")) "Willard did not start while the NAS was disconnected."
    Wait-SettingsPage
    $status = Invoke-Api "GET" "/auth/status" $null $null
    Assert-True ($status.setup -eq $true) "The first-run account setup was not available before NAS configuration."
    $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    $setup = Invoke-Api "POST" "/auth/setup" @{ password = $setupPassword } $session
    Assert-True ($setup.ok -eq $true) "First-run setup did not complete for the installed app."
    $initialSettings = Invoke-Api "GET" "/settings" $null $session
    Assert-True ([string]::IsNullOrWhiteSpace([string]$initialSettings.nasPath)) `
      "The installed app unexpectedly had a NAS path before Settings configuration."

    $subst = Join-Path $env:SystemRoot "System32\subst.exe"
    & $subst "Z:" $nasBackingRoot
    Assert-True ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath "Z:\")) "Could not map the disposable NAS folder as Z:."
    $script:Mapped = $true
    $nasPath = "Z:\"
    $testResult = Invoke-Api "POST" "/settings/test-nas" @{ path = $nasPath } $session
    Assert-True ($testResult.accessible -eq $true -and $testResult.writable -eq $true) `
      ("Settings did not report the mapped NAS as writable: $($testResult.message)")
    $saved = Invoke-Api "PUT" "/settings" @{ nasPath = $nasPath } $session
    Assert-True ($saved.nasPath -eq $nasPath) "Settings did not save the mapped Z: root."

    Stop-Willard
    Start-Willard
    $session = New-AuthenticatedSession
    $reloadedSettings = Invoke-Api "GET" "/settings" $null $session
    Assert-True ($reloadedSettings.nasPath -eq $nasPath) "Settings did not persist Z: after an app restart."

    $backupSettings = Invoke-Api "PUT" "/settings/backup" @{ enabled = $true; scheduleHours = 24 } $session
    Assert-True ($backupSettings.enabled -eq $true) "The NAS backup schedule could not be enabled."
    $backupRoot = Join-Path $nasPath "WillardAI\backups"
    Write-TestProgress "settings-flow: creating protected backup on Z:"
    $firstBackup = Invoke-ManualBackup $session "PROTECTED"
    Write-TestProgress "settings-flow: protected backup created"
    $firstGenerations = @(Get-ChildItem -LiteralPath $backupRoot -Directory -Filter "backup-*")
    Assert-True ($firstGenerations.Count -gt 0) "No backup was written beneath the NAS path saved in Settings."
    Assert-True (Test-Path -LiteralPath (Join-Path $firstGenerations[-1].FullName "manifest.json")) `
      "The Settings-driven NAS backup is missing its manifest."

    & $subst "Z:" "/d"
    Assert-True ($LASTEXITCODE -eq 0) "Could not disconnect the disposable Z: mapping."
    $script:Mapped = $false
    Assert-True (-not (Test-Path -LiteralPath "Z:\")) "Z: remained visible after the simulated NAS disconnect."
    $offlineTest = Invoke-Api "POST" "/settings/test-nas" @{ path = $nasPath } $session
    Assert-True ($offlineTest.accessible -eq $false) "Settings still reported the disconnected Z: drive as accessible."
    $offlineSettings = Invoke-Api "GET" "/settings" $null $session
    Assert-True ($offlineSettings.nasPath -eq $nasPath) "Disconnecting Z: changed the saved Settings path."
    $pending = Invoke-ManualBackup $session "PENDING"
    Assert-True ($pending.status -eq "PENDING") "An offline NAS backup was not safely left pending."
    Assert-True (-not (Test-Path -LiteralPath "Z:\")) "A local Z: directory appeared while the NAS mapping was disconnected."

    & $subst "Z:" $nasBackingRoot
    Assert-True ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath "Z:\")) "Could not reconnect the disposable NAS as Z:."
    $script:Mapped = $true
    $reconnectedTest = Invoke-Api "POST" "/settings/test-nas" @{ path = $nasPath } $session
    Assert-True ($reconnectedTest.accessible -eq $true -and $reconnectedTest.writable -eq $true) `
      "Settings did not recover access after Z: was reconnected."
    Write-TestProgress "settings-flow: creating protected backup after Z: reconnect"
    $recovered = Invoke-ManualBackup $session "PROTECTED"
    Write-TestProgress "settings-flow: reconnect backup completed"
    $latestSettings = Invoke-Api "GET" "/settings" $null $session
    Assert-True ($latestSettings.nasPath -eq $nasPath) "Reconnect changed the saved NAS path."
    $latestStatus = Invoke-Api "GET" "/settings/backup" $null $session
    Assert-True ($latestStatus.status -eq "PROTECTED") "Backup protection did not recover after reconnect."
    Assert-True (Test-Path -LiteralPath $backupRoot) "The configured NAS backup folder disappeared after reconnect."
    Assert-True (Test-Path -LiteralPath $recoveryExport -PathType Leaf) "The installed launcher did not create its portable recovery export."
    Assert-True ((Get-Content -LiteralPath $recoveryExport -Raw) -notmatch [regex]::Escape($exportPassphrase)) `
      "The portable recovery export contains its test passphrase."
    $latestSettings.nasPath | Set-Content -LiteralPath $savedPathFile -Encoding ASCII
    Write-Host "Settings persisted Z: across restart; backup completed, became pending offline, and recovered after reconnect."
  }
  elseif ($Mode -eq "settings-restore") {
    $savedNasPath = (Get-Content -LiteralPath $savedPathFile -Raw).Trim()
    Assert-True ($savedNasPath -eq "Z:\") "Restore did not receive the NAS path read back from Settings."
    $subst = Join-Path $env:SystemRoot "System32\subst.exe"
    Assert-True (-not (Test-Path -LiteralPath "Z:\")) "Z: must be unmapped before the restore test maps it."
    & $subst "Z:" $nasBackingRoot
    Assert-True ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath "Z:\")) "Could not map the configured NAS root for restore."
    $script:Mapped = $true

    Write-TestEnvironment $settingsDatabaseUrl
    Start-Willard
    Stop-Willard
    $env:WILLARD_BACKUP_PASSPHRASE = Read-ProtectedBackupPassphrase
    $env:WILLARD_RESTORE_DATABASE_URL = $restoreDatabaseUrl
    $backupRoot = Join-Path $savedNasPath "WillardAI\backups"
    $generations = @(Get-ChildItem -LiteralPath $backupRoot -Directory -Filter "backup-*" | Sort-Object LastWriteTime -Descending)
    Assert-True ($generations.Count -gt 0) "Restore could not find a backup beneath the saved Settings NAS path."
    $backupDirectory = $generations[0].FullName
    $manifest = Get-Content -LiteralPath (Join-Path $backupDirectory "manifest.json") -Raw | ConvertFrom-Json
    $restoreOutput = & $node $backupScript "restore" `
      "--backup-dir" $backupDirectory `
      "--library-root" $savedNasPath `
      "--confirm-library-id" $manifest.library.libraryId `
      "--recovery-export" $recoveryExport 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw ("Restore from the configured NAS path failed:`n" + ($restoreOutput -join "`n"))
    }
    Assert-True (([string]$restoreOutput -match "restored and verified")) `
      ("Restore did not report verification:`n" + ($restoreOutput -join "`n"))

    Write-TestEnvironment $restoreDatabaseUrl
    Start-Willard
    $session = New-AuthenticatedSession
    $restoredSettings = Invoke-Api "GET" "/settings" $null $session
    Assert-True ($restoredSettings.nasPath -eq $savedNasPath) `
      "The restored Settings path does not match the Z: path selected before recovery."
    Write-Host "Restore used the backup under the Settings-configured Z: root and retained that setting."
  }
  elseif ($Mode -eq "cleanup") {
    if (Test-Path -LiteralPath $launcher -PathType Leaf) {
      try { & $launcher -InstallRoot $installRoot -Stop 2>&1 | Out-Null } catch {}
    }
    $uninstaller = Join-Path $installRoot "unins000.exe"
    if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
      $uninstall = Start-Process -FilePath $uninstaller `
        -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART" -Wait -PassThru -WindowStyle Hidden
      if ($uninstall.ExitCode -ne 0) { throw "The disposable Settings-flow install could not be uninstalled." }
    }
    Remove-Item -LiteralPath $envPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $dataRoot "backup-protection") -Recurse -Force -ErrorAction SilentlyContinue
  }
}
finally {
  if ($script:AppStarted) {
    try { Stop-Willard } catch { Write-Host ("App cleanup warning: " + $_.Exception.Message) }
  }
  if ($script:Mapped) {
    $subst = Join-Path $env:SystemRoot "System32\subst.exe"
    try { & $subst "Z:" "/d" 2>&1 | Out-Null } catch {}
  }
}
'@

  foreach ($replacement in @(
    @{ Token = "__INSTALLER__"; Value = $installerLiteral },
    @{ Token = "__INSTALL_ROOT__"; Value = $installRootLiteral },
    @{ Token = "__NAS_ROOT__"; Value = $nasRootLiteral },
    @{ Token = "__RECOVERY_EXPORT__"; Value = $recoveryExportLiteral },
    @{ Token = "__SAVED_PATH_FILE__"; Value = $savedPathFileLiteral },
    @{ Token = "__SETTINGS_DATABASE_URL__"; Value = $settingsDatabaseUrlLiteral },
    @{ Token = "__RESTORE_DATABASE_URL__"; Value = $restoreDatabaseUrlLiteral },
    @{ Token = "__NODE__"; Value = $nodeLiteral },
    @{ Token = "__BACKUP_SCRIPT__"; Value = $backupScriptLiteral },
    @{ Token = "__PSQL__"; Value = $psqlLiteral },
    @{ Token = "__PGDUMP__"; Value = $pgDumpLiteral },
    @{ Token = "__PGRESTORE__"; Value = $pgRestoreLiteral },
    @{ Token = "__EXPORT_PASSPHRASE__"; Value = $exportPassphraseLiteral },
    @{ Token = "__SETUP_PASSWORD__"; Value = $setupPasswordLiteral },
    @{ Token = "__USERNAME__"; Value = $usernameLiteral }
  )) {
    $runnerContents = $runnerContents.Replace($replacement.Token, $replacement.Value)
  }
  $runnerContents | Set-Content -LiteralPath $Runner -Encoding ASCII

  Write-Host "NAS Settings flow: install with Z: disconnected, then launch as the standard user."
  $flow = Invoke-AsNasTestUser "settings-flow" "nas-settings-flow"
  Assert-True ($flow.exitCode -eq 0) ("Settings-driven NAS backup flow failed:`n" + $flow.output)
  Assert-True ((Get-Content -LiteralPath $SavedNasPathFile -Raw).Trim() -eq "Z:\") `
    "The test did not save the NAS path returned by Settings."

  Write-Host "NAS Settings recovery: restore from the saved NAS path."
  $restore = Invoke-AsNasTestUser "settings-restore" "nas-settings-restore"
  Assert-True ($restore.exitCode -eq 0) ("Settings-driven NAS restore failed:`n" + $restore.output)
  $restoredPath = Invoke-Psql $RestoreDatabase "SELECT nas_path FROM app_settings WHERE id = 1"
  Assert-True ($restoredPath -eq "Z:\") "The restore database did not retain the NAS path configured through Settings."

  $script:SmokePassed = $true
  Write-Host "Settings-driven mapped-Z recovery smoke passed."
} finally {
  if ($script:UserCreated -and (Test-Path -LiteralPath $Runner)) {
    try { Invoke-AsNasTestUser "cleanup" "nas-settings-cleanup" 180 | Out-Null } catch {}
  }
  if (Test-Path -LiteralPath $Dropdb) {
    try { & $Dropdb -h 127.0.0.1 -U postgres --if-exists $SettingsDatabase | Out-Null } catch {}
    try { & $Dropdb -h 127.0.0.1 -U postgres --if-exists $RestoreDatabase | Out-Null } catch {}
  }
  if ($script:UserCreated) {
    try { Remove-LocalUser -Name $UserName -ErrorAction SilentlyContinue } catch {}
  }
  if ($script:SmokePassed) {
    Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    Write-Host "NAS Settings smoke diagnostics were preserved at $TempRoot" -ForegroundColor Yellow
    if (Test-Path -LiteralPath $TempRoot) {
      Get-ChildItem -LiteralPath $TempRoot -Recurse -File -Filter "*.log" -ErrorAction SilentlyContinue |
        ForEach-Object {
          Write-Host "NAS Settings log: $($_.FullName)"
          Get-Content -LiteralPath $_.FullName -Tail 120 -ErrorAction SilentlyContinue
        }
    }
  }
  if ($script:PGPasswordWasSet) {
    if ($null -eq $script:PreviousPGPassword) {
      Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    } else {
      $env:PGPASSWORD = $script:PreviousPGPassword
    }
  }
}
