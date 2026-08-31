# End-to-end replacement-computer recovery smoke for a disposable Windows runner.
# The recovery user only invokes the staged release payload. It never uses the
# source checkout, package manager, or developer launcher.
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ReleaseRoot = Join-Path $Root "build\windows"
$PostgresBin = Join-Path $env:RUNNER_TEMP "postgresql\pgsql\bin"
$Psql = Join-Path $PostgresBin "psql.exe"
$Createdb = Join-Path $PostgresBin "createdb.exe"
$Dropdb = Join-Path $PostgresBin "dropdb.exe"
$TempRoot = Join-Path $env:RUNNER_TEMP "willard-replacement-recovery-$([guid]::NewGuid().ToString())"
$UserName = "wl_recover_$([guid]::NewGuid().ToString("N").Substring(0, 8))"
$Password = ConvertTo-SecureString "WillardRecovery!1" -AsPlainText -Force
$Credential = [pscredential]::new(".\$UserName", $Password)
$SourceDatabase = "willard_recovery_source_$([guid]::NewGuid().ToString("N").Substring(0, 8))"
$TargetDatabase = "willard_recovery_target_$([guid]::NewGuid().ToString("N").Substring(0, 8))"
$SourceRoot = Join-Path $TempRoot "source-nas"
$AttachedRoot = Join-Path $TempRoot "replacement-nas"
$MissingRoot = Join-Path $TempRoot "missing-nas"
$BackupRoot = Join-Path $SourceRoot "WillardAI\backups"
$RecoveryExport = Join-Path $TempRoot "Willard-Library-Recovery.willard-recovery.json"
$PartialBackup = Join-Path $TempRoot "partial-backup"
$Runner = Join-Path $TempRoot "run-replacement-recovery.ps1"
$ReplacementInstallRoot = Join-Path $TempRoot "replacement-install"
$script:RecoveryPassed = $false
$script:RecoveryProcessTimeoutSeconds = 180

function Assert-True($condition, $message) {
  if (-not $condition) { throw $message }
}


function Read-Text($path) {
  if (Test-Path $path) { return Get-Content $path -Raw }
  return ""
}

