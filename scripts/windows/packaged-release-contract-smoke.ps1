$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$TempBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$TempRoot = Join-Path $TempBase ("willard-packaged-release-smoke-" + [guid]::NewGuid().ToString("N"))
$PackageRoot = Join-Path $TempRoot "package"
$RuntimeRoot = Join-Path $PackageRoot "runtime"
$DesktopRoot = Join-Path $PackageRoot "desktop"
$FixturesRoot = Join-Path $TempRoot "fixtures"
$InstalledRoot = Join-Path $TempRoot "installed"
$VersionFile = Join-Path $InstalledRoot "version.json"
$InstallMarker = Join-Path $InstalledRoot "installed.marker"
$ContractSource = Join-Path $Root "desktop\release-contract.mjs"
$FixtureGenerator = Join-Path $Root "scripts\windows\release-contract-smoke-fixtures.mjs"
$PackagedNode = Join-Path $RuntimeRoot "node.exe"
$PackagedContract = Join-Path $DesktopRoot "release-contract.mjs"

function Assert-True($condition, $message) {
  if (-not $condition) { throw $message }
}

function Assert-Equal($actual, $expected, $message) {
  if ($actual -ne $expected) {
    throw "$message Expected '$expected', got '$actual'."
  }
}

function Set-InstalledVersion($version) {
  @{ version = $version } | ConvertTo-Json -Compress |
    Set-Content -LiteralPath $VersionFile -Encoding UTF8 -NoNewline
}

function Get-InstalledVersion {
  return [string]((Get-Content -LiteralPath $VersionFile -Raw -ErrorAction Stop | ConvertFrom-Json).version)
}

function Invoke-PackagedUpdateDecision($manifestPath) {
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -ErrorAction Stop | ConvertFrom-Json
  $verifyOutput = @(& $PackagedNode $PackagedContract "--verify" $manifestPath "--public-key" $PublicKeyPath 2>&1)
  $verifyExitCode = $LASTEXITCODE
  if ($verifyExitCode -ne 0) {
    return [pscustomobject]@{ accepted = $false; stage = "signature"; output = ($verifyOutput -join "`n") }
  }

  $script:CompareCalls += 1
  $currentVersion = Get-InstalledVersion
  $compareOutput = @(& $PackagedNode $PackagedContract "--compare" ([string]$manifest.version) $currentVersion 2>&1)
  $compareExitCode = $LASTEXITCODE
  if ($compareExitCode -ne 0) {
    return [pscustomobject]@{ accepted = $false; stage = "version"; output = ($compareOutput -join "`n") }
  }

  $comparison = 0
  if (-not [int]::TryParse(($compareOutput -join "").Trim(), [ref]$comparison)) {
    throw "The packaged release-contract CLI returned a malformed comparison result."
  }
  if ($comparison -gt 0) {
    Set-InstalledVersion ([string]$manifest.version)
    return [pscustomobject]@{ accepted = $true; stage = "updated"; output = "" }
  }
  return [pscustomobject]@{ accepted = $false; stage = "current"; output = "" }
}

