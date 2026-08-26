# Installed Willard Media Center lifecycle launcher.
# The installer places this file beside runtime\node.exe and the packaged app.
$ErrorActionPreference = "Stop"
$InstallRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$DataRoot = Join-Path $env:LOCALAPPDATA "Willard Media Center"
$LogRoot = Join-Path $DataRoot "logs"
$PidFile = Join-Path $DataRoot "services.json"
$SchemaMarker = Join-Path $DataRoot "schema-ready.json"
$UpdateCheckFile = Join-Path $DataRoot "last-update-check.txt"
$EnvFile = Join-Path $DataRoot ".env"
$VersionFile = Join-Path $InstallRoot "version.json"
$Node = Join-Path $InstallRoot "runtime\node.exe"
$Api = Join-Path $InstallRoot "api-runtime\dist\index.mjs"
$SetupDb = Join-Path $InstallRoot "api-runtime\setup-db.cjs"
$Web = Join-Path $InstallRoot "web"
$WebServer = Join-Path $InstallRoot "desktop\desktop-web-server.mjs"
$LoadingScreen = Join-Path $InstallRoot "desktop\loading.html"
$ReleaseContract = Join-Path $InstallRoot "desktop\release-contract.mjs"
$ApiUrl = "http://127.0.0.1:8080/api/healthz"
$WebUrl = "http://127.0.0.1:5000"
$UpdateManifest = "https://github.com/christopherlwillard-debug/willard-ai/releases/latest/download/release-manifest.json"
$script:WillardRunToken = [guid]::NewGuid().ToString()
$script:UpdateBackup = $null
$script:UpdateCandidate = $null
$UpdateJournal = Join-Path $DataRoot "updates\swap-journal.json"
$script:UpdateStage = "startup"
$script:LoadingProcess = $null

