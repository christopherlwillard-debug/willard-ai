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
$ApiUrl = "http://127.0.0.1:8080/api/healthz"
$WebUrl = "http://127.0.0.1:5000"
$UpdateManifest = "https://github.com/christopherlwillard-debug/willard-ai/releases/latest/download/release-manifest.json"
$script:WillardRunToken = [guid]::NewGuid().ToString()
$script:UpdateBackup = $null
$script:UpdateStage = "startup"

function Say($message) { Write-Host "  $message" -ForegroundColor Gray }
function Good($message) { Write-Host "  [OK] $message" -ForegroundColor Green }
function Warn($message) { Write-Host "  [!]  $message" -ForegroundColor Yellow }
function Fail($message) { Write-Host "  [X]  $message" -ForegroundColor Red }
function Ensure-Folders { New-Item -ItemType Directory -Force -Path $DataRoot, $LogRoot | Out-Null }
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
function Restore-UpdateBackup {
  if (-not $script:UpdateBackup -or -not (Test-Path $script:UpdateBackup)) { return }
  Remove-Item (Join-Path $InstallRoot "*") -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $script:UpdateBackup "*") $InstallRoot -Recurse -Force
  Remove-Item $script:UpdateBackup -Recurse -Force -ErrorAction SilentlyContinue
  $script:UpdateBackup = $null
  Warn "The previous working release was restored."
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
    $remote = Invoke-RestMethod -Uri $UpdateManifest -TimeoutSec 8
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
    $stage = Join-Path $DataRoot "updates\$($remote.version)"
    $zip = Join-Path $DataRoot "updates\release.zip"
    New-Item -ItemType Directory -Force (Split-Path $zip) | Out-Null
    $script:UpdateStage = "release download"
    Say "Downloading Willard Media Center $($remote.version)..."
    Invoke-WebRequest -Uri $remote.artifactUrl -OutFile $zip -TimeoutSec 120
    $script:UpdateStage = "checksum verification"
    $hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $remote.sha256.ToLowerInvariant()) { throw "The downloaded release did not pass its safety check." }
    $script:UpdateStage = "release validation"
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive -Path $zip -DestinationPath $stage -Force
    $required = @("version.json", "payload-manifest.json", "runtime\node.exe", "desktop\WillardMediaCenter.ps1",
      "desktop\desktop-web-server.mjs", "desktop\loading.html",
      "api-runtime\dist\index.mjs", "api-runtime\setup-db.cjs",
      "web\index.html", "web\willard-loading.mp4")
    foreach ($entry in $required) {
      if (-not (Test-Path (Join-Path $stage $entry))) { throw "The downloaded release is incomplete: $entry" }
    }
    $stagedVersion = (Get-Content (Join-Path $stage "version.json") -Raw | ConvertFrom-Json).version
    if ($stagedVersion -ne $remote.version) { throw "The downloaded release version does not match its manifest." }
    $script:UpdateStage = "installation backup"
    Stop-Services
    $backup = Join-Path $DataRoot "backup-$local"
    Remove-Item $backup -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item $InstallRoot $backup -Recurse -Force
    $script:UpdateBackup = $backup
    try {
      $script:UpdateStage = "release installation"
      Copy-Item (Join-Path $stage "*") $InstallRoot -Recurse -Force
      foreach ($entry in $required) {
        if (-not (Test-Path (Join-Path $InstallRoot $entry))) { throw "Installed update is missing: $entry" }
      }
      Good "Willard Media Center was updated safely."
    } catch {
      Remove-Item (Join-Path $InstallRoot "*") -Recurse -Force -ErrorAction SilentlyContinue
      Copy-Item (Join-Path $backup "*") $InstallRoot -Recurse -Force
      throw "The update could not be installed; the previous version was restored."
    }
  } catch {
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
  if (Test-Path $LoadingScreen) { Start-Process $LoadingScreen }
  Try-Update
  if (-not (Ensure-Env)) { exit 1 }
  if (-not (Test-Dependencies)) { exit 1 }
  Ensure-Schema
  $env:WILLARD_SCHEMA_READY = "1"
  $env:PORT = "8080"
  $apiProc = $null
  try {
    $apiProc = Start-Process $Node -ArgumentList @("--env-file=$EnvFile", $Api) -WorkingDirectory (Join-Path $InstallRoot "api-runtime") -RedirectStandardOutput (Join-Path $LogRoot "api.log") -RedirectStandardError (Join-Path $LogRoot "api-error.log") -WindowStyle Hidden -PassThru
    Save-Services $apiProc.Id $null
    $webProc = Start-Process $Node -ArgumentList @($WebServer, "--root=$Web", "--port=5000", "--api=http://127.0.0.1:8080") -WorkingDirectory $InstallRoot -RedirectStandardOutput (Join-Path $LogRoot "web.log") -RedirectStandardError (Join-Path $LogRoot "web-error.log") -WindowStyle Hidden -PassThru
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
    Set-Content $UpdateCheckFile (Get-Date).ToString("o")
  }
  Good "Media Center is ready."
  if (-not (Test-Path $LoadingScreen)) { Start-Process $WebUrl }
} catch {
  Stop-Services
  Restore-UpdateBackup
  Fail $_.Exception.Message
  Write-Host "  Logs: $LogRoot" -ForegroundColor DarkGray
  exit 1
}