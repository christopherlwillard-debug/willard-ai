# Windows source-install smoke test for the developer launcher.
# This intentionally runs only on a real Windows runner.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Batch = Join-Path $Root "Start Willard AI.bat"
$Start = Join-Path $Root "scripts\launcher\start.ps1"
$Stop = Join-Path $Root "scripts\launcher\stop.ps1"
$LogDir = Join-Path $Root "logs"
$PidFile = Join-Path $LogDir "willard.pids.json"
$ViteConfig = Join-Path $Root "artifacts\willard-ai\vite.config.ts"
$SmokeOutput = Join-Path $env:RUNNER_TEMP "willard-startup.log"
$ShimDir = Join-Path $env:RUNNER_TEMP "willard-pnpm-shim"
$Shim = Join-Path $ShimDir "pnpm.cmd"

function Assert-True($condition, $message) {
  if (-not $condition) { throw $message }
}

function Read-Text($path) {
  if (Test-Path $path) { return Get-Content $path -Raw }
  return ""
}

function Wait-Http($url, $predicate, $timeoutSeconds = 180) {
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

function Invoke-Launcher($arguments, $outputPath) {
  $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $launcherArguments = @("-NoProfile", "-ExecutionPolicy", "Bypass") + @($arguments)
  $process = Start-Process -FilePath $powershell `
    -ArgumentList $launcherArguments `
    -WorkingDirectory $Root -RedirectStandardOutput $outputPath `
    -RedirectStandardError ($outputPath + ".err") -PassThru -Wait
  return $process.ExitCode
}

function Stop-Willard {
  $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  Start-Process -FilePath $powershell `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $Stop) `
    -WorkingDirectory $Root -Wait -WindowStyle Hidden | Out-Null
}

try {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  $env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/willard"
  $env:SESSION_SECRET = "windows-startup-smoke-session-secret"
  $env:WILLARD_NO_PAUSE = "1"
  @(
    "DATABASE_URL=$env:DATABASE_URL"
    "PORT=8080"
    "SESSION_SECRET=$env:SESSION_SECRET"
    "NODE_ENV=development"
  ) | Set-Content (Join-Path $Root ".env")

  Write-Host "Starting clean source checkout through the developer launcher..."
  $exitCode = Invoke-Launcher @("-File", $Start) $SmokeOutput
  Assert-True ($exitCode -eq 0) (
    "Developer launcher failed:`n" +
    (Read-Text $SmokeOutput) +
    (Read-Text ($SmokeOutput + ".err"))
  )
  Wait-Http "http://127.0.0.1:8080/api/healthz" {
    param($content) $content -match '"status"\s*:\s*"ok"'
  }
  Wait-Http "http://127.0.0.1:5000" {
    param($content) $content -match "<html|<!doctype html"
  }

  $tracked = Get-Content $PidFile -Raw | ConvertFrom-Json
  foreach ($service in @("api", "web")) {
    $record = $tracked.$service
    Assert-True ($record -and $record.pid -and $record.path -and $record.commandLine) "$service process was not fully tracked."
    $process = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$record.pid)
    Assert-True ($process -and $process.ExecutablePath -eq $record.path -and $process.CommandLine -eq $record.commandLine) "$service process ownership changed."
  }
  Write-Host "API, Media Center, and launcher-owned processes are healthy after launcher exit."
  Stop-Willard

  New-Item -ItemType Directory -Force -Path $ShimDir | Out-Null
  @"
@echo off
echo deliberate web startup failure > "%CD%\logs\web.log"
exit /b 1
"@ | Set-Content $Shim
  $env:PATH = "$ShimDir;$env:PATH"
  $failureOutput = Join-Path $env:RUNNER_TEMP "willard-startup-failure.log"
  $failureCode = Invoke-Launcher @("-File", $Start) $failureOutput
  $failureText = (Read-Text $failureOutput) + (Read-Text ($failureOutput + ".err"))
  Assert-True ($failureCode -ne 0) "The deliberate web startup failure unexpectedly succeeded."
  Assert-True ($failureText -match "web\.log" -and $failureText -match "deliberate web startup failure") `
    ("Web failure did not include its service log path and recent tail:`n" + $failureText)
  Write-Host "Deliberate web failure reported web.log and its recent tail."
} finally {
  try { Stop-Willard } catch {}
  Remove-Item $ShimDir -Recurse -Force -ErrorAction SilentlyContinue
}