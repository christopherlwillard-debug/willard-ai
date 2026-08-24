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
