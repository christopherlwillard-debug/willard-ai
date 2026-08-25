# Windows release helper. Run on a Windows build runner after configuring the
# release version, bundled Node runtime, and public artifact URL.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Version = if ($env:WILLARD_VERSION) { $env:WILLARD_VERSION } else { "0.1.0" }
$ArtifactBaseUrl = $env:WILLARD_ARTIFACT_BASE_URL
if (-not $ArtifactBaseUrl) { throw "Set WILLARD_ARTIFACT_BASE_URL to the public release download directory." }

Write-Host "Staging Willard Media Center $Version..."
node (Join-Path $Root "scripts/windows/build-release.mjs")

$releaseDir = Join-Path $Root "build\windows"
$outputDir = Join-Path $Root "build\release"
$zip = Join-Path $outputDir "WillardMediaCenter-$Version-windows-x64.zip"
$sourceZip = Join-Path $outputDir "WillardMediaCenter-$Version-source.zip"
$manifest = Join-Path $outputDir "release-manifest.json"
New-Item -ItemType Directory -Force $outputDir | Out-Null
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Remove-Item $sourceZip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $releaseDir "*") -DestinationPath $zip -CompressionLevel Optimal
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
$artifactUrl = "$($ArtifactBaseUrl.TrimEnd('/'))/WillardMediaCenter-$Version-windows-x64.zip"
& git -C $Root archive --format=zip --output=$sourceZip HEAD
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $sourceZip)) { throw "Could not create the developer source update ZIP." }
$sourceHash = (Get-FileHash $sourceZip -Algorithm SHA256).Hash.ToLowerInvariant()
$sourceArtifactUrl = "$($ArtifactBaseUrl.TrimEnd('/'))/WillardMediaCenter-$Version-source.zip"
@{
  product = "Willard Media Center"
  version = $Version
  artifactUrl = $artifactUrl
  sha256 = $hash
  sourceArtifactUrl = $sourceArtifactUrl
  sourceSha256 = $sourceHash
  notes = "See the release notes for this version."
  minimumWindowsVersion = "10"
} | ConvertTo-Json | Set-Content $manifest -Encoding UTF8
$env:WILLARD_RELEASE_ZIP = $zip
$env:WILLARD_RELEASE_MANIFEST = $manifest
 node (Join-Path $Root "scripts/windows/validate-release.mjs")
Write-Host "Release ZIP: $zip"
Write-Host "Source update ZIP: $sourceZip"
Write-Host "Release manifest: $manifest"
Write-Host "Next: compile installer/WillardMediaCenter.iss with Inno Setup and publish both files plus the manifest."