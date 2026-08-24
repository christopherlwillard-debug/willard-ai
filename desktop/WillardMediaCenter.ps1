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
$ApiUrl = "http://127.0.0.1:8080/api/healthz"
$WebUrl = "http://127.0.0.1:5000"
$UpdateManifest = "https://github.com/christopherlwillard-debug/willard-ai/releases/latest/download/release-manifest.json"

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
function Is-Alive($pid) { return [bool]($pid -and (Get-Process -Id $pid -ErrorAction SilentlyContinue)) }
function Stop-Services {
  $pids = Read-Pids
  foreach ($pid in @($pids.api, $pids.web)) {
    if (Is-Alive $pid) { & taskkill /PID $pid /T /F 2>&1 | Out-Null }
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
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
    try { $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3; if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { return $true } } catch {}
    Say "Still waiting for $label..."
    Start-Sleep -Seconds 2
  }
  return $false
}
function Ensure-Env {
  Ensure-Folders
  if (Test-Path $EnvFile) { return $true }
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
  if (Test-Path $UpdateCheckFile) {
    try {
      if (((Get-Date) - (Get-Item $UpdateCheckFile).LastWriteTime).TotalHours -lt 6) {
        return
      }
    } catch {}
  }
  try {
    Say "Checking for a newer Willard release..."
    $remote = Invoke-RestMethod -Uri $UpdateManifest -TimeoutSec 8
    $local = Read-Version
    $remoteVersion = [version]($remote.version -replace "-.*$", "")
    if ($remoteVersion -le [version]($local -replace "-.*$", "")) {
      Good "Willard Media Center $local is current."
      Set-Content $UpdateCheckFile (Get-Date).ToString("o")
      return
    }
    if (-not $remote.artifactUrl -or -not $remote.sha256) { throw "The release description is incomplete." }
    $stage = Join-Path $DataRoot "updates\$($remote.version)"
    $zip = Join-Path $DataRoot "updates\release.zip"
    New-Item -ItemType Directory -Force (Split-Path $zip) | Out-Null
    Say "Downloading Willard Media Center $($remote.version)..."
    Invoke-WebRequest -Uri $remote.artifactUrl -OutFile $zip -TimeoutSec 120
    $hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $remote.sha256.ToLowerInvariant()) { throw "The downloaded release did not pass its safety check." }
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive -Path $zip -DestinationPath $stage -Force
    if (-not (Test-Path (Join-Path $stage "version.json"))) { throw "The downloaded release is incomplete." }
    Stop-Services
    $backup = Join-Path $DataRoot "backup-$local"
    Remove-Item $backup -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item $InstallRoot $backup -Recurse -Force
    try {
      Copy-Item (Join-Path $stage "*") $InstallRoot -Recurse -Force
      Good "Willard Media Center was updated safely."
    } catch {
      Remove-Item (Join-Path $InstallRoot "*") -Recurse -Force -ErrorAction SilentlyContinue
      Copy-Item (Join-Path $backup "*") $InstallRoot -Recurse -Force
      throw "The update could not be installed; the previous version was restored."
    }
    Set-Content $UpdateCheckFile (Get-Date).ToString("o")
  } catch {
    Set-Content $UpdateCheckFile (Get-Date).ToString("o")
    Warn "Update check skipped: $($_.Exception.Message)"
  }
}

Ensure-Folders
Write-Host ""
Write-Host "  Willard Media Center" -ForegroundColor Cyan
Write-Host "  Starting your local media library" -ForegroundColor Gray
try {
  $existing = Read-Pids
  if ($existing -and (Is-Alive $existing.api) -and (Is-Alive $existing.web)) {
    Good "Willard Media Center is already running."
    Start-Process $WebUrl
    exit 0
  }
  if ($existing) { Say "Recovering from an interrupted start..."; Stop-Services }
  Try-Update
  if (-not (Ensure-Env)) { exit 1 }
  if (-not (Test-Dependencies)) { exit 1 }
  Ensure-Schema
  $env:WILLARD_SCHEMA_READY = "1"
  $env:PORT = "8080"
  $apiProc = Start-Process $Node -ArgumentList @("--env-file=$EnvFile", $Api) -WorkingDirectory (Join-Path $InstallRoot "api-runtime") -RedirectStandardOutput (Join-Path $LogRoot "api.log") -RedirectStandardError (Join-Path $LogRoot "api-error.log") -WindowStyle Hidden -PassThru
  $webProc = Start-Process $Node -ArgumentList @($WebServer, "--root=$Web", "--port=5000", "--api=http://127.0.0.1:8080") -WorkingDirectory $InstallRoot -RedirectStandardOutput (Join-Path $LogRoot "web.log") -RedirectStandardError (Join-Path $LogRoot "web-error.log") -WindowStyle Hidden -PassThru
  @{ api = $apiProc.Id; web = $webProc.Id; startedAt = (Get-Date).ToString("o") } | ConvertTo-Json | Set-Content $PidFile
  Say "Starting the library service..."
  if (-not (Wait-Ready $ApiUrl "library service")) { Stop-Services; throw "The local library service did not become ready. Check the logs in '$LogRoot'." }
  Say "Starting the Media Center..."
  if (-not (Wait-Ready $WebUrl "Media Center")) { Stop-Services; throw "The Media Center did not become ready. Check the logs in '$LogRoot'." }
  Good "Media Center is ready."
  Start-Process $WebUrl
} catch {
  Fail $_.Exception.Message
  Write-Host "  Logs: $LogRoot" -ForegroundColor DarkGray
  exit 1
}