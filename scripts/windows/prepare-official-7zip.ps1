param(
  [Parameter(Mandatory = $true)]
  [string]$Destination
)

$ErrorActionPreference = "Stop"
$Destination = [IO.Path]::GetFullPath($Destination)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ReleaseBase = "https://github.com/ip7z/7zip/releases/download/26.05"
$ExtractorName = "7zr.exe"
$ExtractorSha256 = "9bf582b894dfa665f852d7e9112b02290a1c303c2d95a21fcdc41ffcb03143b7"
$ArchiveName = "7z2605-extra.7z"
$ArchiveSha256 = "f27a8f103c84785026edcba1f67faf1357225df9d19ddb0b7760d55947141bc7"
$InstallerName = "7z2605-x64.exe"
$InstallerSha256 = "fd99e86f57d8f429ef5ed045bf98315af962e2309b0f1ba87a147a44c71647d0"

$TempRoot = Join-Path $env:TEMP ("willard-official-7zip-" + [guid]::NewGuid().ToString("N"))
$ExtractRoot = Join-Path $TempRoot "extracted"
$ExtractorPath = Join-Path $TempRoot $ExtractorName
$ArchivePath = Join-Path $TempRoot $ArchiveName
$InstallerPath = Join-Path $TempRoot $InstallerName

function Download-And-Verify([string]$Name, [string]$ExpectedHash, [string]$Path) {
  Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseBase/$Name" -OutFile $Path
  $ActualHash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($ActualHash -ne $ExpectedHash) {
    throw "SHA-256 verification failed for $Name. Expected $ExpectedHash; received $ActualHash."
  }
}

try {
  New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $ExtractRoot -Force | Out-Null

  Download-And-Verify $ExtractorName $ExtractorSha256 $ExtractorPath
  Download-And-Verify $ArchiveName $ArchiveSha256 $ArchivePath

  & $ExtractorPath x $ArchivePath "-o$ExtractRoot" -y | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "The pinned 7-Zip extractor could not unpack the official extra archive (exit $LASTEXITCODE)."
  }

  $SevenZipExe = Get-ChildItem -LiteralPath $ExtractRoot -Filter "7z.exe" -File -Recurse | Select-Object -First 1
  $SevenZipDll = Get-ChildItem -LiteralPath $ExtractRoot -Filter "7z.dll" -File -Recurse | Select-Object -First 1

  if (-not $SevenZipExe -or -not $SevenZipDll) {
    Download-And-Verify $InstallerName $InstallerSha256 $InstallerPath
    $InstallRoot = Join-Path $TempRoot "installed"
    New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
    $Installer = Start-Process -FilePath $InstallerPath -ArgumentList @("/S", "/D=$InstallRoot") -Wait -PassThru
    if ($Installer.ExitCode -ne 0) {
      throw "The official 7-Zip installer fallback failed with exit code $($Installer.ExitCode)."
    }
    $SevenZipExe = Get-ChildItem -LiteralPath $InstallRoot -Filter "7z.exe" -File -Recurse | Select-Object -First 1
    $SevenZipDll = Get-ChildItem -LiteralPath $InstallRoot -Filter "7z.dll" -File -Recurse | Select-Object -First 1
  }

  if (-not $SevenZipExe -or -not $SevenZipDll) {
    throw "The official Windows release did not contain both 7z.exe and 7z.dll."
  }

  if (Test-Path -LiteralPath $Destination) {
    Remove-Item -LiteralPath $Destination -Recurse -Force
  }
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  $DestinationExe = Join-Path $Destination "7z.exe"
  Copy-Item -LiteralPath $SevenZipExe.FullName -Destination $DestinationExe -Force
  Copy-Item -LiteralPath $SevenZipDll.FullName -Destination (Join-Path $Destination "7z.dll") -Force

  $VersionText = (& $DestinationExe i 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0 -or $VersionText -notmatch '7-Zip(?: \(z\))? 26\.05') {
    throw "The extracted official Windows binary did not report version 26.05."
  }

  $SourceDir = Join-Path $TempRoot "source"
  $ExtractedDir = Join-Path $TempRoot "verified"
  New-Item -ItemType Directory -Path $SourceDir -Force | Out-Null
  New-Item -ItemType Directory -Path $ExtractedDir -Force | Out-Null
  $PayloadFile = Join-Path $SourceDir "payload.txt"
  Set-Content -LiteralPath $PayloadFile -Value "Willard official 7-Zip smoke test" -NoNewline
  $Archive = Join-Path $TempRoot "smoke.7z"

  & $DestinationExe a -t7z $Archive $PayloadFile -y | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Official 7-Zip archive creation failed." }
  & $DestinationExe x $Archive "-o$ExtractedDir" -y | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Official 7-Zip archive extraction failed." }
  $ExtractedFile = Join-Path $ExtractedDir "payload.txt"
  if (-not (Test-Path -LiteralPath $ExtractedFile -PathType Leaf)) {
    throw "Official 7-Zip smoke archive did not extract its payload."
  }
  if ((Get-Content -LiteralPath $ExtractedFile -Raw) -ne "Willard official 7-Zip smoke test") {
    throw "Official 7-Zip smoke payload content did not match."
  }

  Write-Host "Official 7-Zip 26.05 Windows binary verified and smoke-tested at $DestinationExe"
  if ($env:GITHUB_ENV) {
    "WILLARD_7ZIP_PATH=$DestinationExe" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
  }
} finally {
  Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