try {
  if (-not ($env:OS -eq "Windows_NT" -or $IsWindows)) {
    throw "This smoke test must run on Windows."
  }
  if (-not (Test-Path -LiteralPath $ContractSource -PathType Leaf) -or
    -not (Test-Path -LiteralPath $FixtureGenerator -PathType Leaf)) {
    throw "The release-contract smoke-test source files are missing."
  }

  $nodeCommand = Get-Command node.exe -ErrorAction Stop
  $sourceNode = $nodeCommand.Source
  $sourceNodeVersion = (& $sourceNode --version 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $sourceNodeVersion -ne "v24.13.1") {
    throw "The smoke test requires the packaged Node.js 24.13.1 runtime; found '$sourceNodeVersion'."
  }

  New-Item -ItemType Directory -Force -Path $RuntimeRoot, $DesktopRoot, $FixturesRoot, $InstalledRoot | Out-Null
  Copy-Item -LiteralPath $sourceNode -Destination $PackagedNode -ErrorAction Stop
  Copy-Item -LiteralPath $ContractSource -Destination $PackagedContract -ErrorAction Stop
  $packagedNodeVersion = (& $PackagedNode --version 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $packagedNodeVersion -ne "v24.13.1") {
    throw "The copied packaged runtime did not start with the expected Node.js version."
  }

  & $PackagedNode $FixtureGenerator $PackagedContract $FixturesRoot
  if ($LASTEXITCODE -ne 0) { throw "Could not create the signed release-contract smoke fixtures." }
  $PublicKeyPath = Join-Path $FixturesRoot "test-public-key.pem"
  $stableManifest = Join-Path $FixturesRoot "stable.json"
  $prereleaseManifest = Join-Path $FixturesRoot "prerelease.json"
  $invalidSignatureManifest = Join-Path $FixturesRoot "invalid-signature.json"
  $malformedVersionManifest = Join-Path $FixturesRoot "malformed-version.json"

  $comparison = (& $PackagedNode $PackagedContract "--compare" "2.0.0" "2.0.0-beta.10" 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw "Packaged CLI stable-version comparison failed." }
  Assert-Equal $comparison "1" "Stable releases must sort after prereleases."
  $comparison = (& $PackagedNode $PackagedContract "--compare" "2.0.0-beta.10" "2.0.0-beta.2" 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw "Packaged CLI prerelease comparison failed." }
  Assert-Equal $comparison "1" "Numeric prerelease identifiers must compare numerically."
  $comparison = (& $PackagedNode $PackagedContract "--compare" "2.0.0-beta.2" "2.0.0-beta.10" 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw "Packaged CLI reverse prerelease comparison failed." }
  Assert-Equal $comparison "-1" "Prerelease ordering must be consistent in both directions."

  Set-InstalledVersion "1.9.0"
  Set-Content -LiteralPath $InstallMarker -Value "keep installed files" -Encoding ASCII
  $script:CompareCalls = 0
  $stableResult = Invoke-PackagedUpdateDecision $stableManifest
  Assert-True $stableResult.accepted "A correctly signed stable release was not accepted."
  Assert-Equal (Get-InstalledVersion) "2.0.0" "The signed stable update was not recorded."
  Assert-Equal (Get-Content -LiteralPath $InstallMarker -Raw) "keep installed files" "The installed payload marker changed."

  Set-InstalledVersion "2.0.0-beta.2"
  $prereleaseResult = Invoke-PackagedUpdateDecision $prereleaseManifest
  Assert-True $prereleaseResult.accepted "A correctly signed newer prerelease was not accepted."
  Assert-Equal (Get-InstalledVersion) "2.0.0-beta.10" "The signed prerelease update was not recorded."

  Set-InstalledVersion "2.0.0"
  $beforeCompareCalls = $script:CompareCalls
  $beforeMarker = Get-Content -LiteralPath $InstallMarker -Raw
  $invalidSignatureResult = Invoke-PackagedUpdateDecision $invalidSignatureManifest
  Assert-True (-not $invalidSignatureResult.accepted -and $invalidSignatureResult.stage -eq "signature") `
    "A release with an invalid signature was not rejected at signature verification."
  Assert-Equal $script:CompareCalls $beforeCompareCalls "The launcher compared a version before signature verification succeeded."
  Assert-Equal (Get-InstalledVersion) "2.0.0" "An invalid signature changed the installed version."
  Assert-Equal (Get-Content -LiteralPath $InstallMarker -Raw) $beforeMarker "An invalid signature changed installed files."

  $malformedResult = Invoke-PackagedUpdateDecision $malformedVersionManifest
  Assert-True (-not $malformedResult.accepted -and $malformedResult.stage -eq "signature") `
    "A manifest with a malformed version was not rejected during validation."
  Assert-Equal $script:CompareCalls $beforeCompareCalls "A malformed release version reached the comparison step."
  Assert-Equal (Get-InstalledVersion) "2.0.0" "A malformed release version changed the installed version."
  Assert-Equal (Get-Content -LiteralPath $InstallMarker -Raw) $beforeMarker "A malformed release version changed installed files."

  Write-Host "Packaged Windows release-contract smoke passed: signed verification precedes stable/prerelease comparison, and invalid manifests preserve the installed version."
} finally {
  Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
