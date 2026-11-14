param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "Programs\Willard Media Center")
)

# Stable launcher and recovery entry point stored outside the replaceable app payload.
$ErrorActionPreference = "Stop"
$DataRoot = Join-Path $env:LOCALAPPDATA "Willard Media Center"
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$JournalPath = Join-Path $DataRoot "updates\swap-journal.json"
$InstallLeaf = Split-Path -Leaf $InstallRoot
$Parent = Split-Path -Parent $InstallRoot
$PowerShell = Join-Path $PSHOME "powershell.exe"

function Get-FullPath([string]$Value) {
  return [IO.Path]::GetFullPath($Value).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Test-ExpectedSibling([string]$Value, [string]$Pattern) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
  $full = Get-FullPath $Value
  if (-not [string]::Equals((Split-Path -Parent $full), (Get-FullPath $Parent), [StringComparison]::OrdinalIgnoreCase)) {
    return $false
  }
  return (Split-Path -Leaf $full) -match $Pattern
}

function Recover-IncompleteInstall {
  if (-not (Test-Path -LiteralPath $JournalPath -PathType Leaf)) {
    return
  }

  try {
    $journal = Get-Content -LiteralPath $JournalPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "The Willard update journal is unreadable. Preserve '$JournalPath' and the adjacent update directories."
  }
  if ($journal.version -ne 1 -or
      $journal.phase -notin @("prepared", "backup-created", "swapped") -or
      -not [string]::Equals((Get-FullPath ([string]$journal.installRoot)), (Get-FullPath $InstallRoot), [StringComparison]::OrdinalIgnoreCase)) {
    throw "The Willard update journal does not match this installation. No files were changed; preserve '$JournalPath'."
  }

  $candidatePattern = '^\.' + [regex]::Escape($InstallLeaf) + '\.candidate-[0-9a-fA-F-]{36}$'
  $backupPattern = '^\.' + [regex]::Escape($InstallLeaf) + '\.previous-.+-\d{14}$'
  if (-not (Test-ExpectedSibling ([string]$journal.candidate) $candidatePattern) -or
      -not (Test-ExpectedSibling ([string]$journal.backup) $backupPattern)) {
    throw "The Willard update journal contains unexpected paths. No files were changed; preserve '$JournalPath' and its adjacent directories."
  }

  $installedLauncher = Join-Path $InstallRoot "desktop\WillardMediaCenter.ps1"
  if (Test-Path -LiteralPath $installedLauncher -PathType Leaf) { return }
  if (-not (Test-Path -LiteralPath ([string]$journal.backup) -PathType Container)) {
    throw "The Willard app folder is missing or incomplete and its previous-version backup is unavailable. Preserve '$JournalPath' and any candidate or backup folders."
  }
  if (-not (Test-Path -LiteralPath (Join-Path ([string]$journal.backup) "desktop\WillardMediaCenter.ps1") -PathType Leaf)) {
    throw "The previous Willard app backup is incomplete. No files were moved; preserve '$JournalPath' and the backup folder."
  }

  New-Item -ItemType Directory -Force -Path $Parent | Out-Null
  if (Test-Path -LiteralPath $InstallRoot) {
    $incompleteLeaf = ".$InstallLeaf.incomplete-$([guid]::NewGuid().ToString())"
    $incompletePath = Join-Path $Parent $incompleteLeaf
    if (Test-Path -LiteralPath $incompletePath) {
      throw "A recovery quarantine path already exists. No files were moved; preserve '$JournalPath' and the installation folders."
    }
    Move-Item -LiteralPath $InstallRoot -Destination $incompletePath -ErrorAction Stop
  }
  $journal.phase = "prepared"
  $journal.updatedAt = (Get-Date).ToString("o")
  $journalTemp = "$JournalPath.$([guid]::NewGuid().ToString('N')).tmp"
  $journalBackup = "$JournalPath.$([guid]::NewGuid().ToString('N')).bak"
  [IO.File]::WriteAllText($journalTemp, ($journal | ConvertTo-Json) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
  [IO.File]::Replace($journalTemp, $JournalPath, $journalBackup)
  Move-Item -LiteralPath ([string]$journal.backup) -Destination $InstallRoot -ErrorAction Stop
}

try {
  Recover-IncompleteInstall

  $launcher = Join-Path $InstallRoot "desktop\WillardMediaCenter.ps1"
  if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    # A legacy installation keeps its old payload beside the durable data.
    $legacyLauncher = Join-Path $DataRoot "desktop\WillardMediaCenter.ps1"
    if (Test-Path -LiteralPath $legacyLauncher -PathType Leaf) {
      $launcher = $legacyLauncher
    } else {
      throw "The Willard launcher is missing. Preserve '$DataRoot' and repair or reinstall Willard."
    }
  }

  & $PowerShell -NoProfile -ExecutionPolicy Bypass -File $launcher @args
  exit $LASTEXITCODE
} catch {
  $message = $_.Exception.Message
  try {
    $logDirectory = Join-Path $DataRoot "logs"
    New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
    Add-Content -LiteralPath (Join-Path $logDirectory "recovery-bootstrap.log") -Value ("{0} {1}" -f (Get-Date).ToString("o"), $message)
  } catch { }
  [Console]::Error.WriteLine($message)
  exit 1
}
