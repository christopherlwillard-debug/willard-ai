# Willard Media Center Windows installer

This directory contains the Inno Setup definition for the supported install
experience. It is deliberately a thin installer around a staged application
release. The normal release path is the Windows GitHub Action:

1. Push to `main`.
2. The Windows runner automatically builds the web/API payload, downloads the private Node
   runtime, validates the payload, creates the update ZIP and checksum
   manifest, compiles Setup.exe, and publishes all three assets to a GitHub
   release.
3. Download the generated Setup.exe from that release and run it on a Windows
   PC for the first installation test.

First-install checklist:

1. Confirm PostgreSQL 14+ is installed and create an empty database named
   `willard` (or use an existing database).
2. Run `WillardMediaCenter-<version>-Setup.exe` and keep the default install
   location. Leave **Create a desktop shortcut** selected.
3. Confirm both the desktop shortcut and the Start Menu entry show the Willard
   icon.
4. Open the shortcut once. On first run, edit
   `%LOCALAPPDATA%\Willard Media Center\.env` and set `DATABASE_URL`, for
   example `postgresql://postgres:password@localhost:5432/willard`.
5. Open the shortcut again. Confirm database preparation completes, the local
   API becomes ready on port 8080, the web service becomes ready on port 5000,
   and the browser opens to `http://localhost:5000`.
6. Sign in, choose a local Windows/NAS path, and confirm the library starts.
7. Push a newer commit to `main`, wait for the Windows release workflow to
   finish, then open the shortcut again. Confirm the looping loading screen
   appears, the packaged ZIP is checksum-verified, and the installed version
   updates before the app opens.

## Windows trust and SmartScreen acceptance

The disposable Windows runner proves that the installer can be compiled,
signed, verified, installed, and upgraded. It cannot prove what a person sees
on a clean Windows machine: the UAC publisher text and SmartScreen reputation
depend on the machine's trust state and Microsoft's reputation service. Run
this check against the exact `Setup.exe` downloaded from the newly published
GitHub release before calling a release trust-ready.

1. Use a clean, fully updated Windows 10 or Windows 11 VM. Do not install the
   signing certificate, change SmartScreen settings, or use an administrator
   account. Record the Windows edition, build, VM date, release URL, and
   installer SHA-256:

   ```powershell
   $installer = "$env:USERPROFILE\Downloads\WillardMediaCenter-<version>-Setup.exe"
   Get-FileHash $installer -Algorithm SHA256
   ```

2. In **Properties**, check **Details**. **Company**, **Product name**, and
   **Product version** must identify Willard Media Center and the published
   version. Open **Digital Signatures**, select the signature, and confirm
   **Digital Signature Information** reports that the signature is valid.
   Open **View Certificate** and record the signer subject, issuer, validity
   dates, and certification-path status. The signer name must be exactly
   **Willard Media Center**.

3. Before installing, capture the machine-readable trust result as well:

   ```powershell
   $signature = Get-AuthenticodeSignature -FilePath $installer
   $signer = $signature.SignerCertificate
   $timestampSigner = $signature.TimeStamperCertificate
   [pscustomobject]@{
     Status = $signature.Status
     Signer = if ($signer) { $signer.GetNameInfo(
       [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false
     ) } else { $null }
     SignerSubject = if ($signer) { $signer.Subject } else { $null }
     SignerIssuer = if ($signer) { $signer.Issuer } else { $null }
     SignerNotAfter = if ($signer) { $signer.NotAfter } else { $null }
     TimestampSigner = if ($timestampSigner) { $timestampSigner.GetNameInfo(
       [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false
     ) } else { $null }
     TimestampNotAfter = if ($timestampSigner) { $timestampSigner.NotAfter } else { $null }
   } | Format-List
   ```

   `Status` must be `Valid`, `Signer` must be `Willard Media Center`, and a
   timestamp signer must be present with a valid certification path. A
   timestamp that remains valid after the signing certificate expires is
   required; record the timestamp signer and its expiry in the evidence.

4. Start the installer normally, without suppressing dialogs. Record the
   publisher shown in the UAC install prompt. It must be **Willard Media
   Center**. Record the complete SmartScreen result as one of:

   - **No warning**: Windows allowed the installer after the normal UAC prompt.
   - **Reputation warning**: SmartScreen warned that the app is not commonly
     downloaded or from an unrecognized publisher; record the exact message
     and whether **More info → Run anyway** was available.
   - **Blocked**: SmartScreen prevented the run; record the exact message and
     do not bypass it for release acceptance.

5. Add the following evidence to the release record (screenshots may be
   stored privately; never commit certificate private material):

   ```text
   Release/version:
   Release URL:
   Windows edition/build:
   Test date (UTC):
   SHA-256:
   Details publisher/product:
   UAC publisher:
   Authenticode status:
   Signer subject/issuer/expiry:
   Timestamp signer/expiry:
   Certification path:
   SmartScreen result/message:
   Acceptance: PASS / FAIL / BLOCKED
   ```