function Invoke-Psql($database, $sql) {
  $output = & $Psql -h 127.0.0.1 -U postgres -d $database -Atc $sql 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "PostgreSQL query failed for $database`: $($output -join "`n")"
  }
  return ([string]$output).Trim()
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


function Invoke-AsRecoveryUser($mode, $label) {
  $stdout = Join-Path $TempRoot "$label.out.log"
  $stderr = Join-Path $TempRoot "$label.err.log"
  $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Runner`" -Mode $mode"
  $process = Start-Process -FilePath $powershell -ArgumentList $arguments `
    -Credential $Credential -LoadUserProfile -WorkingDirectory $TempRoot `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  if (-not $process.WaitForExit($script:RecoveryProcessTimeoutSeconds * 1000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "$label timed out after $script:RecoveryProcessTimeoutSeconds seconds."
  }
  $process.Refresh()
  return @{
    exitCode = $process.ExitCode
    output = (Read-Text $stdout) + (Read-Text $stderr)
  }
}

function Assert-TargetEmpty($label) {
  $tables = Invoke-Psql $TargetDatabase "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')"
  Assert-True ($tables -eq "0") "$label changed the clean replacement database."
}

try {
  Assert-True ($env:OS -eq "Windows_NT" -or $IsWindows) "This replacement recovery smoke must run on Windows."
  foreach ($entry in @(
    (Join-Path $ReleaseRoot "runtime\node.exe"),
    (Join-Path $ReleaseRoot "api-runtime\setup-db.cjs"),
    (Join-Path $ReleaseRoot "desktop\database-backup.mjs"),
    (Join-Path $ReleaseRoot "desktop\backup-credentials.mjs"),
    (Join-Path $ReleaseRoot "desktop\library-recovery.mjs"),
    (Join-Path $ReleaseRoot "desktop\WillardMediaCenter.ps1")
  )) {
    Assert-True (Test-Path $entry) "The staged release is missing $entry."
  }
  Assert-True (Test-Path $Psql) "PostgreSQL 16 client tools are missing."

  New-Item -ItemType Directory -Force -Path $TempRoot, $SourceRoot, $AttachedRoot | Out-Null
  $sourceMedia = Join-Path $SourceRoot "photos\replacement-family.jpg"
  $attachedMedia = Join-Path $AttachedRoot "photos\replacement-family.jpg"
  New-Item -ItemType Directory -Force (Split-Path -Parent $sourceMedia), (Split-Path -Parent $attachedMedia) | Out-Null
  Set-Content $sourceMedia "replacement laptop media that must survive" -Encoding UTF8

  $env:PGPASSWORD = "postgres"
  & $Createdb -h 127.0.0.1 -U postgres $SourceDatabase
  if ($LASTEXITCODE -ne 0) { throw "Could not create source recovery database." }
  & $Createdb -h 127.0.0.1 -U postgres $TargetDatabase
  if ($LASTEXITCODE -ne 0) { throw "Could not create clean replacement database." }

  $releaseNode = Join-Path $ReleaseRoot "runtime\node.exe"
  $releaseSetup = Join-Path $ReleaseRoot "api-runtime\setup-db.cjs"
  $sourceUrl = "postgresql://postgres:postgres@127.0.0.1:5432/$SourceDatabase"
  $targetUrl = "postgresql://postgres:postgres@127.0.0.1:5432/$TargetDatabase"
  Invoke-PackagedNode $releaseNode @($releaseSetup) @{ DATABASE_URL = $sourceUrl } | Out-Null

  $sourceRootSql = "'" + $SourceRoot.Replace("'", "''") + "'"
  $sourceRelativeSql = "'photos/replacement-family.jpg'"
  $sha = (Get-FileHash $sourceMedia -Algorithm SHA256).Hash.ToLowerInvariant()
  $seed = @"
INSERT INTO app_settings (nas_path, photos_destination)
VALUES ($sourceRootSql, $sourceRootSql);
UPDATE app_settings
SET nas_path = $sourceRootSql,
    photos_destination = $sourceRootSql
WHERE id = 1;
INSERT INTO media_files (nas_path, relative_path, name, media_type, size_bytes, content_hash)
VALUES ($sourceRootSql, $sourceRelativeSql, 'replacement-family.jpg', 'photo', 42, '$sha');
"@
  Invoke-Psql $SourceDatabase $seed | Out-Null

  $backupSecret = "replacement-laptop-backup-secret"
  $exportPassphrase = "replacement-laptop-export-passphrase"
  Invoke-PackagedNode $releaseNode @(
    (Join-Path $ReleaseRoot "desktop\database-backup.mjs"),
    "backup", "--output-dir", $BackupRoot, "--keep", "1"
  ) @{
    DATABASE_URL = $sourceUrl
    WILLARD_BACKUP_PASSPHRASE = $backupSecret
  }
  $backupDirectory = @(Get-ChildItem $BackupRoot -Directory -Filter "backup-*")[0].FullName
  Assert-True $backupDirectory "The packaged backup command did not create a generation."

  Invoke-PackagedNode $releaseNode @(
    (Join-Path $ReleaseRoot "desktop\database-backup.mjs"),
    "export-recovery", "--output", $RecoveryExport
  ) @{
    WILLARD_BACKUP_PASSPHRASE = $backupSecret
    WILLARD_RECOVERY_EXPORT_PASSPHRASE = $exportPassphrase
  } | Out-Null
  Assert-True (Test-Path $RecoveryExport) "The portable recovery export was not created."
  Assert-True ((Read-Text $RecoveryExport) -notmatch [regex]::Escape($backupSecret)) `
    "The portable recovery export contains the backup secret."

  $manifest = Get-Content (Join-Path $backupDirectory "manifest.json") -Raw | ConvertFrom-Json
  $libraryId = $manifest.library.libraryId
  New-Item -ItemType Directory -Force (Join-Path $AttachedRoot "WillardAI\config") | Out-Null
  Copy-Item (Join-Path $SourceRoot "WillardAI\config\library-identity.json") `
    (Join-Path $AttachedRoot "WillardAI\config\library-identity.json") -Force
  Copy-Item $sourceMedia $attachedMedia -Force
  New-Item -ItemType Directory -Force $PartialBackup | Out-Null
  Copy-Item (Join-Path $backupDirectory "*") $PartialBackup -Recurse -Force
  $partialPath = Join-Path $PartialBackup "database.dump.enc"
  $partialBytes = [IO.File]::ReadAllBytes($partialPath)
  Assert-True ($partialBytes.Length -gt 32) "The test backup dump was unexpectedly small."
  [Array]::Resize([ref]$partialBytes, [int]([Math]::Floor($partialBytes.Length / 2)))
  [IO.File]::WriteAllBytes($partialPath, $partialBytes)

  $replacementNode = Join-Path $ReplacementInstallRoot "runtime\node.exe"
  $replacementBackup = Join-Path $ReplacementInstallRoot "desktop\database-backup.mjs"
  $replacementLauncher = Join-Path $ReplacementInstallRoot "desktop\WillardMediaCenter.ps1"
  New-Item -ItemType Directory -Force $ReplacementInstallRoot | Out-Null
  Copy-Item (Join-Path $ReleaseRoot "*") $ReplacementInstallRoot -Recurse -Force
  $userRule = "$env:COMPUTERNAME\${UserName}:(OI)(CI)F"
  New-LocalUser -Name $UserName -Password $Password -AccountNeverExpires -PasswordNeverExpires | Out-Null
  $aclOutput = & icacls $TempRoot /grant $userRule /T /C 2>&1
  Assert-True ($LASTEXITCODE -eq 0) ("Could not grant the replacement user access to its recovery media:`n" + ($aclOutput -join "`n"))

  $recoveryExportLiteral = $RecoveryExport.Replace("'", "''")
  $backupDirectoryLiteral = $backupDirectory.Replace("'", "''")
  $partialBackupLiteral = $PartialBackup.Replace("'", "''")
  $attachedRootLiteral = $AttachedRoot.Replace("'", "''")
  $missingRootLiteral = $MissingRoot.Replace("'", "''")
  $targetUrlLiteral = $targetUrl.Replace("'", "''")
  $libraryIdLiteral = $libraryId.Replace("'", "''")
  $runnerContents = @'
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("wrong-passphrase", "missing-nas", "partial-backup", "restore", "activate", "stop")]
  [string]$Mode
)
$env:PGPASSWORD = "postgres"
$env:WILLARD_SKIP_UPDATE = "1"
$node = "__NODE__"
$backupScript = "__BACKUP_SCRIPT__"
$launcher = "__LAUNCHER__"
$export = "__RECOVERY_EXPORT__"
$targetUrl = "__TARGET_URL__"
$backup = "__BACKUP_DIR__"
if ($Mode -eq "partial-backup") { $backup = "__PARTIAL_BACKUP__" }
$nas = "__ATTACHED_ROOT__"
if ($Mode -eq "missing-nas") { $nas = "__MISSING_ROOT__" }
$common = @(
  $backupScript, "restore", "--backup-dir", $backup,
  "--library-root", $nas, "--confirm-library-id", "__LIBRARY_ID__",
  "--recovery-export", $export
)
if ($Mode -eq "wrong-passphrase") {
  $env:WILLARD_RECOVERY_EXPORT_PASSPHRASE = "wrong-replacement-passphrase"
  & $node @common
  exit $LASTEXITCODE
}
if ($Mode -eq "restore") {
  $env:WILLARD_RESTORE_DATABASE_URL = $targetUrl
  $env:WILLARD_RECOVERY_EXPORT_PASSPHRASE = "replacement-laptop-export-passphrase"
  & $node @common
  exit $LASTEXITCODE
}
if ($Mode -eq "activate") {
  $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  $dataRoot = Join-Path $localAppData "Willard Media Center"
  New-Item -ItemType Directory -Force $dataRoot | Out-Null
  @(
    "DATABASE_URL=__TARGET_URL__",
    "PORT=8080",
    "SESSION_SECRET=replacement-recovery-session-secret"
  ) | Set-Content (Join-Path $dataRoot ".env") -Encoding ASCII
  $env:WILLARD_RECOVERY_EXPORT_PATH = $export
  $env:WILLARD_RECOVERY_EXPORT_PASSPHRASE = "replacement-laptop-export-passphrase"
  & $launcher
  exit $LASTEXITCODE
}
if ($Mode -eq "stop") {
  & $launcher -Stop
  exit $LASTEXITCODE
}
& $node @common
exit $LASTEXITCODE
'@
  $runnerContents = $runnerContents.Replace("__NODE__", $replacementNode.Replace("'", "''"))
  $runnerContents = $runnerContents.Replace("__BACKUP_SCRIPT__", $replacementBackup.Replace("'", "''"))
  $runnerContents = $runnerContents.Replace("__LAUNCHER__", $replacementLauncher.Replace("'", "''"))
  $runnerContents = $runnerContents.Replace("__RECOVERY_EXPORT__", $recoveryExportLiteral)
  $runnerContents = $runnerContents.Replace("__TARGET_URL__", $targetUrlLiteral)
  $runnerContents = $runnerContents.Replace("__BACKUP_DIR__", $backupDirectoryLiteral)
  $runnerContents = $runnerContents.Replace("__PARTIAL_BACKUP__", $partialBackupLiteral)
  $runnerContents = $runnerContents.Replace("__ATTACHED_ROOT__", $attachedRootLiteral)
  $runnerContents = $runnerContents.Replace("__MISSING_ROOT__", $missingRootLiteral)
  $runnerContents = $runnerContents.Replace("__LIBRARY_ID__", $libraryIdLiteral)
  $runnerContents | Set-Content $Runner -Encoding ASCII

  Write-Host "Replacement recovery: wrong portable passphrase"
  $wrong = Invoke-AsRecoveryUser "wrong-passphrase" "wrong-passphrase"
  Assert-True ($wrong.exitCode -ne 0) "A wrong portable recovery passphrase unexpectedly succeeded."
  Assert-True ($wrong.output -match "passphrase|authenticated") `
    ("Wrong-passphrase diagnostics were not actionable:`n" + $wrong.output)
  Assert-TargetEmpty "Wrong-passphrase recovery"

  Write-Host "Replacement recovery: missing NAS root"
  $missing = Invoke-AsRecoveryUser "missing-nas" "missing-nas"
  Assert-True ($missing.exitCode -ne 0) "Recovery unexpectedly accepted a missing NAS root."
  Assert-True ($missing.output -match "missing|invalid|NAS") `
    ("Missing-NAS diagnostics were not actionable:`n" + $missing.output)
  Assert-TargetEmpty "Missing-NAS recovery"

  Write-Host "Replacement recovery: partial backup artifact"
  $partial = Invoke-AsRecoveryUser "partial-backup" "partial-backup"
  Assert-True ($partial.exitCode -ne 0) "Recovery unexpectedly accepted a truncated backup."
  Assert-True ($partial.output -match "size|integrity|manifest|backup") `
    ("Partial-backup diagnostics were not actionable:`n" + $partial.output)
  Assert-TargetEmpty "Partial-backup recovery"

  Write-Host "Replacement recovery: portable import and NAS verification"
  $restore = Invoke-AsRecoveryUser "restore" "restore"
  Assert-True ($restore.exitCode -eq 0) ("Portable recovery failed:`n" + $restore.output)
  Assert-True ($restore.output -match "restored and verified") "Recovery did not report verification before activation."

  $attachedPath = Invoke-Psql $TargetDatabase "SELECT nas_path FROM app_settings WHERE id = 1"
  Assert-True ($attachedPath -eq $AttachedRoot) "Restored settings did not remap to the attached NAS root."
  $catalog = Invoke-Psql $TargetDatabase "SELECT relative_path || ':' || lower(content_hash) FROM media_files"
  Assert-True ($catalog -eq "photos/replacement-family.jpg:$sha") "Restored catalog inventory did not match the NAS media."
  $journalPath = Join-Path $AttachedRoot "WillardAI\config\recovery-attempts\$($manifest.integrity.encryptedSha256).json"
  Assert-True (Test-Path $journalPath) "Recovery did not leave a durable completion journal."
  $journal = Get-Content $journalPath -Raw | ConvertFrom-Json
  Assert-True ($journal.state -eq "COMPLETE") "Recovery was not marked complete after catalog and NAS verification."

  Write-Host "Replacement recovery: activate packaged library"
  $activate = Invoke-AsRecoveryUser "activate" "activate"
  Assert-True ($activate.exitCode -eq 0) ("Packaged activation failed after recovery:`n" + $activate.output)
  $ready = $false
  for ($attempt = 1; $attempt -le 45; $attempt++) {
    try {
      $health = Invoke-WebRequest -Uri "http://127.0.0.1:8080/api/healthz" -UseBasicParsing -TimeoutSec 3
      if ($health.StatusCode -eq 200 -and ([string]$health.Content -match '"status"\s*:\s*"ok"')) {
        $ready = $true
        break
      }
    } catch {}
    Start-Sleep -Seconds 2
  }
  Assert-True $ready "The packaged app did not become healthy after the verified replacement restore."
  $stop = Invoke-AsRecoveryUser "stop" "stop"
  Assert-True ($stop.exitCode -eq 0) ("Packaged activation could not be stopped:`n" + $stop.output)
  $script:RecoveryPassed = $true
  Write-Host "Replacement recovery smoke passed: portable import, safe failures, NAS verification, and activation."
} finally {
  try {
    if (Test-Path $Runner) { Invoke-AsRecoveryUser "stop" "cleanup-stop" | Out-Null }
  } catch {}
  if (Test-Path $Dropdb) {
    try { & $Dropdb -h 127.0.0.1 -U postgres --if-exists $SourceDatabase | Out-Null } catch {}
    try { & $Dropdb -h 127.0.0.1 -U postgres --if-exists $TargetDatabase | Out-Null } catch {}
  }
  try { Remove-LocalUser -Name $UserName -ErrorAction SilentlyContinue } catch {}
  if ($script:RecoveryPassed) {
    Remove-Item $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    Write-Host "Replacement recovery diagnostics were preserved at $TempRoot" -ForegroundColor Yellow
    if (Test-Path $TempRoot) {
      Get-ChildItem $TempRoot -Recurse -File -ErrorAction SilentlyContinue |
        ForEach-Object {
          Write-Host "Recovery file: $($_.FullName)"
          if ($_.Extension -eq ".log") {
            Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue
          }
        }
    }
  }
}