# Compile the staged Windows payload and treat every Inno Setup warning as a release failure.
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Version = if ($env:WILLARD_VERSION) { $env:WILLARD_VERSION } else { "0.1.0" }
$ExpectedPublisher = "Willard Media Center"
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

$warnings = @($output | Where-Object {
  ([string]$_) -match '(?i)^\s*\*{0,3}\s*warning\s*:'
})
if ($warnings.Count -gt 0) {
  throw ("Inno Setup emitted warnings; release packaging stops on warnings:`n" + ($warnings -join [Environment]::NewLine))
}

$setup = Join-Path $Root "build\installer\WillardMediaCenter-$Version-Setup.exe"
if (-not (Test-Path $setup)) { throw "Installer compilation did not produce $setup." }
if ((Get-Item $setup).Length -le 0) { throw "Installer compilation produced an empty setup executable." }
$versionInfo = (Get-Item $setup).VersionInfo
if ($versionInfo.CompanyName -ne $ExpectedPublisher) {
  throw "Installer publisher metadata was '$($versionInfo.CompanyName)', expected '$ExpectedPublisher'."
}
if ($versionInfo.ProductName -ne $ExpectedPublisher) {
  throw "Installer product metadata was '$($versionInfo.ProductName)', expected '$ExpectedPublisher'."
}
Write-Host "Installer publisher metadata: $($versionInfo.CompanyName)"
Write-Host "Installer SHA-256: $((Get-FileHash $setup -Algorithm SHA256).Hash.ToLowerInvariant())"

function Find-SignTool {
  $onPath = Get-Command "signtool.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($onPath) { return $onPath.Source }

  $windowsKits = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  if (Test-Path $windowsKits) {
    $candidate = Get-ChildItem -Path $windowsKits -Filter "signtool.exe" -File -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match "\\x64\\signtool\.exe$" } |
      Sort-Object FullName -Descending |
      Select-Object -First 1
    if ($candidate) { return $candidate.FullName }
  }

  return $null
}

$certificateBase64 = $env:WILLARD_WINDOWS_SIGNING_CERTIFICATE_BASE64
$certificatePassword = $env:WILLARD_WINDOWS_SIGNING_CERTIFICATE_PASSWORD
$signingRequired = $env:WILLARD_REQUIRE_WINDOWS_SIGNING -eq "true"
$signingRequested = $signingRequired -or
  -not [string]::IsNullOrWhiteSpace($certificateBase64) -or
  -not [string]::IsNullOrWhiteSpace($certificatePassword)

