# Local Windows helper for the first installer test.
# The normal release path is the Windows Release GitHub Action, triggered by
# pushing to main. This script is useful when validating a checked-out commit
# before publishing it.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Version = if ($env:WILLARD_VERSION) { $env:WILLARD_VERSION } else { "0.1.0" }
$NodeVersion = "24.13.1"
$NodeZipSha256 = "fba577c4bb87df04d54dd87bbdaa5a2272f1f99a2acbf9152e1a91b8b5f0b279"
$NodeExeSha256 = "e3be0545990c90995d7bf3a7af5d64af1f2e0fc1bbd9b79c27f7abc1e9676e50"
$Runtime = Join-Path $Root "build\node-runtime"
$RuntimeMarker = Join-Path $Runtime "node-runtime.sha256"

if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[\w.-]+)?$') {
  throw "WILLARD_VERSION must be MAJOR.MINOR.PATCH."
}

if (-not (Test-Path (Join-Path $Runtime "node.exe")) -or
    -not (Test-Path $RuntimeMarker) -or
    (Get-Content $RuntimeMarker -Raw).Trim().ToLowerInvariant() -ne $NodeZipSha256 -or
    (Get-FileHash (Join-Path $Runtime "node.exe") -Algorithm SHA256).Hash.ToLowerInvariant() -ne $NodeExeSha256) {
  $zip = Join-Path $env:TEMP "willard-node-$NodeVersion.zip"
  $extract = Join-Path $env:TEMP "willard-node-$NodeVersion"
  Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" -OutFile $zip
  if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $NodeZipSha256) {
    throw "The downloaded Node.js runtime did not match the pinned SHA-256."
  }
  Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive -Path $zip -DestinationPath $extract -Force
  New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
  Copy-Item "$extract\node-v$NodeVersion-win-x64\*" $Runtime -Recurse -Force
  if ((Get-FileHash (Join-Path $Runtime "node.exe") -Algorithm SHA256).Hash.ToLowerInvariant() -ne $NodeExeSha256) {
    throw "The extracted Node.js runtime executable did not match the pinned SHA-256."
  }
  Set-Content $RuntimeMarker $NodeZipSha256 -Encoding ASCII
}

$env:WILLARD_VERSION = $Version
$env:WILLARD_NODE_RUNTIME = $Runtime
node (Join-Path $PSScriptRoot "build-release.mjs")
node (Join-Path $PSScriptRoot "validate-release.mjs")

& (Join-Path $PSScriptRoot "compile-installer.ps1")
Write-Host "This local build is not published for automatic updates until a release manifest and ZIP are hosted publicly."