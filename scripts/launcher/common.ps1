# Willard AI launcher - shared helpers.
# Friendly, non-technical output in the happy path; technical detail goes to
# log files and is shown only on request.

$ErrorActionPreference = "Continue"

# GitHub mirror - this is the only place the URL lives.
# update.ps1 and setup.ps1 both read these constants.
$script:GithubRepo    = "https://github.com/christopherlwillard-debug/willard-ai"
$script:GithubBranch  = "main"
$script:GithubRawBase = "https://raw.githubusercontent.com/christopherlwillard-debug/willard-ai/main"

# Project root = two levels up from this script
$script:Root    = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script:LogDir  = Join-Path $Root "logs"
$script:PidFile = Join-Path $LogDir "willard.pids.json"
$script:ApiLog  = Join-Path $LogDir "api.log"
$script:WebLog  = Join-Path $LogDir "web.log"
$script:ApiUrl  = "http://localhost:8080/api/healthz"
$script:WebUrl  = "http://localhost:5000"
$script:AppUrl  = "http://localhost:5000"

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
    Write-Host ""
    Read-Host "  Press Enter to close this window" | Out-Null
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

function Ensure-LogDir {
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
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

function Ensure-AppDatabase {
    # Creates the Willard AI database if it doesn't exist yet, then verifies
    # the connection. Returns $true on success, $false on failure.
    $dbUrl = Get-EnvValue "DATABASE_URL"
    if (-not $dbUrl) { return $false }
    $createJs = @"
const { Client } = require('pg');
const url = new URL(process.env.WILLARD_DB_URL);
const dbName = url.pathname.slice(1);
// Connect to the default 'postgres' maintenance database to run CREATE DATABASE
url.pathname = '/postgres';
const c = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
c.connect()
  .then(() => c.query("SELECT 1 FROM pg_database WHERE datname = '" + dbName + "'"))
  .then(r => {
    if (r.rows.length === 0) {
      return c.query('CREATE DATABASE "' + dbName + '"').then(() => {
        console.log('created');
      });
    } else {
      console.log('exists');
    }
  })
  .then(() => { process.exit(0); })
  .catch(e => { console.error(e.message); process.exit(1); });
"@
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

function Save-TrackedPids($apiPid, $webPid) {
    Ensure-LogDir
    @{ api = $apiPid; web = $webPid; startedAt = (Get-Date).ToString("o") } |
        ConvertTo-Json | Set-Content $PidFile
}

function Clear-TrackedPids {
    Remove-Item $PidFile -ErrorAction SilentlyContinue
}

function Test-ProcessAlive($processId) {
    if (-not $processId) { return $false }
    return [bool](Get-Process -Id $processId -ErrorAction SilentlyContinue)
}

function Stop-TrackedProcesses {
    # Stops ONLY what the launcher started (tracked PIDs + their children).
    $pids = Read-TrackedPids
    $stopped = 0
    if ($pids) {
        foreach ($p in @($pids.api, $pids.web)) {
            if ($p -and (Test-ProcessAlive $p)) {
                # Stop the whole tree the tracked process spawned
                & taskkill /PID $p /T /F 2>&1 | Out-Null
                $stopped++
            }
        }
    }
    Clear-TrackedPids
    return $stopped
}

function Wait-ForUrl($url, $label, $timeoutSeconds = 60) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $lastTick = -5
    while ($sw.Elapsed.TotalSeconds -lt $timeoutSeconds) {
        try {
            $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
            if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { return $true }
        } catch { }
        $elapsed = [int]$sw.Elapsed.TotalSeconds
        if ($elapsed - $lastTick -ge 5) {
            Write-Info ("Still getting " + $label + " ready... (" + $elapsed + "s)")
            $lastTick = $elapsed
        }
        Start-Sleep -Milliseconds 800
    }
    return $false
}