if ($signingRequested) {
  if ([string]::IsNullOrWhiteSpace($certificateBase64)) {
    throw "WILLARD_WINDOWS_SIGNING_CERTIFICATE_BASE64 is required for a signed installer."
  }
  if ([string]::IsNullOrWhiteSpace($certificatePassword)) {
    throw "WILLARD_WINDOWS_SIGNING_CERTIFICATE_PASSWORD is required for a signed installer."
  }

  $tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } elseif ($env:TEMP) { $env:TEMP } else { [IO.Path]::GetTempPath() }
  $certificatePath = Join-Path $tempRoot ("willard-media-center-signing-{0}.pfx" -f ([guid]::NewGuid().ToString("N")))
  $certificateThumbprint = $null
  $certificateStoreThumbprintsBefore = @()
  $certificateStoreSnapshotSucceeded = $false
  $importedCertificateThumbprints = @()
  try {
    try {
      $certificateBytes = [Convert]::FromBase64String(($certificateBase64 -replace "\s", ""))
    } catch {
      throw "WILLARD_WINDOWS_SIGNING_CERTIFICATE_BASE64 is not valid base64."
    }
    if ($certificateBytes.Length -eq 0) {
      throw "WILLARD_WINDOWS_SIGNING_CERTIFICATE_BASE64 decoded to an empty certificate."
    }
    [IO.File]::WriteAllBytes($certificatePath, $certificateBytes)

    $securePassword = ConvertTo-SecureString $certificatePassword -AsPlainText -Force
    $certificateStoreThumbprintsBefore = @(
      Get-ChildItem -Path "Cert:\CurrentUser\My" |
        ForEach-Object { [string]$_.Thumbprint } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
    $certificateStoreSnapshotSucceeded = $true
    $importedCertificates = @(Import-PfxCertificate `
      -FilePath $certificatePath `
      -Password $securePassword `
      -CertStoreLocation "Cert:\CurrentUser\My")
    $importedCertificateThumbprints = @(
      $importedCertificates |
        ForEach-Object { [string]$_.Thumbprint } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        Sort-Object -Unique
    )
    if ($importedCertificateThumbprints.Count -eq 0) {
      throw "The code-signing certificate could not be imported into the current-user certificate store."
    }
    $codeSigningOid = "1.3.6.1.5.5.7.3.3"
    $signingCertificates = @(
      $importedCertificates | Where-Object {
        $candidate = $_
        $candidate.HasPrivateKey -and
          @($candidate.EnhancedKeyUsageList | Where-Object {
            $_.ObjectId.Value -eq $codeSigningOid
          }).Count -gt 0
      }
    )
    if ($signingCertificates.Count -ne 1) {
      throw "The PFX must contain exactly one private-key certificate with the code-signing enhanced key usage."
    }
    $certificateThumbprint = [string]$signingCertificates[0].Thumbprint

    $signTool = Find-SignTool
    if (-not $signTool) {
      throw "signtool.exe was not found on PATH or in the Windows 10 SDK."
    }
    $timestampUrl = if ($env:WILLARD_WINDOWS_SIGNING_TIMESTAMP_URL) {
      $env:WILLARD_WINDOWS_SIGNING_TIMESTAMP_URL
    } else {
      "http://timestamp.digicert.com"
    }

    & $signTool sign "/fd" "SHA256" "/td" "SHA256" "/tr" $timestampUrl `
      "/sha1" $certificateThumbprint "/d" "Willard Media Center" $setup
    if ($LASTEXITCODE -ne 0) {
      throw "signtool.exe failed to sign the installer with exit code $LASTEXITCODE."
    }

    & $signTool verify "/pa" "/all" "/tw" $setup
    if ($LASTEXITCODE -ne 0) {
      throw "signtool.exe could not verify the Authenticode signature on the installer."
    }
    $signature = Get-AuthenticodeSignature -FilePath $setup
    if ($signature.Status -ne "Valid") {
      throw "The installer Authenticode signature status was $($signature.Status), not Valid."
    }
    if (-not $signature.SignerCertificate) {
      throw "The installer did not contain a signer certificate."
    }
    if (-not $signature.TimeStamperCertificate) {
      throw "The installer signature did not contain a trusted timestamp."
    }
    $signerPublisher = $signature.SignerCertificate.GetNameInfo(
      [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
      $false
    )
    if ($signerPublisher -ne $ExpectedPublisher) {
      throw "Installer signer publisher was '$signerPublisher', expected '$ExpectedPublisher'."
    }
    Write-Host "Installer signer publisher: $signerPublisher"
    Write-Host "Installer timestamp signer: $($signature.TimeStamperCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false))"
    Write-Host "Installer Authenticode signature verified." -ForegroundColor Green
  } finally {
    if ($certificateStoreSnapshotSucceeded -and $importedCertificateThumbprints.Count -gt 0) {
      $currentCertificateThumbprints = @(
        Get-ChildItem -Path "Cert:\CurrentUser\My" |
          ForEach-Object { [string]$_.Thumbprint } |
          Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
      )
      $introducedCertificateThumbprints = @(
        $currentCertificateThumbprints | Where-Object {
          $certificateStoreThumbprintsBefore -notcontains $_
        }
      )
      $certificateThumbprintsToRemove = @(
        $importedCertificateThumbprints |
          Where-Object { $introducedCertificateThumbprints -contains $_ } |
          Sort-Object -Unique
      )
      foreach ($thumbprint in $certificateThumbprintsToRemove) {
        $certificateStorePath = "Cert:\CurrentUser\My\$thumbprint"
        if (Test-Path -LiteralPath $certificateStorePath) {
          Remove-Item -LiteralPath $certificateStorePath -Force -ErrorAction Stop
        }
        if (Test-Path -LiteralPath $certificateStorePath) {
          throw "A temporary code-signing certificate could not be removed from the current-user store."
        }
      }
    }
    if (Test-Path -LiteralPath $certificatePath) {
      Remove-Item -LiteralPath $certificatePath -Force -ErrorAction Stop
      if (Test-Path -LiteralPath $certificatePath) {
        throw "The temporary code-signing certificate file could not be removed."
      }
    }
  }
} else {
  Write-Host "Installer signing skipped for this local build; CI release builds require signing."
}

Write-Host "Installer ready: $setup" -ForegroundColor Green