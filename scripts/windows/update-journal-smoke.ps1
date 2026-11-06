# Exercise the packaged-updater journal writer and recovery behavior without launching the app.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Launcher = Join-Path $Root "desktop\\WillardMediaCenter.ps1"
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$ReleaseContract = Join-Path $Root "desktop\release-contract.mjs"
$DeveloperCommon = Join-Path $Root "scripts\launcher\common.ps1"
$TempRoot = Join-Path $env:RUNNER_TEMP "willard-update-journal-$([guid]::NewGuid().ToString('N'))"
$UpdateJournal = Join-Path $TempRoot "updates\\swap-journal.json"
$InstallRoot = Join-Path $TempRoot "install"
$PidFile = Join-Path $TempRoot "services.json"
$candidate = Join-Path $TempRoot (".install.candidate-" + [guid]::NewGuid().ToString())
$backup = Join-Path $TempRoot (".install.previous-1.2.0-" + (Get-Date -Format "yyyyMMddHHmmss"))

function Assert-True($condition, $message) {
  if (-not $condition) { throw $message }
}
function Warn($message) { Write-Host $message }
function Write-TestJournal($phase) {
  @{
    version = 1
    phase = $phase
    installRoot = $InstallRoot
    candidate = $candidate
    backup = $backup
    updatedAt = (Get-Date).ToString("o")
  } | ConvertTo-Json | Set-Content -LiteralPath $UpdateJournal -Encoding UTF8
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

  # Dot-source only the production functions under test. The app and services
  # are never started; all paths are isolated beneath the runner temp folder.
  foreach ($functionName in @(
    "Write-UpdateJournal",
    "Read-UpdateJournal",
    "Remove-UpdateJournal",
    "Restore-UpdateBackup",
    "Recover-InterruptedUpdateSwap",
    "Read-Pids",
    "Get-InstalledWindowsVersion",
    "Test-WindowsVersionRequirement"
  )) {
    $functionAst = $ast.Find({
      param($node)
      $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq $functionName
    }, $true)
    Assert-True ($null -ne $functionAst) "$functionName was not found in the packaged launcher."
    . ([scriptblock]::Create($functionAst.Extent.Text))
  }
  $script:UpdateBackup = $null
  $script:UpdateCandidate = $null

  New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null
  @{
    version = 2
    runToken = "process-state-smoke"
    api = @{
      pid = 12345
      path = "C:\Willard\runtime\node.exe"
      commandLine = "node.exe --smoke-api"
      creationDate = "2026-11-05T00:00:00Z"
    }
    web = $null
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $PidFile -Encoding UTF8
  $validProcessState = Read-Pids
  Assert-True ($validProcessState.api.pid -eq 12345) "A valid process state record was rejected."

  Set-Content -LiteralPath $PidFile -Value "{not-json" -Encoding UTF8
  $corruptProcessStateRejected = $false
  try { Read-Pids | Out-Null } catch {
    $corruptProcessStateRejected = $_.Exception.Message -match "services state file is unreadable or invalid"
  }
  Assert-True $corruptProcessStateRejected "A corrupt services state file was treated as if no services were running."
  Assert-True (Test-Path -LiteralPath $PidFile -PathType Leaf) "The corrupt services state was deleted instead of being preserved for recovery."

  @{
    version = 2
    runToken = "process-state-smoke"
    api = @{ pid = 12345; path = ""; commandLine = "node.exe --smoke-api" }
    web = $null
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $PidFile -Encoding UTF8
  $incompleteProcessStateRejected = $false
  try { Read-Pids | Out-Null } catch {
    $incompleteProcessStateRejected = $_.Exception.Message -match "services state file is unreadable or invalid"
  }
  Assert-True $incompleteProcessStateRejected "A process state record without executable identity was accepted."
  Remove-Item -LiteralPath $PidFile -Force

  $developerTokens = $null
  $developerParseErrors = $null
  $developerAst = [System.Management.Automation.Language.Parser]::ParseFile(
    $DeveloperCommon,
    [ref]$developerTokens,
    [ref]$developerParseErrors
  )
  Assert-True ($developerParseErrors.Count -eq 0) ("Developer launcher has PowerShell parse errors: " + ($developerParseErrors -join "; "))
  $developerReaderAst = $developerAst.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
      $node.Name -eq "Read-TrackedPids"
  }, $true)
  Assert-True ($null -ne $developerReaderAst) "Read-TrackedPids was not found in the developer launcher."
  $developerReaderSource = $developerReaderAst.Extent.Text -replace "^function Read-TrackedPids", "function Read-DeveloperTrackedPids"
  . ([scriptblock]::Create($developerReaderSource))

  @{
    version = 2
    runToken = "developer-process-state-smoke"
    api = @{ pid = 23456; path = "C:\Willard\runtime\node.exe"; commandLine = "node.exe --developer-smoke" }
    web = $null
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $PidFile -Encoding UTF8
  $developerState = Read-DeveloperTrackedPids
  Assert-True ($developerState.api.pid -eq 23456) "The developer launcher rejected a valid process state record."

  Set-Content -LiteralPath $PidFile -Value "{not-json" -Encoding UTF8
  $developerCorruptStateRejected = $false
  try { Read-DeveloperTrackedPids | Out-Null } catch {
    $developerCorruptStateRejected = $_.Exception.Message -match "developer services state file is unreadable or invalid"
  }
  Assert-True $developerCorruptStateRejected "The developer launcher treated corrupt process state as no running services."
  Assert-True (Test-Path -LiteralPath $PidFile -PathType Leaf) "The developer launcher deleted corrupt process state."

  $developerIdentityAst = $developerAst.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
      $node.Name -eq "Get-ProcessIdentity"
  }, $true)
  Assert-True ($null -ne $developerIdentityAst) "Get-ProcessIdentity was not found in the developer launcher."
  $developerIdentitySource = $developerIdentityAst.Extent.Text -replace "^function Get-ProcessIdentity", "function Get-DeveloperProcessIdentity"
  . ([scriptblock]::Create($developerIdentitySource))
  function Get-CimInstance {
    [CmdletBinding()]
    param([string]$ClassName, [string]$Filter)
    throw "synthetic WMI query failure"
  }
  $developerWmiFailureRejected = $false
  try { Get-DeveloperProcessIdentity 23456 | Out-Null } catch {
    $developerWmiFailureRejected = $_.Exception.Message -match "could not verify the identity of Willard process"
  }
  Remove-Item Function:\Get-CimInstance -ErrorAction SilentlyContinue
  Assert-True $developerWmiFailureRejected "The developer launcher treated a WMI query failure as a missing process."
  Remove-Item -LiteralPath $PidFile -Force

  $actualWindowsVersion = Get-InstalledWindowsVersion
  Assert-True ($actualWindowsVersion -match '^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2}$') "CIM did not return a supported Windows NT version."
  Assert-True (Test-WindowsVersionRequirement "10.0.19045" "10") "Windows 10 build 19045 should satisfy the Windows 10 baseline."
  Assert-True (-not (Test-WindowsVersionRequirement "10.0.19045" "10.0.22000")) "Windows 10 build 19045 must not satisfy a Windows 11 build 22000 requirement."
  Assert-True (Test-WindowsVersionRequirement "10.0.22000" "10.0.22000") "The minimum Windows build should be inclusive."
  Assert-True (Test-WindowsVersionRequirement "10.0.22631" "10.0.22000") "A newer Windows build should satisfy the minimum."
  Assert-True (-not (Test-WindowsVersionRequirement "6.3.9600" "10")) "Windows 8.1 must not satisfy the Windows 10 baseline."

  Write-UpdateJournal "prepared" $candidate $backup
  Assert-True (Test-Path -LiteralPath $UpdateJournal -PathType Leaf) "Initial journal was not created."
  $first = Read-UpdateJournal
  Assert-True ($first.phase -eq "prepared") "Initial journal contents are incorrect."
  Assert-True ($first.installRoot -eq $InstallRoot) "Journal install root is incorrect."

  Write-UpdateJournal "swapped" $candidate $backup
  $second = Read-UpdateJournal
  Assert-True ($second.phase -eq "swapped") "Atomic replacement did not publish the updated phase."
  Assert-True ($second.candidate -eq $candidate -and $second.backup -eq $backup) "Updated journal paths are incorrect."

  $temporaryFiles = @(Get-ChildItem -LiteralPath (Split-Path -Parent $UpdateJournal) -Filter "swap-journal.json.*.tmp" -File -ErrorAction SilentlyContinue)
  $backupFiles = @(Get-ChildItem -LiteralPath (Split-Path -Parent $UpdateJournal) -Filter "swap-journal.json.*.bak" -File -ErrorAction SilentlyContinue)
  Assert-True ($temporaryFiles.Count -eq 0) "Journal writer left temporary files behind."
  Assert-True ($backupFiles.Count -eq 0) "Journal writer left replacement backups behind."

  # A malformed journal must stop recovery without deleting the install,
  # candidate, backup, or journal itself.
  New-Item -ItemType Directory -Force -Path $InstallRoot, $candidate, $backup | Out-Null
  Set-Content -LiteralPath (Join-Path $InstallRoot "install.marker") "installed version" -NoNewline
  Set-Content -LiteralPath (Join-Path $candidate "candidate.marker") "candidate version" -NoNewline
  Set-Content -LiteralPath (Join-Path $backup "backup.marker") "previous working version" -NoNewline
  Set-Content -LiteralPath $UpdateJournal "{not-json" -NoNewline
  $corruptRejected = $false
  $corruptMessage = ""
  try { Recover-InterruptedUpdateSwap } catch { $corruptRejected = $true; $corruptMessage = $_.Exception.Message }
  Assert-True $corruptRejected "Recovery accepted a corrupt journal as if no update were pending."
  Assert-True ($corruptMessage -match "unreadable or corrupt") "Corrupt-journal diagnostics were not actionable."
  Assert-True (Test-Path -LiteralPath $UpdateJournal -PathType Leaf) "Corrupt journal was deleted."
  Assert-True (Test-Path -LiteralPath (Join-Path $InstallRoot "install.marker") -PathType Leaf) "Corrupt-journal recovery changed the installed version."
  Assert-True (Test-Path -LiteralPath (Join-Path $candidate "candidate.marker") -PathType Leaf) "Corrupt-journal recovery deleted the candidate."
  Assert-True (Test-Path -LiteralPath (Join-Path $backup "backup.marker") -PathType Leaf) "Corrupt-journal recovery deleted the previous version."

  # If this same process already recorded the displaced directory in memory,
  # it can safely roll back even when the journal becomes unreadable afterward.
  $script:UpdateBackup = $backup
  $restoredFromMemory = Restore-UpdateBackup
  Assert-True $restoredFromMemory "A corrupt journal prevented same-process rollback from its known backup path."
  Assert-True (Test-Path -LiteralPath (Join-Path $InstallRoot "backup.marker") -PathType Leaf) "Same-process rollback did not restore the known previous version."
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $InstallRoot "install.marker"))) "Same-process rollback retained the incomplete installation."
  Assert-True (-not (Test-Path -LiteralPath $UpdateJournal)) "Successful in-memory rollback left a corrupt journal."
  Assert-True (Test-Path -LiteralPath (Join-Path $candidate "candidate.marker") -PathType Leaf) "Same-process rollback unexpectedly deleted the candidate."

  # A parseable journal must still be rejected if it points outside the
  # installation's expected sibling candidate/backup paths.
  $outsideBackup = Join-Path (Split-Path -Parent $TempRoot) ".install.previous-1.2.0-20261105123456"
  @{
    version = 1
    phase = "prepared"
    installRoot = $InstallRoot
    candidate = $candidate
    backup = $outsideBackup
    updatedAt = (Get-Date).ToString("o")
  } | ConvertTo-Json | Set-Content -LiteralPath $UpdateJournal -Encoding UTF8
  $pathRejected = $false
  try { Read-UpdateJournal | Out-Null } catch { $pathRejected = $true }
  Assert-True $pathRejected "Recovery accepted a journal path outside the install parent."

  # A swapped phase without its previous-version backup is ambiguous. Keep the
  # candidate, current install, and journal rather than deleting recovery data.
  Remove-Item -LiteralPath $UpdateJournal -Force
  foreach ($pathToClear in @($InstallRoot, $candidate, $backup)) {
    if (Test-Path -LiteralPath $pathToClear) {
      Remove-Item -LiteralPath $pathToClear -Recurse -Force
    }
  }
  New-Item -ItemType Directory -Force -Path $InstallRoot, $candidate | Out-Null
  Set-Content -LiteralPath (Join-Path $InstallRoot "install.marker") "current version" -NoNewline
  Set-Content -LiteralPath (Join-Path $candidate "candidate.marker") "candidate version" -NoNewline
  Write-TestJournal "swapped"
  $missingBackupRejected = $false
  try { Recover-InterruptedUpdateSwap } catch { $missingBackupRejected = $true }
  Assert-True $missingBackupRejected "Recovery accepted a swapped journal with no rollback backup."
  Assert-True (Test-Path -LiteralPath $UpdateJournal -PathType Leaf) "Missing-backup recovery deleted the journal."
  Assert-True (Test-Path -LiteralPath (Join-Path $InstallRoot "install.marker") -PathType Leaf) "Missing-backup recovery changed the current installation."
  Assert-True (Test-Path -LiteralPath (Join-Path $candidate "candidate.marker") -PathType Leaf) "Missing-backup recovery deleted the candidate."

  # A prepared journal with the original install still present and no backup
  # means the swap never began; only the unactivated candidate is discarded.
  Remove-Item -LiteralPath $UpdateJournal -Force
  Write-TestJournal "prepared"
  Recover-InterruptedUpdateSwap
  Assert-True (Test-Path -LiteralPath (Join-Path $InstallRoot "install.marker") -PathType Leaf) "Prepared recovery changed the existing installation."
  Assert-True (-not (Test-Path -LiteralPath $candidate)) "Prepared recovery did not clean the unused candidate."
  Assert-True (-not (Test-Path -LiteralPath $UpdateJournal)) "Prepared recovery did not clear its completed journal."

  # A valid backup is restored before the candidate is discarded.
  Remove-Item -LiteralPath $InstallRoot -Recurse -Force
  New-Item -ItemType Directory -Force -Path $InstallRoot, $backup, $candidate | Out-Null
  Set-Content -LiteralPath (Join-Path $InstallRoot "install.marker") "incomplete candidate" -NoNewline
  Set-Content -LiteralPath (Join-Path $backup "backup.marker") "previous working version" -NoNewline
  Set-Content -LiteralPath (Join-Path $candidate "candidate.marker") "candidate version" -NoNewline
  Write-TestJournal "backup-created"
  Recover-InterruptedUpdateSwap
  Assert-True (Test-Path -LiteralPath (Join-Path $InstallRoot "backup.marker") -PathType Leaf) "Recovery did not restore the previous working version."
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $InstallRoot "install.marker"))) "Recovery retained the incomplete candidate installation."
  Assert-True (-not (Test-Path -LiteralPath $candidate)) "Recovery did not remove the unactivated candidate."
  Assert-True (-not (Test-Path -LiteralPath $backup)) "Recovery did not move the backup back into place."
  Assert-True (-not (Test-Path -LiteralPath $UpdateJournal)) "Successful recovery left a stale journal."

  Write-Host "Packaged updater journal smoke passed: atomic writes, corrupt/path validation, missing-backup preservation, prepared cleanup, and verified prior-version restoration."
} finally {
  Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
