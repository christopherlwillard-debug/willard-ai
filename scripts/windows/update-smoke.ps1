# Windows-only integration smoke test for the developer one-click updater.
# This uses a temporary local Git remote so it exercises real PowerShell, Git,
# file preservation, command discovery, and rollback without network access.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$TempRoot = Join-Path $env:RUNNER_TEMP "willard-update-smoke-$([guid]::NewGuid().ToString())"
$Remote = Join-Path $TempRoot "remote"
$Install = Join-Path $TempRoot "install"
$Source = Join-Path $TempRoot "source"
$Common = Join-Path $Root "scripts\launcher\common.ps1"
$Updater = Join-Path $Root "scripts\launcher\update.ps1"

function Assert-True($condition, $message) {
  if (-not $condition) { throw $message }
}

function Read-Text($path) {
  if (Test-Path $path) { return Get-Content $path -Raw }
  return ""
}

function Wait-ForUpdateSwap($installPath, $timeoutSeconds = 60, $expectedStatus = "ok") {
  $parent = Split-Path -Parent $installPath
  $leaf = Split-Path -Leaf $installPath
  $resultPath = Join-Path $parent ("." + $leaf + ".willard-update-result.json")
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $resultPath) {
      $result = Get-Content $resultPath -Raw | ConvertFrom-Json
      Assert-True ($result.status -eq $expectedStatus) (
        "The safe folder swap returned " + $result.status + " instead of " + $expectedStatus + ": " + $result.message
      )
      return
    }
    Start-Sleep -Milliseconds 250
  }
  throw "The safe folder swap did not finish within $timeoutSeconds seconds."
}