Do not mark the release **PASS** from CI output alone. If the signer,
timestamp, certificate path, or UAC publisher differs from the expected
values, stop publication and investigate. A new signing certificate may still
produce a reputation warning even when the signature and publisher are valid;
that warning is an observation to record, not evidence that the signature is
broken.

For a developer source folder rather than a packaged release, run
`Setup Willard AI.bat` once. It connects the folder to the public GitHub source
branch, creates desktop and Start Menu shortcuts that point to
`Start Willard AI.bat`, preserves the checkout as the working directory, and
uses the Willard icon when `installer\willard.ico` is present. Future developer
updates use `Update Willard AI.bat`; no manual ZIP download is required.

The developer updater is separate from the packaged updater. Developer updates
use Git and preserve `.env`, logs, PostgreSQL data, and media libraries.
Packaged installations remain self-contained and use checksum-verified release
artifacts without requiring Git.

For a local pre-publication build, run
`powershell -ExecutionPolicy Bypass -File .\scripts\windows\build-installer.ps1`
from a Windows checkout. It creates Setup.exe but does not publish an update
manifest, so it is not an update source for installed copies.

The release workflow runs automatically after a push to `main`. A manual
workflow dispatch remains available when a release needs to be rebuilt with an
explicit version:

1. On a Windows build runner, install the supported Node runtime for the
   release pipeline and set `WILLARD_NODE_RUNTIME` to the directory containing
   `node.exe`. The helper and CI workflow pin Node 24.13.1 and verify the
   downloaded archive against its checked-in SHA-256 before extraction.
2. Run `scripts/windows/make-release.ps1` with `WILLARD_VERSION`,
   `WILLARD_NODE_RUNTIME`, `WILLARD_ARTIFACT_BASE_URL`, and
   `WILLARD_RELEASE_SIGNING_PRIVATE_KEY` configured. The signing key is a
   base64-encoded PKCS#8 Ed25519 private key held only in the CI secret store.
   This stages the payload, creates the update ZIP, and writes a signed
   `release-manifest.json`.
3. Run Inno Setup with `installer/WillardMediaCenter.iss`, passing
   `/DMyAppVersion=MAJOR.MINOR.PATCH` when building a release.
4. Publish the generated installer, packaged update ZIP, developer source
   update ZIP, and `release-manifest.json`. The manifest is bound to this
   repository and the exact product/version/artifact names; installed copies
   reject unsigned, altered, wrong-product, wrong-repository, or redirected
   update metadata before downloading or installing it.

The Windows release workflow also requires these GitHub Actions secrets for the installer:
`WILLARD_WINDOWS_SIGNING_CERTIFICATE_BASE64` must contain a base64-encoded code-signing
PFX that includes its private key, and `WILLARD_WINDOWS_SIGNING_CERTIFICATE_PASSWORD`
must contain that PFX password. The runner imports the PFX into the temporary
current-user certificate store, signs Setup.exe with SHA-256 and a trusted timestamp,
verifies the Authenticode signature and timestamp, then removes the certificate and
temporary PFX before publication. Never commit the certificate or password.

To create the signing key once, run
`openssl genpkey -algorithm ED25519 -out release-signing-private.pem`, export the matching public key in
`desktop/release-contract.mjs`, and store the base64-encoded PKCS#8 private key
as the `WILLARD_RELEASE_SIGNING_PRIVATE_KEY` GitHub Actions secret. Never
commit the private key.

The installer includes the application, API production dependencies, web
output, the bundled Node runtime, and the native launcher. It does not include
PostgreSQL, user media, the database, or FFmpeg. PostgreSQL remains a required
external service because it stores the user's library and authentication data;
FFmpeg remains optional.

Before publishing a release, the Windows pipeline runs the compiled Setup.exe
on a disposable Windows runner as a standard local user. It verifies install,
both shortcuts, first startup against external PostgreSQL, an installer upgrade,
interrupted packaged-version recovery, actionable database-failure diagnostics,
uninstall, and preservation of external database, settings, and media markers.
The runner is intentionally disposable; the first-install checklist above
remains useful for validating a family’s real PostgreSQL and NAS topology.

Trust-validation baseline: the public `v0.1.145` installer published on
2026-08-31 was checked from this Linux workspace. Its SHA-256 was
`ff10d0b80026f4382642dec2e17308fe8926ec98bf4940ece1e1dfd601096638`, and its
PE Authenticode security directory was empty. It is therefore an unsigned
baseline, not a valid clean-Windows trust result; no SmartScreen observation
was recorded for it. The next release published by the signed workflow must
replace this baseline and complete the checklist above.
