# Compile the staged Windows payload and treat every Inno Setup warning as a release failure.
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Version = if ($env:WILLARD_VERSION) { $env:WILLARD_VERSION } else { "0.1.0" }
$Inno = Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"
$Script = Join-Path $Root "installer\WillardMediaCenter.iss"

if (-not (Test-Path $Inno)) { throw "Install Inno Setup 6, then run this script again." }
if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[\w.-]+)?$') {
  throw "WILLARD_VERSION must be MAJOR.MINOR.PATCH."
}

$output = @(& $Inno "/DMyAppVersion=$Version" $Script 2>&1)
$exitCode = $LASTEXITCODE
$output | ForEach-Object { Write-Host $_ }
if ($exitCode -ne 0) { throw "Inno Setup compilation failed with exit code $exitCode." }

$warnings = @($output | Where-Object { ([string]$_) -match '(?i)\bwarning\b' })
if ($warnings.Count -gt 0) {
  throw ("Inno Setup emitted warnings; release packaging stops on warnings:`n" + ($warnings -join [Environment]::NewLine))
}

$setup = Join-Path $Root "build\installer\WillardMediaCenter-$Version-Setup.exe"
if (-not (Test-Path $setup)) { throw "Installer compilation did not produce $setup." }
if ((Get-Item $setup).Length -le 0) { throw "Installer compilation produced an empty setup executable." }
Write-Host "Installer SHA-256: $((Get-FileHash $setup -Algorithm SHA256).Hash.ToLowerInvariant())"
Write-Host "Installer ready: $setup" -ForegroundColor Green