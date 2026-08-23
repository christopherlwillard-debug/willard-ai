# Willard Media Center Windows installer

This directory contains the Inno Setup definition for the supported install
experience. It is deliberately a thin installer around a staged application
release:

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

Inno Setup is not available in the current Linux/Replit environment, so
compiling, signing, installing, upgrading, and uninstalling the final `.exe`
must be validated on a Windows build runner before release.