try {
  Assert-True ($env:OS -eq "Windows_NT" -or $IsWindows) "This smoke test must run on Windows."
  Assert-True (Get-Command git -ErrorAction SilentlyContinue) "Git is required."
  New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null

  # Exercise the same COM shortcut writer used by setup.ps1 for both shortcut
  # locations without changing the runner user's real Desktop or Start Menu.
  . $Common
  $shortcutTarget = Join-Path $TempRoot "Start Willard AI.bat"
  Set-Content $shortcutTarget "@echo off`r`nexit /b 0" -Encoding ASCII
  $shortcutRoot = Join-Path $TempRoot "shortcuts"
  $desktopShortcut = Join-Path $shortcutRoot "Desktop\Willard Media Center.lnk"
  $startMenuShortcut = Join-Path $shortcutRoot "Start Menu\Update Willard AI.lnk"
  New-WillardShortcut $desktopShortcut $shortcutTarget $TempRoot
  New-WillardShortcut $startMenuShortcut $shortcutTarget $TempRoot
  $shell = New-Object -ComObject WScript.Shell
  try {
    foreach ($shortcutPath in @($desktopShortcut, $startMenuShortcut)) {
      $shortcut = $shell.CreateShortcut($shortcutPath)
      Assert-True ($shortcut.TargetPath -like "*\cmd.exe") "Shortcut does not target cmd.exe."
      Assert-True ($shortcut.WorkingDirectory -eq $TempRoot) "Shortcut working directory is wrong."
      Assert-True ($shortcut.Arguments -match [regex]::Escape($shortcutTarget)) "Shortcut target arguments are wrong."
      [Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) | Out-Null
    }
  } finally { [Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null }

  # The source clone is the local "GitHub" remote. Make one update commit.
  & git clone --quiet $Root $Remote
  if ($LASTEXITCODE -ne 0) { throw "Could not create the temporary update remote." }
  $remoteBranch = (& git -C $Remote branch --show-current).Trim()
  Assert-True $remoteBranch "Could not determine the temporary remote branch."
  & git -C $Remote config user.email "smoke@example.invalid"
  & git -C $Remote config user.name "Windows update smoke"
  Set-Content (Join-Path $Remote "update-smoke-marker.txt") "updated" -Encoding UTF8
  & git -C $Remote add update-smoke-marker.txt
  & git -C $Remote commit --quiet -m "smoke update"
  if ($LASTEXITCODE -ne 0) { throw "Could not create the update commit." }

  # Existing checkouts must refuse untracked work before changing Git state.
  $setupExisting = Join-Path $TempRoot "setup-existing"
  & git clone --quiet $Remote $setupExisting
  Set-Content (Join-Path $setupExisting "family-notes.txt") "keep me" -Encoding UTF8
  $script:Root = $setupExisting
  $script:GithubRepo = $Remote
  $script:GithubBranch = $remoteBranch
  $setupRefused = $false
  try {
    Initialize-DeveloperGitCheckout | Out-Null
  } catch {
    $setupRefused = $_.Exception.Message -match "Setup stopped before changing local files"
  }
  Assert-True $setupRefused "Setup did not refuse an existing checkout with untracked work."
  Assert-True ((Read-Text (Join-Path $setupExisting "family-notes.txt")) -match "keep me") "Setup deleted untracked work."

  # A first-time source folder is moved aside before checkout. Files that do not
  # conflict return to their original paths; conflicting files stay quarantined.
  $setupSource = Join-Path $TempRoot "setup-source"
  New-Item -ItemType Directory -Force $setupSource | Out-Null
  Set-Content (Join-Path $setupSource "family-notes.txt") "restore me" -Encoding UTF8
  Set-Content (Join-Path $setupSource ".env") "DATABASE_URL=postgresql://preserved" -Encoding UTF8
  Set-Content (Join-Path $setupSource "package.json") '{"local":"conflict"}' -Encoding UTF8
  $script:Root = $setupSource
  $env:WILLARD_SETUP_CONNECT = "1"
  Initialize-DeveloperGitCheckout | Out-Null
  Remove-Item Env:\WILLARD_SETUP_CONNECT -ErrorAction SilentlyContinue
  Assert-True ((Read-Text (Join-Path $setupSource "family-notes.txt")) -match "restore me") "Setup did not restore a non-conflicting local file."
  Assert-True ((Read-Text (Join-Path $setupSource ".env")) -match "preserved") "Setup did not restore local settings."
  Assert-True ((Read-Text (Join-Path $setupSource "package.json")) -notmatch '"local"') "Setup replaced the remote package with a local conflict."
  $setupQuarantine = Get-ChildItem $TempRoot -Directory -Force | Where-Object { $_.Name -like ".setup-source.setup-quarantine-*" } | Select-Object -First 1
  Assert-True $setupQuarantine "Setup did not retain a quarantine for conflicting files."
  Assert-True ((Read-Text (Join-Path $setupQuarantine.FullName "package.json")) -match '"local"') "The conflicting local file was not preserved in quarantine."

  & git clone --quiet $Remote $Install
  if ($LASTEXITCODE -ne 0) { throw "Could not create the temporary installation." }
  & git -C $Install reset --quiet --hard HEAD~1
  if ($LASTEXITCODE -ne 0) { throw "Could not create the older installation." }

  $env:WILLARD_UPDATE_REPO = $Remote
  $env:WILLARD_UPDATE_BRANCH = $remoteBranch
  $env:WILLARD_NO_PAUSE = "1"
  $script:Root = $Install
  $script:GithubRepo = $Remote
  $script:GithubBranch = $remoteBranch
  $data = Join-Path $Install "library-data"
  $logs = Join-Path $Install "logs"
  New-Item -ItemType Directory -Force -Path $data, $logs | Out-Null
  @("library-data/", "media-path.txt") | Add-Content (Join-Path $Install ".git\info\exclude")
  Set-Content (Join-Path $Install ".env") "DATABASE_URL=postgresql://preserved" -Encoding UTF8
  Set-Content (Join-Path $logs "api.log") "preserve logs" -Encoding UTF8
  Set-Content (Join-Path $data "postgres-data.marker") "preserve database" -Encoding UTF8
  Set-Content (Join-Path $Install "media-path.txt") "D:\Willard Media" -Encoding UTF8

  Push-Location $Install
  try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Install "scripts\launcher\update.ps1")
    Assert-True ($LASTEXITCODE -eq 0) "A clean Git update failed."
  } finally { Pop-Location }
  Wait-ForUpdateSwap $Install
  Assert-True (Test-Path (Join-Path $Install "update-smoke-marker.txt")) "The pushed commit was not installed."
  Assert-True ((Read-Text (Join-Path $Install ".env")) -match "preserved") ".env was not preserved."
  Assert-True ((Read-Text (Join-Path $logs "api.log")) -match "preserve logs") "Logs were not preserved."
  Assert-True ((Read-Text (Join-Path $data "postgres-data.marker")) -match "preserve database") "PostgreSQL data was not preserved."
  Assert-True ((Read-Text (Join-Path $Install "media-path.txt")) -match "D:\\Willard Media") "Media path was not preserved."

  # An unreachable update source must fail without changing the installed commit.
  $offlineBefore = (& git -C $Install rev-parse HEAD).Trim()
  $env:WILLARD_UPDATE_REPO = "https://127.0.0.1:1/unreachable/willard-ai"
  Push-Location $Install
  try { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Install "scripts\launcher\update.ps1") } finally { Pop-Location }
  $offlineAfter = (& git -C $Install rev-parse HEAD).Trim()
  Assert-True ($offlineAfter -eq $offlineBefore) "Offline update changed the installed revision."
  $env:WILLARD_UPDATE_REPO = $Remote

  # Local edits must stop before pull, leaving the working copy untouched.
  Set-Content (Join-Path $Install "local-change.txt") "do not overwrite" -Encoding UTF8
  Push-Location $Install
  try { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Install "scripts\launcher\update.ps1") } finally { Pop-Location }
  Assert-True ((Read-Text (Join-Path $Install "local-change.txt")) -match "do not overwrite") "Local changes were not protected."
  Remove-Item (Join-Path $Install "local-change.txt") -Force
  & git -C $Install checkout -- .

  # A changed API file with a failing pnpm build must roll back the pulled commit.
  $runtimeMarker = Join-Path $Install "node_modules\rollback.marker"
  $generatedMarker = Join-Path $Install "artifacts\api-server\dist\index.mjs.rollback.marker"
  New-Item -ItemType Directory -Force (Split-Path -Parent $runtimeMarker), (Split-Path -Parent $generatedMarker) | Out-Null
  Set-Content $runtimeMarker "old dependency tree" -Encoding UTF8
  Set-Content $generatedMarker "old generated output" -Encoding UTF8
  Set-Content (Join-Path $Remote "artifacts\api-server\smoke-update.txt") "bad build" -Encoding UTF8
  & git -C $Remote add artifacts/api-server/smoke-update.txt
  & git -C $Remote commit --quiet -m "smoke failing build"
  $before = (& git -C $Install rev-parse HEAD).Trim()
  $shim = Join-Path $TempRoot "pnpm.cmd"
  Set-Content $shim "@echo off`r`nexit /b 1" -Encoding ASCII
  $env:PATH = "$TempRoot;$env:PATH"
  Push-Location $Install
  try { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Install "scripts\launcher\update.ps1") } finally { Pop-Location }
  $after = (& git -C $Install rev-parse HEAD).Trim()
  Assert-True ($after -eq $before) "A failed rebuild did not restore the prior revision."
  Assert-True (-not (Test-Path (Join-Path $Install "artifacts\api-server\smoke-update.txt"))) "Failed update files remained installed."
  Assert-True ((Read-Text $runtimeMarker) -match "old dependency tree") "A failed rebuild changed node_modules."
  Assert-True ((Read-Text $generatedMarker) -match "old generated output") "A failed rebuild changed generated API output."

  # A failure after the old version has been moved must return the exact prior
  # runnable directory, not a Git-only source reset.
  $env:PATH = $env:PATH -replace ("^" + [regex]::Escape($TempRoot) + ";"), ""
  Set-Content (Join-Path $Remote "swap-failure-marker.txt") "must not activate" -Encoding UTF8
  & git -C $Remote add swap-failure-marker.txt
  & git -C $Remote commit --quiet -m "smoke swap failure"
  $swapBefore = (& git -C $Install rev-parse HEAD).Trim()
  $env:WILLARD_UPDATE_FAIL_AT = "swap-after-backup"
  Push-Location $Install
  try { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Install "scripts\launcher\update.ps1") } finally { Pop-Location }
  Remove-Item Env:\WILLARD_UPDATE_FAIL_AT -ErrorAction SilentlyContinue
  Wait-ForUpdateSwap $Install 60 "failed"
  $swapAfter = (& git -C $Install rev-parse HEAD).Trim()
  Assert-True ($swapAfter -eq $swapBefore) "An interrupted directory swap did not restore the prior revision."
  Assert-True (-not (Test-Path (Join-Path $Install "swap-failure-marker.txt"))) "Interrupted swap files remained installed."
  Assert-True ((Read-Text $runtimeMarker) -match "old dependency tree") "Interrupted swap changed node_modules."
  Assert-True ((Read-Text $generatedMarker) -match "old generated output") "Interrupted swap changed generated API output."
  Assert-True (-not (Test-Path (Join-Path $TempRoot ".install.willard-update.json"))) "Interrupted swap left an update journal behind."
  Write-Host "Windows updater smoke passed: full-version update, preservation, and rollback."
} finally {
  Remove-Item $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
