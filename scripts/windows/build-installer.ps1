# Local Windows helper for the first installer test.
# The normal release path is the Windows Release GitHub Action, triggered by
# pushing to main. This script is useful when validating a checked-out commit
# before publishing it.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Version = if ($env:WILLARD_VERSION) { $env:WILLARD_VERSION } else { "0.1.0" }
$NodeVersion = "24.13.1"
$Runtime = Join-Path $Root "build\node-runtime"

if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[\w.-]+)?$') {
  throw "WILLARD_VERSION must be MAJOR.MINOR.PATCH."
}

if (-not (Test-Path (Join-Path $Runtime "node.exe"))) {
  $zip = Join-Path $env:TEMP "willard-node-$NodeVersion.zip"
  $extract = Join-Path $env:TEMP "willard-node-$NodeVersion"
  Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" -OutFile $zip
  Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive -Path $zip -DestinationPath $extract -Force
  New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
  Copy-Item "$extract\node-v$NodeVersion-win-x64\*" $Runtime -Recurse -Force
}

$env:WILLARD_VERSION = $Version
$env:WILLARD_NODE_RUNTIME = $Runtime
node (Join-Path $PSScriptRoot "build-release.mjs")
node (Join-Path $PSScriptRoot "validate-release.mjs")

$inno = Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"
if (-not (Test-Path $inno)) {
  throw "Install Inno Setup 6, then run this script again."
}
& $inno "/DMyAppVersion=$Version" (Join-Path $Root "installer\WillardMediaCenter.iss")
$setup = Join-Path $Root "build\installer\WillardMediaCenter-$Version-Setup.exe"
if (-not (Test-Path $setup)) { throw "Installer compilation did not produce $setup." }
Write-Host "Installer ready: $setup" -ForegroundColor Green
Write-Host "This local build is not published for automatic updates until a release manifest and ZIP are hosted publicly."