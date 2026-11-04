# Willard AI — Repository Audit

**Audit date:** 2026-11-04
**Scope:** GitHub-tracked source, project configuration, CI workflows, backend security/privacy, storage boundaries, and Windows release process.

## Executive summary

The repository has a substantial automated validation suite and a documented storage/security architecture. The `Fast validation` workflow passed on the current default-branch commit during this audit. The `Windows release` workflow was still running when inspected; release health is therefore unverified.

A pre-existing draft PR (#1) fixes a privacy-policy inconsistency in saved-search execution: when there is no stored intent, local-only/disabled AI settings now route through the local intent parser instead of the cloud provider. That PR's fast validation run passed. This audit branch is based on that PR branch so the existing fix remains included and `main` is untouched.

## Verified observations

### Positive controls
- Root scripts enforce pnpm, TypeScript project-reference checks, generated API contract parity, router checks, release contracts, storage conformance, and database backup tests.
- Fast Validation runs these checks plus targeted backend regression tests.
- Windows Release provisions a disposable PostgreSQL database, runs the backend audit/integration suite, browser E2E tests, storage conformance, launcher/updater tests, and package/installer validation.
- API startup requires PORT; production startup requires SESSION_SECRET.
- Express session cookies are HTTP-only, use SameSite=Lax, and are marked Secure in production.
- Write requests reject untrusted origins and Sec-Fetch-Site: cross-site.
- Request logs omit query strings; structured log redaction tests cover sensitive paths, filenames, hashes, search queries, and report data.
- NAS-relative paths are canonicalized and checked against symlink/path traversal escapes.
- AI provider calls require explicit enablement and cloud mode; default settings disable provider use and keep AI local-only.
- Generated runtime artifacts and local secrets/backups have .gitignore coverage.

### Release/CI status at audit time
- Fast validation for current main commit 694a055aeb10a41ee8e98f5b776faef89cbd449d: PASSED.
- Windows release for that same commit: IN PROGRESS at inspection time; no completion claim is made.
- Fast validation for pre-existing PR #1 head 7f6085be1812a2b06d1f68df5c459238c469e91a: PASSED.
- PR #1 is still a draft and has not been merged.

## Confirmed issue found and fixed on the audit branch

### Storage migration cleanup could delete a changed original
The cleanup phase verified the destination file against the preview hash but did not verify that the source file still matched that same hash. If the original changed after the copy/verification step but before cleanup confirmation, cleanup could delete the newer source contents. The cleanup path now hashes both source and destination immediately before deletion, preserves the original if its content changed, and revalidates canonical paths against their roots. Regression tests cover changed-source preservation and safe retry after an interrupted cleanup. Cleanup now treats an already-removed original as complete only when its destination still matches the original preview hash. The storage-migration test suite is included in fast validation. A first CI attempt exposed an import-time `DATABASE_URL` dependency in the test path; the database pool is now loaded lazily, and Fast Validation passed on commit `cbca86a6e20a8975bc1d1ccb0ca424e7d20d79bf`.

### Branding upload could destroy the previous logo on replacement failure
The logo upload route deleted the currently referenced logo before writing and committing its replacement. A disk-write or database failure could therefore leave the settings row pointing at a missing file. Uploads now write to a unique, exclusive filename, commit the new database pointer, and only then remove the old file. If the database update fails, the new file is removed and the previous logo remains intact.

### SVG branding responses needed an active-content boundary
Uploaded SVG files are served from the same-origin API. SVG is an active document format, so direct navigation to a crafted uploaded SVG could expose script-capable content. SVG responses now receive a restrictive sandbox Content-Security-Policy, and logo responses include `X-Content-Type-Options: nosniff`. Runtime/browser verification of this response policy remains pending.

The branding-path guard also used lexical path containment, which does not account for a symlink inside the branding directory pointing outside it. The guard now resolves both the branding root and target through the filesystem before allowing reads or deletes, failing closed if resolution fails.

## Follow-up items requiring a runnable environment or deeper review

1. Run the full backend audit locally and inspect every finding, especially database-backed flows and destructive file operations.
2. Review the remainder of authentication/session management and all protected route mounting to verify consistent authentication coverage.
3. Validate Windows ACL behavior and installer/updater operations on a clean standard-user Windows machine; source inspection cannot substitute for this.
4. Review dependency advisories and license compatibility against the lockfile with network-enabled package tooling.
5. Run full Playwright E2E against a clean disposable database and media fixture, including backup/restore, NAS offline/reconnect, and interrupted-job recovery.
6. Review public exposure policy: verify whether the application is intended to be a public repository and ensure no real credentials, personal media, or operational data are present in tracked history.
7. Confirm the intended default for AI local-only behavior and whether existing saved intents are allowed to execute locally (they currently do not require a provider call).

## Change control

- No changes were made to main.
- This audit branch is based on the existing saved-search privacy audit branch.
- No credentials, database records, media files, production settings, or release artifacts were touched.
- Do not merge until the outstanding Windows workflow and any additional runtime tests complete successfully.


## Archive extraction review (2026-11-04)

- Confirmed and fixed a ZIP symlink-detection defect in the organize extraction path. It compared the complete Unix mode field to `0xA000`, which misses normal symlink modes when permission bits are set (for example `0xA1FF`). Both archive catalog inspection and organize extraction now use one shared file-type-mask helper.
- Added regression coverage for symlink modes with and without permission bits, plus a regular-file control case.
- Added the archive-safety regression suite to Fast Validation. It was present in the repository but was not previously executed by that workflow.
- Remaining review item: 7z/RAR/CAB/ISO extraction uses an external extractor and validates the resulting tree afterward. I have not yet established that every supported 7-Zip build suppresses link creation before writing, so this remains a hardening item rather than a claimed exploit or verified fix.
- Existing ZIP safeguards include bounded archive/entry sizes, path and duplicate checks, per-entry CRC/SHA-256 verification, atomic file publication, and final extracted-tree inspection. The configured ZIP buffer limits are intentionally high (1 GiB archive / 512 MiB per entry), so memory headroom should be verified against the intended desktop/server deployment.

## Follow-up archive hardening (2026-11-04)

- Centralized 7-Zip symbolic-link/reparse-point detection and applied it consistently to archive catalog inspection, archive validation, and organize extraction preflight. This closes the gap where the catalog and preflight paths did not reject 7-Zip link entries consistently.
- Added regression cases for Windows link attributes, POSIX symbolic-link permission strings, directories, and regular files.
- Added a hard cap of 66 GiB on decompressed TAR stream bytes for bzip2, xz, and gzip inputs. The decompressor is stopped when the cap is exceeded; scratch TAR filenames are unique per operation, created exclusively with private permissions, and diagnostic stderr is bounded.
- Added a stream-level regression test proving the expansion limiter stops output once the configured cap is exceeded.
- The archive safety suite is now included in Fast Validation. Latest validation for these changes is pending; do not treat the code as CI-verified until the latest run completes.

Remaining hardening: 7-Zip extraction still relies on the external extractor writing only into the fresh staging directory before the resulting tree is inspected. Further runtime testing against supported 7-Zip binaries and representative link-bearing archives is still required.

## Desktop web-server hardening (2026-11-04)

- The installed desktop web server previously relied on lexical path containment for static files. A symlink inside the packaged web root could resolve outside that root. Static file resolution now canonicalizes the root and requested file and rejects targets outside the real root.
- The local API proxy now accepts only origin-form `/api/` requests and verifies that the resolved target retains the configured API origin. Absolute and network-path request targets are rejected.
- Malformed percent-encoded static paths return a client error instead of throwing through the request handler.
- Interrupted proxy requests now close the upstream request, and upstream errors after response headers have been sent destroy the response rather than attempting to send a second response.
- Added desktop web-server safety tests for API target confinement, traversal, and symlink escape. Fast Validation now runs those tests.
- The desktop web-server changes are source-level and unit-testable; an installed Windows runtime/browser smoke test remains outstanding. The API proxy still depends on the API service binding only to loopback as configured by the desktop launcher.


## Windows updater crash recovery (2026-11-04)

- Found a power-loss window in the packaged updater. It writes a `prepared` journal before renaming the installed directory to its rollback backup. If the process stopped after that rename but before writing the next journal phase, startup previously treated `prepared` as an uncommitted update and could leave the installation directory absent.
- Startup recovery now restores the sibling backup when a `prepared` journal exists and that backup is present, as well as for the later `backup-created` and `swapped` phases.
- Extended the Windows installer lifecycle smoke test to simulate the exact interruption point and verify that the prior installation is restored and the abandoned candidate/journal are removed.
- This fix is committed to the audit branch. It still needs the Windows lifecycle workflow to execute against the updated branch; the release workflow is deliberately not triggered from a pull request because it publishes release artifacts.


## Installer upgrade payload consistency (2026-11-04)

- The Inno Setup installer copied the new release over the existing application directory but did not remove files that no longer exist in the new payload. This can leave obsolete JavaScript bundles, modules, or other packaged files behind after an in-place upgrade.
- Added an explicit pre-install cleanup for only the packaged application directories (`desktop`, `web`, `api-runtime`, `runtime`, and `icons`) plus the root version/payload manifests. User configuration, logs, backup-protection credentials, update staging, and recovery state remain under `LOCALAPPDATA` and are not targeted.
- Added a Windows lifecycle regression that plants an obsolete file in the old desktop payload, performs an installer upgrade, and asserts that the stale file is gone while external database and library state remains intact.
- This is source-reviewed but still requires the Windows installer lifecycle workflow to run. It must not be considered runtime-verified until that workflow completes.


## Private media cache policy (2026-11-04)

- Authenticated thumbnail responses were marked `Cache-Control: public, max-age=86400`. That permits shared caches to retain private family-library media and potentially serve it without the original session context.
- Changed thumbnail and original-file stream responses to `Cache-Control: private, no-store` and added `X-Content-Type-Options: nosniff`.
- Centralized the headers and added a focused regression test; Fast Validation now runs it.
- This protects intermediary caches. It does not replace authorization checks, and browser/runtime behavior should still be exercised in the packaged application.
