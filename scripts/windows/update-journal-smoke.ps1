# Exercise the exact packaged-updater journal writer without launching the app.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Launcher = Join-Path $Root "desktop\WillardMediaCenter.ps1"
$TempRoot = Join-Path $env:RUNNER_TEMP "willard-update-journal-$([guid]::NewGuid().ToString('N'))"
$UpdateJournal = Join-Path $TempRoot "updates\swap-journal.json"
$InstallRoot = Join-Path $TempRoot "install"
$candidate = Join-Path $TempRoot "candidate"
$backup = Join-Path $TempRoot "backup"

function Assert-True($condition, $message) {
  if (-not $condition) { throw $message }
}

try {
  $tokens = $null
  $parseErrors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $Launcher,
    [ref]$tokens,
    [ref]$parseErrors
  )
  Assert-True ($parseErrors.Count -eq 0) ("Packaged launcher has PowerShell parse errors: " + ($parseErrors -join "; "))
  $writer = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
      $node.Name -eq "Write-UpdateJournal"
  }, $true)
  Assert-True ($null -ne $writer) "Write-UpdateJournal was not found in the packaged launcher."

  # Dot-source only the actual function AST. This executes the production
  # implementation with isolated paths and does not start the application.
  . ([scriptblock]::Create($writer.Extent.Text))

  Write-UpdateJournal "prepared" $candidate $backup
  Assert-True (Test-Path -LiteralPath $UpdateJournal -PathType Leaf) "Initial journal was not created."
  $first = Get-Content -LiteralPath $UpdateJournal -Raw | ConvertFrom-Json
  Assert-True ($first.phase -eq "prepared") "Initial journal contents are incorrect."
  Assert-True ($first.installRoot -eq $InstallRoot) "Journal install root is incorrect."

  Write-UpdateJournal "swapped" $candidate $backup
  $second = Get-Content -LiteralPath $UpdateJournal -Raw | ConvertFrom-Json
  Assert-True ($second.phase -eq "swapped") "Atomic replacement did not publish the updated phase."
  Assert-True ($second.candidate -eq $candidate -and $second.backup -eq $backup) "Updated journal paths are incorrect."

  $temporaryFiles = @(Get-ChildItem -LiteralPath (Split-Path -Parent $UpdateJournal) -Filter "swap-journal.json.*.tmp" -File -ErrorAction SilentlyContinue)
  $backupFiles = @(Get-ChildItem -LiteralPath (Split-Path -Parent $UpdateJournal) -Filter "swap-journal.json.*.bak" -File -ErrorAction SilentlyContinue)
  Assert-True ($temporaryFiles.Count -eq 0) "Journal writer left temporary files behind."
  Assert-True ($backupFiles.Count -eq 0) "Journal writer left replacement backups behind."
  Write-Host "Packaged updater journal smoke passed: initial write, atomic replacement, valid JSON, and temp cleanup."
} finally {
  Remove-Item $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
