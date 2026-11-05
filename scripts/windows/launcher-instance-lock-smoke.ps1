$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "..\..\desktop\launcher-instance-lock.ps1")

$tempRoot = Join-Path $env:TEMP ("willard-launcher-lock-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot | Out-Null
$mutexName = "Local\WillardMediaCenter.LauncherSmoke." + [guid]::NewGuid().ToString("N")
$childProcesses = @()

function Start-MutexChild {
  param(
    [string]$Name,
    [string]$ReadyPath,
    [switch]$Abandon
  )

  $name64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Name))
  $ready64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($ReadyPath))
  $childLines = @(
    '$name = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("' + $name64 + '"))'
    '$ready = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("' + $ready64 + '"))'
    '$mutex = [System.Threading.Mutex]::new($false, $name)'
    'if (-not $mutex.WaitOne(5000)) { exit 21 }'
    '[System.IO.File]::WriteAllText($ready, "ready")'
  )
  if ($Abandon) {
    $childLines += 'Stop-Process -Id $PID -Force'
  } else {
    $childLines += 'Start-Sleep -Milliseconds 1400'
    $childLines += 'try { $mutex.ReleaseMutex() } finally { $mutex.Dispose() }'
  }
  $childSource = $childLines -join [Environment]::NewLine
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childSource))
  $pwsh = Join-Path $PSHOME "pwsh.exe"
  return Start-Process -FilePath $pwsh -ArgumentList @("-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", $encoded) -WindowStyle Hidden -PassThru
}

function Wait-ForReady {
  param([System.Diagnostics.Process]$Process, [string]$ReadyPath)
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $ReadyPath) { return }
    if ($Process.HasExited) {
      throw "Mutex child exited before acquiring the lock (exit $($Process.ExitCode))."
    }
    Start-Sleep -Milliseconds 50
  }
  throw "Mutex child did not acquire the lock before the timeout."
}

try {
  Write-Host "Testing that a second launcher cannot enter while startup is active..."
  $ready = Join-Path $tempRoot "held.ready"
  $holder = Start-MutexChild -Name $mutexName -ReadyPath $ready
  $childProcesses += $holder
  Wait-ForReady -Process $holder -ReadyPath $ready

  $blocked = $false
  try {
    $probe = Enter-WillardLauncherMutex -Name $mutexName -TimeoutMilliseconds 100
    Exit-WillardLauncherMutex $probe
  } catch [System.TimeoutException] {
    $blocked = $true
  }
  if (-not $blocked) {
    throw "A second launcher acquired the mutex while the first launcher still owned it."
  }
  if (-not $holder.WaitForExit(10000)) {
    throw "The mutex holder did not exit within the expected time."
  }
  if ($holder.ExitCode -ne 0) {
    throw "The normal mutex holder exited with code $($holder.ExitCode)."
  }

  $released = Enter-WillardLauncherMutex -Name $mutexName -TimeoutMilliseconds 1000
  Exit-WillardLauncherMutex $released

  Write-Host "Testing recovery after a launcher crashes while owning the mutex..."
  $abandonedReady = Join-Path $tempRoot "abandoned.ready"
  $abandonedHolder = Start-MutexChild -Name $mutexName -ReadyPath $abandonedReady -Abandon
  $childProcesses += $abandonedHolder
  Wait-ForReady -Process $abandonedHolder -ReadyPath $abandonedReady
  if (-not $abandonedHolder.WaitForExit(10000)) {
    throw "The simulated crashed launcher did not exit."
  }

  $recovered = Enter-WillardLauncherMutex -Name $mutexName -TimeoutMilliseconds 1000
  Exit-WillardLauncherMutex $recovered
  Write-Host "Installed launcher single-instance mutex smoke passed."
} finally {
  foreach ($process in $childProcesses) {
    try {
      if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
      $process.Dispose()
    } catch {}
  }
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
