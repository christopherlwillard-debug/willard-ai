# Willard Media Center Windows installer

This directory contains the Inno Setup definition for the supported install
experience. It is deliberately a thin installer around a staged application
release. The normal release path is the Windows GitHub Action:

1. Push to `main`.
2. The Windows runner builds the web/API payload, downloads the private Node
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
7. Publish a newer release, open the shortcut again, and confirm the ZIP is
   checksum-verified and the installed version updates.

For a source checkout rather than a packaged release, run `Setup Willard AI.bat`
once. It creates desktop and Start Menu shortcuts that point to
`Start Willard AI.bat`, preserve the checkout as the working directory, and use
the Willard icon when `installer\willard.ico` is present.

For a local pre-publication build, run
`powershell -ExecutionPolicy Bypass -File .\scripts\windows\build-installer.ps1`
from a Windows checkout. It creates Setup.exe but does not publish an update
manifest, so it is not an update source for installed copies.

The manual release steps performed by the action are:

1. On a Windows build runner, install the supported Node runtime for the
   release pipeline and set `WILLARD_NODE_RUNTIME` to the directory containing
   `node.exe`.
2. Run `scripts/windows/make-release.ps1` with `WILLARD_VERSION`,
   `WILLARD_NODE_RUNTIME`, and `WILLARD_ARTIFACT_BASE_URL` configured. This
   stages the payload, creates the update ZIP, and writes a checksum-bearing
   `release-manifest.json`.
3. Run Inno Setup with `installer/WillardMediaCenter.iss`, passing
   `/DMyAppVersion=MAJOR.MINOR.PATCH` when building a release.
4. Publish the generated installer, update ZIP, and
   `release-manifest.json` containing `version`, `artifactUrl`, and the
   SHA-256 of the ZIP.

The installer includes the application, API production dependencies, web
output, the bundled Node runtime, and the native launcher. It does not include
PostgreSQL, user media, the database, or FFmpeg. PostgreSQL remains a required
external service because it stores the user's library and authentication data;
FFmpeg remains optional.

The single remaining Windows-side action for the first real test is to run the
published Setup.exe on Windows and verify installation, both shortcuts, startup,
database setup, and one update from a newer published release. Inno Setup,
code signing, and real Windows install/upgrade validation cannot be completed
inside Replit's Linux environment.
