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

  & git clone --quiet $Remote $Install
  if ($LASTEXITCODE -ne 0) { throw "Could not create the temporary installation." }
  & git -C $Install reset --quiet --hard HEAD~1
  if ($LASTEXITCODE -ne 0) { throw "Could not create the older installation." }

  $env:WILLARD_UPDATE_REPO = $Remote
  $env:WILLARD_UPDATE_BRANCH = $remoteBranch
  $env:WILLARD_NO_PAUSE = "1"
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
  Write-Host "Windows updater smoke passed: update, preservation, dirty-tree guard, and rollback."
} finally {
  Remove-Item $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}