function Say($message) { Write-Host "  $message" -ForegroundColor Gray }
function Good($message) { Write-Host "  [OK] $message" -ForegroundColor Green }
function Warn($message) { Write-Host "  [!]  $message" -ForegroundColor Yellow }
function Fail($message) { Write-Host "  [X]  $message" -ForegroundColor Red }
function Ensure-Folders { New-Item -ItemType Directory -Force -Path $DataRoot, $LogRoot | Out-Null }
function Start-LoadingScreen {
  if (-not (Test-Path $LoadingScreen)) { return }
  try {
    $script:LoadingProcess = Start-Process -FilePath $LoadingScreen -PassThru -ErrorAction Stop
  } catch {
    Warn "The startup window could not be opened. Willard will continue in this launcher window."
  }
}
function Close-LoadingScreen {
  if (-not $script:LoadingProcess) { return }
  try {
    if (-not $script:LoadingProcess.HasExited) {
      [void]$script:LoadingProcess.CloseMainWindow()
      if (-not $script:LoadingProcess.WaitForExit(2000)) {
        Stop-Process -Id $script:LoadingProcess.Id -Force -ErrorAction SilentlyContinue
      }
    }
  } catch {}
  $script:LoadingProcess = $null
}
function Report-StartupFailure($message) {
  $failureLog = Join-Path $LogRoot "startup-failure.log"
  $details = @(
    "Willard Media Center could not start.",
    "Time: $((Get-Date).ToString("o"))",
    "Reason: $message",
    "Logs: $LogRoot",
    "Next: Check database.log, api-error.log, and web-error.log; then launch Willard again."
  )
  try { $details | Set-Content $failureLog -Encoding UTF8 } catch {}
  Fail $message
  Write-Host "  Diagnostics: $failureLog" -ForegroundColor DarkGray
  try {
    Add-Type -AssemblyName PresentationFramework -ErrorAction Stop
    [void][System.Windows.MessageBox]::Show(
      ($details -join [Environment]::NewLine),
      "Willard Media Center",
      [System.Windows.MessageBoxButton]::OK,
      [System.Windows.MessageBoxImage]::Error
    )
  } catch {}
}
function Read-Version {
  if (-not (Test-Path $VersionFile)) { return "0.0.0" }
  try { return ((Get-Content $VersionFile -Raw | ConvertFrom-Json).version) } catch { return "0.0.0" }
}
function Read-Pids {
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
  } catch { return $null }
}
function Test-ProcessIdentity($tracked) {
  if (-not $tracked) { return $false }
  $current = Get-ProcessIdentity $tracked.pid
  if (-not $current -or -not $tracked.path -or -not $tracked.commandLine) { return $false }
  return ($current.path -eq $tracked.path -and $current.commandLine -eq $tracked.commandLine -and
    (-not $tracked.creationDate -or $current.creationDate -eq $tracked.creationDate))
}
function Is-Alive($process) {
  if ($process -is [psobject] -and $process.pid) { return (Test-ProcessIdentity $process) }
  return $false
}
function Stop-Services {
  $pids = Read-Pids
  foreach ($process in @($pids.api, $pids.web)) {
    if (Test-ProcessIdentity $process) { & taskkill /PID $process.pid /T /F 2>&1 | Out-Null }
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}
function Save-Services($apiPid, $webPid) {
  $api = Get-ProcessIdentity $apiPid
  $web = Get-ProcessIdentity $webPid
  @{ version = 2; runToken = $script:WillardRunToken; api = $api; web = $web; startedAt = (Get-Date).ToString("o") } |
    ConvertTo-Json | Set-Content $PidFile
}
function Write-UpdateJournal($phase, $candidate, $backup) {
  New-Item -ItemType Directory -Force (Split-Path $UpdateJournal) | Out-Null
  @{
    version = 1
    phase = $phase
    installRoot = $InstallRoot
    candidate = $candidate
    backup = $backup
    updatedAt = (Get-Date).ToString("o")
  } | ConvertTo-Json | Set-Content $UpdateJournal -Encoding UTF8
}
function Read-UpdateJournal {
  if (-not (Test-Path $UpdateJournal)) { return $null }
  try { return Get-Content $UpdateJournal -Raw | ConvertFrom-Json } catch { return $null }
}
function Remove-UpdateJournal { Remove-Item $UpdateJournal -Force -ErrorAction SilentlyContinue }
function Test-PackagedUpdateFault($point) {
  if ($env:WILLARD_PACKAGED_UPDATE_FAIL_AT -eq $point) {
    throw "Injected packaged update failure at $point."
  }
}
function Restore-UpdateBackup {
  $journal = Read-UpdateJournal
  $backup = if ($script:UpdateBackup) { $script:UpdateBackup } elseif ($journal) { $journal.backup } else { $null }
  if (-not $backup -or -not (Test-Path $backup)) { return $false }

  $failed = $InstallRoot + ".failed-" + [guid]::NewGuid().ToString()
  $parent = Split-Path -Parent $InstallRoot
  Push-Location $parent
  try {
    if (Test-Path $InstallRoot) { Move-Item -LiteralPath $InstallRoot -Destination $failed -ErrorAction Stop }
    Move-Item -LiteralPath $backup -Destination $InstallRoot -ErrorAction Stop
    Remove-Item $failed -Recurse -Force -ErrorAction SilentlyContinue
    Remove-UpdateJournal
    $script:UpdateBackup = $null
    $script:UpdateCandidate = $null
    Warn "The previous working release was restored."
    return $true
  } catch {
    if (-not (Test-Path $InstallRoot) -and (Test-Path $failed)) {
      Move-Item -LiteralPath $failed -Destination $InstallRoot -ErrorAction SilentlyContinue
    }
    throw
  } finally {
    Pop-Location
  }
}
function Recover-InterruptedUpdateSwap {
  $journal = Read-UpdateJournal
  if (-not $journal) { return }
  if ($journal.phase -in @("backup-created", "swapped")) {
    $script:UpdateBackup = $journal.backup
    Restore-UpdateBackup | Out-Null
    if ($journal.candidate -and (Test-Path $journal.candidate)) {
      Remove-Item $journal.candidate -Recurse -Force -ErrorAction SilentlyContinue
    }
    return
  }
  if ($journal.candidate -and (Test-Path $journal.candidate)) {
    Remove-Item $journal.candidate -Recurse -Force -ErrorAction SilentlyContinue
  }
  Remove-UpdateJournal
}
function Invoke-PackagedVersionSwap($candidate, $backup) {
  if (-not (Test-Path $candidate)) { throw "The verified release candidate is missing." }
  if (Test-Path $backup) { throw "A previous release backup is still present: $backup" }

  $parent = Split-Path -Parent $InstallRoot
  Write-UpdateJournal "prepared" $candidate $backup
  Push-Location $parent
  try {
    Move-Item -LiteralPath $InstallRoot -Destination $backup -ErrorAction Stop
    Write-UpdateJournal "backup-created" $candidate $backup
    Test-PackagedUpdateFault "swap-after-backup"
    Move-Item -LiteralPath $candidate -Destination $InstallRoot -ErrorAction Stop
    Write-UpdateJournal "swapped" $candidate $backup
    $script:UpdateBackup = $backup
    $script:UpdateCandidate = $candidate
  } catch {
    Restore-UpdateBackup | Out-Null
    throw
  } finally {
    Pop-Location
  }
}
function Get-SchemaFingerprint {
  $parts = @()
  foreach ($path in @($SetupDb, $VersionFile)) {
    if (Test-Path $path) { $parts += (Get-FileHash $path -Algorithm SHA256).Hash }
  }
  return ($parts -join ":")
}
function Ensure-Schema {
  $fingerprint = Get-SchemaFingerprint
  if ($fingerprint -and (Test-Path $SchemaMarker)) {
    try {
      $marker = Get-Content $SchemaMarker -Raw | ConvertFrom-Json
      if ($marker.version -eq 1 -and $marker.fingerprint -eq $fingerprint) {
        Good "Media database schema is already ready."
        return
      }
    } catch {}
  }
  Say "Applying safe database updates..."
  $migrationLog = Join-Path $LogRoot "database.log"
  & $Node "--env-file=$EnvFile" $SetupDb *> $migrationLog
  if ($LASTEXITCODE -ne 0) {
    throw "The media database could not be prepared. Check the database settings or the logs in '$LogRoot'."
  }
  @{
    version = 1
    fingerprint = $fingerprint
    completedAt = (Get-Date).ToString("o")
  } | ConvertTo-Json | Set-Content $SchemaMarker
  Good "Media database is ready."
}
function Wait-Ready($url, $label) {
  $until = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $until) {
    try {
      $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
      $content = [string]$response.Content
      if ($response.StatusCode -eq 200) {
        if ($url -match "/api/healthz$" -and $content -match '"status"\s*:\s*"ok"') { return $true }
        if ($url -notmatch "/api/healthz$" -and $content -match "<html|<!doctype html") { return $true }
      }
    } catch {}
    Say "Still waiting for $label..."
    Start-Sleep -Seconds 2
  }
  return $false
}
function Assert-TrustedDownloadResponse($response) {
  $finalUri = $null
  try { $finalUri = $response.BaseResponse.ResponseUri } catch {}
  if ($finalUri -and $finalUri.Host -notin @(
      "github.com",
      "objects.githubusercontent.com",
      "release-assets.githubusercontent.com",
      "github-releases.githubusercontent.com"
    )) {
    throw "The release download redirected to an untrusted host."
  }
}
function Ensure-Env {
  Ensure-Folders
  if (Test-Path $EnvFile) { return $true }
  $legacyEnv = Join-Path $env:SystemDrive "Willards-Media-Center\.env"
  if (Test-Path $legacyEnv) {
    $databaseLine = Get-Content $legacyEnv | Where-Object { $_ -match "^DATABASE_URL=" } | Select-Object -First 1
    $secretLine = Get-Content $legacyEnv | Where-Object { $_ -match "^SESSION_SECRET=" } | Select-Object -First 1
    if ($databaseLine -and $databaseLine -notmatch "yourpassword") {
      @($databaseLine, $secretLine, "PORT=8080") | Where-Object { $_ } | Set-Content $EnvFile -Encoding UTF8
      Good "Existing database settings were found and reused."
      return $true
    }
  }
  @"
DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/willard
PORT=8080
SESSION_SECRET=$(-join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) }))
"@ | Set-Content $EnvFile -Encoding UTF8
  Warn "A settings file was created. Update DATABASE_URL in '$EnvFile', then launch again."
  return $false
}
function Test-Dependencies {
  if (-not (Test-Path $Node)) { throw "Willard Media Center is missing its bundled runtime. Reinstall the latest release." }
  if (-not (Test-Path $Api) -or -not (Test-Path $SetupDb) -or -not (Test-Path $Web)) { throw "Willard Media Center is missing installed application files. Reinstall the latest release." }
  if (-not (Test-Path $EnvFile)) { return $false }
  $env:DATABASE_URL = ((Get-Content $EnvFile | Where-Object { $_ -match "^DATABASE_URL=" } | Select-Object -First 1) -replace "^DATABASE_URL=", "").Trim()
  if (-not $env:DATABASE_URL -or $env:DATABASE_URL -match "yourpassword") { Warn "Your local database connection still needs to be configured in '$EnvFile'."; return $false }
  return $true
}
function Try-Update {
  if ($env:WILLARD_SKIP_UPDATE -eq "1") { return }
  try {
    $script:UpdateStage = "manifest check"
    Say "Checking for a newer Willard release..."
    $manifestResponse = Invoke-WebRequest -Uri $UpdateManifest -UseBasicParsing -TimeoutSec 8
    Assert-TrustedDownloadResponse $manifestResponse
    $remote = $manifestResponse.Content | ConvertFrom-Json
    $local = Read-Version
    $remoteVersion = [version]($remote.version -replace "-.*$", "")
    if ($remoteVersion -le [version]($local -replace "-.*$", "")) {
      Good "Willard Media Center $local is current."
      Set-Content $UpdateCheckFile (Get-Date).ToString("o")
      return
    }
    if (-not $remote.artifactUrl -or $remote.artifactUrl -notmatch "^https://" -or
      -not $remote.sha256 -or $remote.sha256 -notmatch "^[a-fA-F0-9]{64}$") {
      throw "The release description is incomplete or unsafe."
    }
    $remoteManifestFile = Join-Path $DataRoot "updates\release-manifest.json"
    New-Item -ItemType Directory -Force (Split-Path $remoteManifestFile) | Out-Null
    $remote | ConvertTo-Json -Depth 10 | Set-Content $remoteManifestFile -Encoding UTF8
    try {
      $script:UpdateStage = "manifest signature verification"
      & $Node $ReleaseContract "--verify" $remoteManifestFile
      if ($LASTEXITCODE -ne 0) { throw "The release description failed signature verification." }
    } finally {
      Remove-Item $remoteManifestFile -Force -ErrorAction SilentlyContinue
    }
    $stage = Join-Path $DataRoot "updates\$($remote.version)"
    $zip = Join-Path $DataRoot "updates\release.zip"
    New-Item -ItemType Directory -Force (Split-Path $zip) | Out-Null
    $script:UpdateStage = "release download"
    Say "Downloading Willard Media Center $($remote.version)..."
    $artifactResponse = Invoke-WebRequest -Uri $remote.artifactUrl -OutFile $zip -PassThru -TimeoutSec 120
    Assert-TrustedDownloadResponse $artifactResponse
    $script:UpdateStage = "checksum verification"
    $hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $remote.sha256.ToLowerInvariant()) { throw "The downloaded release did not pass its safety check." }
    $remote | ConvertTo-Json -Depth 10 | Set-Content $remoteManifestFile -Encoding UTF8
    try {
      $script:UpdateStage = "signed artifact verification"
      & $Node $ReleaseContract "--verify-artifact" $remoteManifestFile $zip
      if ($LASTEXITCODE -ne 0) { throw "The downloaded release failed signed artifact verification." }
    } finally {
      Remove-Item $remoteManifestFile -Force -ErrorAction SilentlyContinue
    }
    $script:UpdateStage = "release validation"
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive -Path $zip -DestinationPath $stage -Force
    $required = @("version.json", "payload-manifest.json", "runtime\node.exe", "desktop\WillardMediaCenter.ps1",
      "desktop\desktop-web-server.mjs", "desktop\database-backup.mjs", "desktop\loading.html",
      "api-runtime\dist\index.mjs", "api-runtime\setup-db.cjs",
      "web\index.html", "web\willard-loading.mp4")
    foreach ($entry in $required) {
      if (-not (Test-Path (Join-Path $stage $entry))) { throw "The downloaded release is incomplete: $entry" }
    }
    $stagedVersion = (Get-Content (Join-Path $stage "version.json") -Raw | ConvertFrom-Json).version
    if ($stagedVersion -ne $remote.version) { throw "The downloaded release version does not match its manifest." }
    $script:UpdateStage = "candidate preparation"
    $installParent = Split-Path -Parent $InstallRoot
    $installLeaf = Split-Path -Leaf $InstallRoot
    $candidate = Join-Path $installParent ("." + $installLeaf + ".candidate-" + [guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Force $candidate | Out-Null
    Copy-Item (Join-Path $stage "*") $candidate -Recurse -Force -ErrorAction Stop
    Test-PackagedUpdateFault "candidate-copy"
    foreach ($entry in $required) {
      if (-not (Test-Path (Join-Path $candidate $entry))) { throw "Prepared update is missing: $entry" }
    }

    $script:UpdateStage = "atomic version swap"
    Stop-Services
    $backup = Join-Path $installParent ("." + $installLeaf + ".previous-" + $local + "-" + (Get-Date -Format "yyyyMMddHHmmss"))
    Invoke-PackagedVersionSwap $candidate $backup
    foreach ($entry in $required) {
      if (-not (Test-Path (Join-Path $InstallRoot $entry))) { throw "Activated update is missing: $entry" }
    }
    Good "Willard Media Center was updated safely. The prior runnable version is retained until health checks pass."
  } catch {
    if ($candidate -and (Test-Path $candidate)) {
      Remove-Item $candidate -Recurse -Force -ErrorAction SilentlyContinue
    }
    $statusCode = 0
    try { $statusCode = [int]$_.Exception.Response.StatusCode } catch {}
    if ($statusCode -ne 404) {
      Warn ("Update " + $script:UpdateStage + " skipped: " + $_.Exception.Message)
    }
  }
}

Ensure-Folders
Write-Host ""
Write-Host "  Willard Media Center" -ForegroundColor Cyan
Write-Host "  Starting your local media library" -ForegroundColor Gray
try {
  if ($args -contains "-Stop") {
    Stop-Services
    Good "Willard Media Center services stopped."
    exit 0
  }
  $existing = Read-Pids
  if ($existing -and (Is-Alive $existing.api) -and (Is-Alive $existing.web)) {
    Good "Willard Media Center is already running."
    Start-Process $WebUrl
    exit 0
  }
  if ($existing) { Say "Recovering from an interrupted start..."; Stop-Services }
  Start-LoadingScreen
  Recover-InterruptedUpdateSwap
  Try-Update
  if (-not (Ensure-Env)) {
    throw "Willard needs database connection details before it can start. Update '$EnvFile' and launch again."
  }
  if (-not (Test-Dependencies)) {
    throw "Willard cannot use its database settings yet. Check '$EnvFile' and launch again."
  }
  Ensure-Schema
  $env:WILLARD_SCHEMA_READY = "1"
  $env:PORT = "8080"
  $apiProc = $null
  try {
    $apiProc = Start-Process $Node -ArgumentList @("--env-file=`"$EnvFile`"", "`"$Api`"") -WorkingDirectory (Join-Path $InstallRoot "api-runtime") -RedirectStandardOutput (Join-Path $LogRoot "api.log") -RedirectStandardError (Join-Path $LogRoot "api-error.log") -WindowStyle Hidden -PassThru
    Save-Services $apiProc.Id $null
    $webProc = Start-Process $Node -ArgumentList @("`"$WebServer`"", "--root=`"$Web`"", "--port=5000", "--api=http://127.0.0.1:8080") -WorkingDirectory $InstallRoot -RedirectStandardOutput (Join-Path $LogRoot "web.log") -RedirectStandardError (Join-Path $LogRoot "web-error.log") -WindowStyle Hidden -PassThru
    Save-Services $apiProc.Id $webProc.Id
  } catch {
    Stop-Services
    throw
  }
  Say "Starting the library service..."
  if (-not (Wait-Ready $ApiUrl "library service")) { Stop-Services; throw "The local library service did not become ready. Check the logs in '$LogRoot'." }
  Say "Starting the Media Center..."
  if (-not (Wait-Ready $WebUrl "Media Center")) { Stop-Services; throw "The Media Center did not become ready. Check the logs in '$LogRoot'." }
  if ($script:UpdateBackup) {
    Remove-Item $script:UpdateBackup -Recurse -Force -ErrorAction SilentlyContinue
    $script:UpdateBackup = $null
    Remove-UpdateJournal
    Set-Content $UpdateCheckFile (Get-Date).ToString("o")
  }
  Good "Media Center is ready."
  if (-not (Test-Path $LoadingScreen)) { Start-Process $WebUrl }
} catch {
  Stop-Services
  try { Restore-UpdateBackup | Out-Null } catch { Warn "The prior update backup could not be restored automatically." }
  Close-LoadingScreen
  Report-StartupFailure $_.Exception.Message
  exit 1
}