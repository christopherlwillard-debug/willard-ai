# Windows Final Release Checklist

This checklist is intentionally **not an execution plan for the current
development cycle**. Do not run the Windows-only items below until the owner
explicitly authorizes one final Windows release validation.

The active Windows release run was cancelled after the hosted runner exposed
several environment-specific fixture problems. The fixes currently pushed to
`main` are preserved. Until final authorization, use the inexpensive Linux
validation workflow for development.

## Final authorization prerequisites

- [ ] Linux fast validation is green on the exact commit selected for release.
- [ ] Local-drive and NAS reliability work is complete, including startup,
      scanning, thumbnails, ZIP extraction, metadata persistence, and recovery
      after replacing the computer.
- [ ] The release commit and version are frozen; no exploratory fixes are
      planned during the Windows run.
- [ ] The owner explicitly authorizes the single final Windows release run.

## Windows environment and backend gates

- [ ] Provision the pinned portable PostgreSQL archive and verify its SHA-256.
- [ ] Initialize PostgreSQL, start it with `pg_ctl`, and confirm readiness with
      `pg_isready`.
- [ ] Bootstrap the disposable application schema and seed the isolated test
      settings.
- [ ] Install and verify the backend fixture tools (`ffmpeg` and `zip`).
- [ ] Confirm test-only capacity overrides are passed only to the disposable
      API process; production storage floors remain at the 4 GiB policy.
- [ ] Run the complete API backend audit with per-test timeout and heartbeat.
- [ ] Confirm the backend audit runs workspace E2E children from the repository
      root so `test-media` and other fixture paths resolve correctly.
- [ ] Confirm the cleanup E2E suite completes and exits cleanly, including:
      cleanup history, duplicate recycling, rescan behavior, ZIP/TAR handling,
      traversal rejection, and empty/missing NAS behavior.
- [ ] Confirm the dashboard-after-scan E2E suite completes and restores the
      original NAS setting.
- [ ] Confirm the Windows `psql` fixture query uses named options and cannot
      hang on positional-argument parsing.
- [ ] Confirm PostgreSQL and API processes are shut down without orphaned
      processes or unhandled pool errors.

## Browser, storage, and launcher gates

- [ ] Install/restore the cached Chromium tool and run all browser E2E suites.
- [ ] Run storage-policy conformance against the release tree.
- [ ] Run the source launcher startup/failure-diagnostics smoke test.
- [ ] Run the developer one-click updater smoke test, including verified
      fallback and rollback behavior.
- [ ] Verify the bundled Windows Node runtime is restored or downloaded and
      matches the release manifest.

## Packaging and installer gates

- [ ] Choose the release version without overwriting an existing release.
- [ ] Build and validate the release payload, including dependency/image-parser
      audit checks.
- [ ] Confirm the staged payload excludes workspace lockfiles, package-manager
      metadata, and non-Windows native dependencies.
- [ ] Confirm the staged payload contains the bundled Node runtime, API/server
      entrypoints, launcher, manifest, checksums, and required assets.
- [ ] Install Inno Setup and compile the versioned installer with warnings
      treated as failures.
- [ ] Verify the installer creates Start Menu and desktop shortcuts that invoke
      the native launcher, not source scripts.
- [ ] Run the installed lifecycle smoke test with an external PostgreSQL
      service, including first start, API/web readiness, database setup,
      restart, and failure diagnostics.

## Publication and download verification

- [ ] Publish the signed versioned `WillardMediaCenter-<version>-Setup.exe`.
- [ ] Publish the matching update ZIP, source archive, and release manifest.
- [ ] Verify the GitHub release contains all four expected assets.
- [ ] Download the `*-Setup.exe` asset from its GitHub release URL and verify
      its checksum.
- [ ] Install the downloaded executable on a clean Windows laptop or VM.
- [ ] Launch from the installed shortcut without opening a source folder or
      manually starting localhost services.
- [ ] Verify the installed application can use a local hard drive and a NAS
      path, then scan, browse thumbnails, persist metadata, and recover after
      restart.
- [ ] Record the direct GitHub release/installer URL and concise install/start
      instructions for the user.

## Current Linux-only development loop

Use the existing `Fast validation` workflow for normal pushes and pull
requests. Keep local checks focused on the changed reliability path, such as:

- `pnpm run typecheck`
- `pnpm run check:router`
- `pnpm run check:api-contracts`
- `pnpm run test:storage-conformance`
- the relevant API unit/integration test workflow

Do not dispatch `Windows release` while this checklist is being prepared or
while reliability work is still in progress.