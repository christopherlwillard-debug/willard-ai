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

- Found that the previous 7-Zip link guard read the wrong node-7z field. Ordinary `Seven.list` events expose a compact DOS `attributes` value such as `....A`; POSIX mode details such as `A_ lrwxrwxrwx` are in `techInfo.get("Attributes")`, and node-7z only supplies that Map when `techInfo: true` is requested. The old calls did not request technical information, so the existing POSIX-mode unit test did not represent the real event shape.
- All four 7-Zip listing/preflight call sites now request `techInfo: true`. A shared event reader extracts `Attributes`, `Folder`, `Size`, and `CRC` from the Map; link detection checks both ordinary and technical attributes. POSIX symbolic links and Windows reparse-point flags are now rejected before the external extraction pass. The catalog error path also preserves a detected safety error if the listing stream subsequently errors.
- Added regressions matching the documented node-7z event shape: ordinary attributes `....A` plus a technical `A_ lrwxrwxrwx` mode, as well as directory, size, and CRC metadata.
- Added a hard cap of 66 GiB on decompressed TAR stream bytes for bzip2, xz, and gzip inputs. The decompressor is stopped when the cap is exceeded; scratch TAR filenames are unique per operation, created exclusively with private permissions, and diagnostic stderr is bounded. Added a stream-level regression test for the expansion limiter.
- Fast Validation passed on commit `197a32c507932429725bc792d7eda8605e960c0a` (run #211), including typecheck, desktop safety checks, release/storage contracts, and targeted backend regressions. The separate Windows updater smoke job also passed, including journal-write and rollback checks.

Remaining archive hardening:

- 7-Zip extraction still uses an external process and inspects the extracted tree afterward. The preflight now detects the actual technical link metadata, but a Windows runtime test with representative link-bearing and malformed archives is still needed to verify the packaged extractor's behavior end-to-end.
- Historical finding at the initial dependency review: the API server then used `7zip-bin@5.2.0`, whose upstream Linux x64 build script downloaded p7zip 16.02. This dependency was subsequently removed from the API package and pnpm lockfile; it is not a current dependency risk. See the later [legacy 7-Zip dependency resolution](#legacy-7-zip-binary-dependency-risk-resolved-in-audit-branch-2026-11-04).
- The audit did not adopt `7zip-bin-full@26.5.1` because of its roughly 76 MB package size and different binary API. Instead, the application now requires separately staged official 7-Zip 26.01+ binaries and verifies the runtime version; platform staging and compatibility checks are documented below.
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


## Active-content protection for original media (2026-11-04)

- The authenticated original-file stream used the catalog MIME type for inline delivery. The media viewer also exposes an "Open original" link. HTML and SVG can execute active content when navigated as same-origin documents; `X-Content-Type-Options: nosniff` does not neutralize a correctly declared active MIME type.
- Added a strict inline MIME allowlist for the viewer's supported JPEG/PNG/GIF/WebP/AVIF/BMP/TIFF/HEIC/HEIF images, audio, video, and PDF. Other formats—including SVG, HTML, XML, and unknown types—are delivered as `application/octet-stream` with `Content-Disposition: attachment`.
- Added regression coverage for active document MIME types and the supported inline media types.
- Browser-level verification of the download behavior remains outstanding; Fast Validation runs the helper-level policy tests.


## Media rename rollback protection (2026-11-04)

- The media rename route moved the library file first and then updated its catalog row. A database error or a concurrent state change could leave the file at the new path while the catalog continued pointing at the old path.
- Added a rollback-safe helper: if catalog persistence fails or the row is no longer active, it attempts to restore the original filesystem path. If rollback also fails, both errors are preserved for diagnosis rather than silently masking the recovery failure.
- Added tests for database failure, stale/inactive catalog rows, successful rename, rollback failure, and a concurrent new file appearing at the original path. Rollback refuses to overwrite that new file; Fast Validation runs this suite.
- This narrows the filesystem/database inconsistency window. It cannot make a filesystem rename and a database transaction truly atomic; a process or machine crash between the two operations still needs recovery/consistency checks.


## Failed backup publication cleanup (2026-11-04)

- Backup creation atomically renames its staging directory into the visible backup namespace, then performs a final read/decrypt/hash verification. If that post-publication verification failed, the function's cleanup removed the temporary dump and staging path but left the failed final directory behind.
- A failed generation could therefore remain visible to backup discovery/retention as a manifest-bearing directory even though it had not passed the success gate.
- The creator now removes the just-published directory if final verification does not complete. A verified backup is retained even if a later retention operation fails.
- This is a source-level correction; fault-injected end-to-end backup publication testing remains desirable.


## Atomic updater journal publication (2026-11-04)

- The updater rewrote its recovery journal in place with Set-Content. A power loss during that write could leave malformed JSON. Startup treated an unreadable journal as absent, potentially losing the recovery instructions while the previous installation was in its sibling backup directory.
- Journal updates now write a unique temporary file in the same directory and atomically replace the existing journal (or move into place for the first write). A crash leaves the previous complete journal or the new complete journal rather than a partially written document.
- The first Windows journal smoke exposed a runtime compatibility issue: the runner's current .NET rejected a null backup-file argument to `File.Replace`. The writer now supplies a unique same-directory backup path and removes it after replacement. The journal smoke is included in the non-publishing Windows job in Fast Validation; the corrected Windows journal smoke passed in Fast Validation run `41941085454`. No release workflow was run and no release artifacts were published.


## Atomic password reset and session revocation (2026-11-04)

- Password recovery and authenticated password changes updated the credential first and deleted existing sessions in a separate database operation. If session deletion failed, old sessions could remain authenticated after a password reset.
- Both flows now update the password and delete all existing sessions in one PostgreSQL transaction. A failed session deletion rolls back the credential change; concurrent credential changes are detected with a compare-and-swap condition.
- Added targeted source regression assertions. Runtime fault-injection against PostgreSQL remains outstanding.


## Face-crop privacy and stream failure handling (2026-11-04)

- The authenticated face-crop endpoint used `private, max-age=86400`, allowing the browser to retain derived biometric imagery after logout. It now uses the shared `private, no-store` and `nosniff` policy.
- The endpoint piped `createReadStream()` directly to the response without an error listener. If a crop disappeared between the existence check and file open, the asynchronous stream error could become unhandled. The route now logs the failure and returns 404 before headers are sent, or destroys the response if streaming already began.
- Added regression coverage for the shared stream-error response behavior and route wiring. Fast Validation passed on commit `983391cc4d6e618210f93ad37b27ce892d6d8002`.


## Trash retention rejects invalid expiration dates (2026-11-04)

- `purgeExpiredTrashEntries` previously treated an invalid `expiresAt` date as expired because `NaN >= Date.now()` is false. A malformed or edited manifest record could therefore authorize immediate permanent deletion.
- Added `isTrashEntryExpired`, which returns true only for a non-empty, parseable timestamp strictly earlier than the current time. Missing, malformed, and future dates now fail closed and remain in trash.
- Added deterministic regression cases for missing, blank, malformed, future, and elapsed dates. The helper test is database-independent and passed in Fast Validation on commit `983391cc4d6e618210f93ad37b27ce892d6d8002`; full retention/deletion integration remains to be exercised against the disposable test database.


## Authentication session creation race (2026-11-04)

- Confirmed a race between credential verification and session creation. A login could verify the old password, then overlap a password reset that updates the credential and deletes sessions, and finally create a session based on the revoked password.
- A first attempted fix re-read the password hash after saving the session. Further PostgreSQL concurrency analysis found that this recheck alone was not sufficient: under READ COMMITTED, a reset's `DELETE FROM session` statement may take its snapshot before a concurrent login inserts its session, while the login's recheck can still see the old credential before the reset commits.
- Replaced that incomplete approach with a shared row lock. Setup, login, recovery, and password-change flows now start a transaction and select the credential row `FOR SHARE`, verify the expected hash, regenerate and persist the session while the lock is held, and then commit. Password changes update the same credential row before deleting sessions. If login locks first, the password change waits and deletes the saved session afterward; if password change locks first, login waits and sees the new hash before creating a session.
- If session persistence or lock commit fails, the lock is rolled back and the new session is destroyed; stale-session cleanup retries the exact session-row deletion if the session-store callback fails.
- Added unit coverage for lock/save/commit ordering, stale credentials, save failures, commit failures, and cleanup failures. Added route-level assertions and included both auth suites in Fast Validation.
- Validation status: Fast Validation passed on commit `983391cc4d6e618210f93ad37b27ce892d6d8002`, including the row-lock unit tests and auth route assertions. The test suite still does not replace live PostgreSQL concurrency/fault-injection testing.


## Restore operations refuse destination replacement (2026-11-04)

- Manual trash restore checked that the original destination did not exist, then used `renameSync`. On POSIX filesystems a concurrent file creation between those steps could be overwritten. Startup recovery used the same overwrite-capable move helper.
- Added `moveFileNoReplace`: it first attempts an atomic same-volume hard link and falls back to an exclusive copy on filesystems without link support. It never replaces an existing destination. Source-removal failure rolls back only the destination created by this operation; if that rollback fails, both errors are preserved.
- Manual restore, restore rollback, and startup restore reconciliation now use the no-replace helper. Added tests for destination collision preservation, successful moves, and route/recovery wiring. Fast Validation passed on commit `983391cc4d6e618210f93ad37b27ce892d6d8002`.


## Legacy 7-Zip binary dependency risk (resolved in audit branch, 2026-11-04)

- The former `7zip-bin@5.2.0` dependency supplied p7zip 16.02 on Linux. It has been removed from `artifacts/api-server/package.json` and the pnpm lockfile; there is no longer a bundled legacy fallback.
- `resolveSevenZipPath` now accepts only executables reporting official 7-Zip 26.01 or newer. It checks configured, packaged, and PATH candidates; outdated or unrecognized binaries are skipped. `getSevenZipPath` resolves lazily when an archive operation is requested and returns an actionable error if no supported binary is installed, so the API can still start and non-archive features remain available.
- Replit provisions official static 7-Zip 26.05 via `replit.nix`; Windows release builds stage hash-verified official `7z.exe` and `7z.dll` under `api-runtime/vendor/7zip`. The Linux and Windows real-binary compatibility checks passed with the existing `node-7z` wrapper, including listing metadata, CRC, symlink metadata, archive creation, and extraction.
- Fast Validation passed on commit `a9a2a23b36c175cd558148cdc2c3e85c7f5961ac` with the fail-closed resolver, generated contracts, targeted backend regressions, and Windows smoke. Later validation also passed on `ce7ce8e7426f4938e7568ade5885bff87e047f21`.
- Residual limitation: developers and deployments that perform archive operations must install official 7-Zip 26.01+ or configure `WILLARD_7ZIP_PATH`. The application deliberately refuses to use the old vulnerable fallback.


## Invalid 7-Zip overwrite switch (2026-11-04)

- The organize extractor passed `overwrite: "qs"` to `node-7z`, which emits `-aoqs`. The documented 7-Zip switch accepts exactly one mode character (`a`, `s`, `t`, or `u`); the actual 26.05 candidate binary rejected `-aoqs` with `Command Line Error: Too long switch`, so valid 7z-family archive extraction could fail before writing any files.
- Changed the extractor to `overwrite: "a"` (overwrite all) because the staging directory is deliberately cleared and recreated before extraction. This avoids prompts and uses a valid switch. The integration smoke now checks the real CLI path and asserts the application route no longer uses `qs`.
- The first real-binary smoke run failed on the invalid option, confirming the defect. The corrected official 7-Zip 26.05 compatibility test passed on commit `a9a2a23b36c175cd558148cdc2c3e85c7f5961ac`; the Windows binary smoke also passed.


## Dependency-review action fallback (2026-11-04)

- The GitHub `dependency-review-action` was attempted for the audit PR, but GitHub returned `Dependency review is not supported on this repository` because Dependency Graph is disabled. This is a repository setting limitation, not a code or dependency finding.
- The PR workflow inventories all production advisories with `pnpm audit --prod --audit-level low` and enforces a separate `pnpm audit --prod --audit-level high` gate; neither requires GitHub Dependency Graph. Enabling Dependency Graph later would allow richer PR diff review, but is no longer required for the current audit workflow. No repository settings or main-branch changes were made.


## Bounded-memory cleanup of temporary database dumps (2026-11-04)

- Confirmed `secureRemove()` allocated `Buffer.alloc(info.size)` to overwrite temporary PostgreSQL dumps before deletion. For large databases this duplicated the entire dump size in RAM during cleanup and could cause memory exhaustion precisely after backup or restore work.
- Replaced the single full-size allocation with a bounded 1 MiB zero buffer and positional writes that correctly handle partial writes, then syncs and closes the file before removal. The cleanup remains best-effort and does not claim guaranteed secure erasure on SSDs, copy-on-write filesystems, or network storage.
- Added a regression test over a file larger than 2 MiB with deliberately partial writes, asserting memory buffer size remains capped, all bytes are overwritten, and the file handle is synced.
- Fast Validation run `41941085454` passed this bounded-memory cleanup regression in the targeted backend suite.


## Production dependency advisories and patch alignment (2026-11-04)

- The API server's direct Sharp update alone was insufficient: Transformers retained vulnerable Sharp 0.35.2. A workspace-wide Sharp 0.35.5 override now forces the patched release throughout the dependency graph.
- A high-severity Zod memory-exhaustion advisory affected versions below 4.6.6. The workspace Zod catalog is upgraded to 4.6.7 and the mobile zod-validation-error package is aligned to v4.0.2. Full workspace typecheck passed with the Zod v4 change.
- The next advisory inventory found 16 moderate issues. Updated workspace overrides for qs 6.16.1, ip-address 10.7.4, postcss 8.5.23, uuid 11.1.1, glob 14.0.2, minimatch 11.0.1, and the affected brace-expansion ranges removed those moderate advisories from the production dependency graph.
- The regenerated lockfile completed a frozen install and full workspace typecheck. The latest production audit passed its high/critical gate and now reports only one low-severity advisory: deepmerge prototype poisoning in the Expo configuration dependency chain. The advisory currently lists no patched release, so it remains documented rather than forcing an unreviewed fork.
- GitHub Dependency Graph is disabled for this repository, so the PR dependency gate uses pnpm audit instead of GitHub's dependency-review action. The lockfile refresh workflow is restricted to this audit branch; it does not publish releases or modify main.


## PostgreSQL snapshot process failure handling (2026-11-04)

- The backup snapshot holder wrote its SQL to child stdin before registering stdin error handling. If psql exited immediately, a broken-pipe error could be emitted by the writable stream without a listener. The 10-second timeout also sent only SIGTERM and did not guarantee termination if the child remained alive.
- Extracted the process protocol into postgres-snapshot-process.mjs. It registers stdout, stderr, stdin, spawn-error, and close handlers before writing; bounds stdout to 64 KiB and stderr to a 4 KiB tail; handles write callback and stream errors; and escalates from SIGTERM to SIGKILL after a grace period. Termination is idempotent.
- database-backup.mjs now uses the guarded helper. Added regression tests for successful snapshot token capture, stdin EPIPE, and timeout termination/escalation. The tests are included in the existing database-backup test suite. The first CI attempt exposed an escaped-newline error in the success-case fixture (the EPIPE and timeout tests passed); the fixture was corrected in commit 8f8e722. Validation of that corrected fixture passed in run `41941085454`.


## Production dependency audit result (2026-11-04)

- The regenerated dependency graph completed a frozen install and full workspace typecheck. `pnpm audit --prod --audit-level high` passed with only one low advisory remaining; no high, moderate, or critical production advisories remained.
- The high Sharp findings were eliminated by forcing Sharp 0.35.5 across direct and transitive dependency paths. The high Zod memory-exhaustion advisory was eliminated by upgrading the shared Zod catalog to 4.6.7 and aligning `zod-validation-error` to 4.0.2. The full workspace typecheck passed with these versions.
- The dependency refresh workflow completed successfully and regenerated the lockfile. At the time of this entry, the next code validation was pending for the PostgreSQL snapshot process regression suite and official 7-Zip candidate compatibility checks; later completed validation results are recorded below.


## NAS temporary-directory symlink containment (2026-11-04)

- `getTempDir()` previously used recursive directory creation under `<library>/WillardAI/temp/<job>`. That followed existing symlinks and could place temporary archive/media staging outside the configured library.
- Added `ensureDirectoryWithinRoot()` to validate the lexical path beneath the configured root, inspect each existing component with `lstat`, reject symlinks and non-directory components, create one component at a time, recheck after creation, and return the canonical path. The shared `temp` parent and each job directory are created with private mode `0700` on POSIX.
- `getTempDir()` now validates the shared parent before creating a job directory. Tests cover symlink escapes at `WillardAI`, `temp`, and the job directory, in-root cross-job symlink substitution, and private permissions. The first CI run exposed an assertion expecting the wrong error wording; the assertion now matches the fail-closed symlink error. Final validation passed in run `41941085454`.

## Further production dependency patching (2026-11-04)

- The first advisory inventory reported 16 moderate and 1 low findings after the high/critical issues were removed. Updated workspace overrides to patched versions: `qs` 6.16.1, `ip-address` 10.7.4, `postcss` 8.5.23, `brace-expansion` 1.1.21/2.1.7/5.0.12, `uuid` 11.1.1, `glob` 14.0.2, and `minimatch` 11.0.1.
- The regenerated lockfile completed a frozen install and full workspace typecheck. The production audit now reports no critical, high, or moderate advisories; one low advisory remains for `deepmerge` 4.3.1 in the Expo configuration tooling chain. The advisory database lists no patched release. This is documented as a residual low-severity issue rather than forcing an unreviewed fork.
- The `uuid`, `glob`, and `minimatch` overrides cross major versions for transitive Expo tooling. Workspace typecheck and the Expo CLI configuration smoke are required before treating those overrides as runtime-validated.


## Latest integrated validation result (2026-11-04)

- Fast Validation run `41930470325` completed successfully on audit commit `a1d844ce85c7b6d536d5f283ac239d45684fe96a`. Both `validate` and `windows-updater-smoke` jobs passed. This includes workspace typecheck, generated API contract checks, desktop web-server safety tests, database backup and PostgreSQL snapshot process tests, release/storage contracts, NAS temporary-directory symlink tests, targeted backend regressions, official 7-Zip candidate compatibility on Linux, and Windows updater/7-Zip smoke tests.
- The PR dependency-review workflow also passed on the same commit. The separate production dependency refresh workflow previously completed a frozen install, full workspace typecheck, and production audit: no critical, high, or moderate advisories remain; one low `deepmerge` advisory in Expo configuration tooling remains without a patched release.
- Historical deployment review initially found that unprovisioned Linux/macOS and local development could fall back to `7zip-bin@5.2.0`. That risk was subsequently resolved in the later “Remove vulnerable legacy 7-Zip fallback” section: the dependency and lockfile entries were removed, and archive operations now fail closed unless an official 7-Zip 26.01+ binary is available. Replit pins official 7-Zip 26.05, and Windows release staging includes hash-verified official assets at the API resolver path. Remaining usability limitation: archive features are unavailable in an unprovisioned local environment until an official binary is installed; API startup and non-archive features remain available.
- PR #2 remains open and draft against `main`. No merge, production database change, release publication, or main-branch modification occurred.


## NAS temporary-directory symlink boundary (2026-11-04)

- `getTempDir` previously used recursive directory creation under `WillardAI/temp` without checking whether an existing path component was a symlink. A library path could therefore redirect temporary archive/media work outside the configured storage root.
- Added `ensureDirectoryWithinRoot`, which canonicalizes the root and target, checks every existing path component with `lstat`, rejects symlinks and non-directory components, creates missing components one at a time, and returns the canonical path. `getTempDir` now secures the shared temp parent and the per-job directory with private permissions before returning it.
- Added regression tests for a `WillardAI` symlink, `temp` symlink, job-directory symlink, and expected private permissions. Also corrected the organization rollback/reset routes to return a clear 404 when no NAS path is configured. These tests passed as part of Fast Validation on commit `a9a2a23b36c175cd558148cdc2c3e85c7f5961ac`.
- Residual limitation: component-by-component `lstat` and `mkdir` do not provide an OS-level `openat`/directory-handle guarantee against a hostile local process racing the path between checks. This is a substantial improvement against pre-existing symlinks, not a claim of race-free protection against an attacker with write access to the library root.


## Recovery-center status contract and badge typing (2026-11-04)

- The recovery UI added a `rolling_back` state, but the OpenAPI enum and generated API types still omitted it. This caused TypeScript to reject the state comparison even though the backend can return that status. Updated the OpenAPI source and regenerated the React and Zod status types/schemas.
- The recovery card needed badge metadata (`label` and `cls`) while the existing table needed a JSX badge element. Split the pure metadata lookup from the JSX renderer so both callers have the correct types, and added the `preflight` label.
- Fast Validation passed on commit `a9a2a23b36c175cd558148cdc2c3e85c7f5961ac`: TypeScript, API contract codegen/diff, desktop web-server safety, release/storage contracts, official 7-Zip 26.05 Linux compatibility, targeted backend regressions, and the Windows updater smoke job all passed. The run also passed the updated organization execution-claim assertion after adding the durable stage timestamp.

## Official 7-Zip 26.05 compatibility result (2026-11-04)

- Downloaded the official static Linux x64 archive from the upstream 7-Zip release and verified its pinned SHA-256 before executing it. The compatibility test passed with the repository's existing `node-7z` wrapper: version check, archive creation, technical listing metadata, size/CRC parsing, POSIX symbolic-link metadata detection, and extraction.
- The Windows runner independently downloaded and hash-verified official 7-Zip 26.05 assets, then passed create/extract content verification. This validates the official binary on both CI platforms without adopting the third-party `7zip-bin-full` package.
- The official binary is already selected in the packaged Replit and Windows deployment paths. The legacy `7zip-bin` fallback has now been removed entirely; archive operations require a verified official 7-Zip 26.01+ binary and fail with an actionable message when it is unavailable, while API startup and non-archive features remain available. The API package and lockfile no longer include `7zip-bin`.


## Release staging and official 7-Zip destination safety (2026-11-04)

- The Windows release builder recursively deletes and recreates `build/windows`; a symlinked `build` parent or target could redirect destructive cleanup. Release staging now accepts only the canonical `build/windows` path and rejects symlinked/non-directory `build` or target paths before cleanup.
- The official 7-Zip staging script previously removed an existing destination recursively before copying verified binaries. It now requires an empty destination and checks each existing path component for Windows reparse points before writing. A regression smoke deliberately supplies a non-empty destination and verifies the existing marker file remains unchanged.
- Updated release payload tests cover rejection of alternate staging paths and symlinked build roots. Fast Validation passed on commit `ce7ce8e7426f4938e7568ade5885bff87e047f21`, including Linux typecheck/contracts, release/storage checks, official 7-Zip Linux compatibility, targeted backend regressions, and the Windows updater/7-Zip smoke job.

## Archive inspection link-warning gap (resolved in audit branch, 2026-11-04)

- The earlier preview and validation paths did not consistently reject ZIP symbolic links or TAR symbolic/hard links, even though extraction itself was guarded. This could make unsafe archives appear readable until execution.
- Added shared TAR link-entry classification and applied ZIP/TAR link rejection to archive preview, validation, and extraction preflight. Regression tests now exercise link-entry rejection before extraction approval, in addition to existing extraction-time checks.
- The implementation and tests are committed to the audit branch. Fast Validation run `41941085454` passed after the full set of 7-Zip resolver changes; the individual ZIP/TAR test assertions are included in the targeted backend suite.


## Remove vulnerable legacy 7-Zip fallback (2026-11-04)

- The API previously preferred official 7-Zip from `WILLARD_7ZIP_PATH`, the packaged `vendor/7zip` directory, or PATH, but silently fell back to `7zip-bin@5.2.0` when none existed. On Linux this package supplies p7zip 16.02, leaving unprovisioned environments exposed to old archive-parser vulnerabilities.
- Removed the direct `7zip-bin` dependency and its lockfile entries. The resolver now verifies the executable reports official 7-Zip 26.01 or newer before selecting it. Old, missing, or unrecognized executables are skipped. Archive routes resolve the executable lazily and return an actionable error when none is available, so the API itself still starts and non-archive functionality remains usable.
- Replit uses the pinned official static 7-Zip 26.05 derivation; packaged Windows builds stage hash-verified official 7-Zip 26.05 into `api-runtime/vendor/7zip`. CI tests both platforms and `node-7z` compatibility. Resolver regression tests cover configured/system/packaged priority, version rejection, missing-binary behavior, and the actionable error. Fast Validation run `41941085454` passed for this resolver/dependency removal.


## Plaintext database backup temporary-file permissions (2026-11-04)

- `createBackup` wrote the unencrypted `pg_dump` file into a randomly named directory under the OS temp root using recursive `mkdir` with default permissions. On POSIX systems with a permissive umask, that directory could be traversable by other local users while the plaintext dump existed, before encryption and secure cleanup.
- Replaced the manually generated directory with `fs.mkdtemp`, which creates an owner-only work directory on POSIX. The raw dump remains inside that private directory until encryption completes; cleanup behavior is unchanged. Added a regression test that verifies the actual directory mode is `0700` on POSIX. Fast Validation run `41941085454` passed on commit `f5b0f2e`.


## Backup retention authenticates manifests before deleting (2026-11-04)

- `pruneBackups` previously used `createdAt` from a structurally valid manifest to sort and delete old backup directories without checking the manifest's AES-GCM authentication tag. An altered creation date could make a valid backup appear expired and cause automatic retention to delete it.
- Retention now reads, decrypts, and verifies each candidate backup using the configured backup secret before considering its authenticated creation date. Corrupt or tampered backup directories are excluded from retention deletion and preserved for manual inspection.
- Extended the PostgreSQL-backed backup/restore integration test: a copied backup has only its `createdAt` changed to 2000, then retention runs with zero-day retention and `keep=1`. The test requires the tampered backup to remain while the authenticated older backup is pruned. Fast Validation run `41941085454` passed on commit `f5b0f2e`.


## Restore plaintext workspace isolation (2026-11-04)

- Restore decrypted the complete database dump into a randomly named file directly under the shared OS temp directory. The file used mode `0600`, but creation was not exclusive and its parent was shared with unrelated processes.
- Restore now creates a unique owner-only operation directory with `mkdtemp`, writes `database.dump` with exclusive `wx` creation, zeroes the dump during cleanup, and removes the private workspace. This reuses the existing backup workspace helper and avoids introducing another dependency.
- Added a regression assertion for private workspace creation, exclusive file creation, and workspace cleanup. Fast Validation run `41941085454` passed on commit `f5b0f2e`.


## Trash manifest crash safety and symlink containment (2026-11-04)

- Restore/expiry previously rewrote the complete trash manifest through a temporary file. On Windows, replacement fell back to deleting the old manifest before renaming the new one; a crash in that interval could erase unrelated recoverable trash entries.
- Manifest removals now append an authenticated-state-independent tombstone record and leave all prior lines intact. `readTrashManifest` applies tombstones when presenting active entries, preserving idempotent removal while making the journal append-only. Unknown/malformed lines remain untouched.
- Manifest path resolution now creates/checks the logs directory component-by-component under the configured library root and rejects symlinks, preventing manifest writes from following a redirected logs directory.
- Added regression tests for active-entry filtering, retained original journal lines, malformed-line preservation, and external logs-directory symlink rejection. Fast Validation run `41941085454` passed on commit `f5b0f2e`.


## Backup subprocess output and plaintext handling follow-up (2026-11-04)

- Bounded stdout/stderr capture for database backup subprocesses so a noisy or misbehaving PostgreSQL utility cannot grow process memory without limit. Regression coverage exercises oversized stdout and stderr tail retention.
- Restore plaintext is now written only inside a private per-operation workspace, with exclusive file creation, zero-overwrite cleanup, and workspace removal. Decrypted buffers used by backup creation, verification, restore, and discovery are explicitly zero-filled after use.
- The first validation after exporting the bounded subprocess helper exposed a duplicate named export (`runTool` was exported both at declaration and in the export list). Removed the duplicate; Fast Validation run `41941085454` passed.


## Trash entry symlink protection (2026-11-05)

- Trash root directories were already being checked, but individual manifest paths still used a resolver that followed symlinks. A symlink inside `.Trash` pointing at another file inside the trash root could therefore cause restore/removal to act on the target instead of the manifest path.
- Added component-by-component `lstat` resolution for trash paths. It rejects symlinks and non-directory parent components, including links that remain inside the trash root. Manifest insertion, restore reconciliation, purge, and tombstone removal now use this resolver.
- Added a regression test that creates a trash symlink pointing at a different file and verifies removal refuses to follow it and preserves both the target and link. Fast Validation run `41941085454` passed on commit `f5b0f2e`.


## Windows 7-Zip release payload path (2026-11-05)

- The compiled API entry point is `api-runtime/dist/index.mjs`. The resolver resolves `../vendor/7zip` relative to that entry point, so the actual runtime path is `api-runtime/vendor/7zip`. The release builder stages verified official binaries in `deployOutput/vendor/7zip`, which copies to that exact location.
- Added a release-payload contract test that checks the builder staging path and the final API runtime vendor directory against the resolver. The release builder verifies `7z.exe`, `7z.dll`, and `License.txt` are regular files at the final `api-runtime/vendor/7zip` location after copy/merge. The release validator also requires those files and executes the binary to confirm version 26.05.
- Official 7-Zip 26.05 asset SHA-256 values used by the staging scripts were checked against the upstream GitHub release metadata; the Linux x64 archive, Windows extra archive, Windows installer, and 7zr hashes match upstream release digests. Fast Validation run `41941085454` passed on commit `f5b0f2e`.


## Cross-platform ZIP reparse-point and drive-relative path rejection (2026-11-05)

- ZIP preflight previously inspected only the upper 16-bit Unix file mode for symlinks. Windows-created ZIP entries can instead carry `FILE_ATTRIBUTE_REPARSE_POINT` (0x0400) in the lower DOS attribute word; those entries were not rejected by the pre-extraction link check and could reach the extractor before the post-extraction tree inspection.
- ZIP link detection now rejects both Unix `S_IFLNK` modes and the Windows reparse-point attribute. Archive path validation also rejects drive-relative names such as `C:relative.txt`, not only fully-qualified drive paths such as `C:\\outside.txt`.
- Added focused regressions for Windows reparse-point attributes and drive-relative paths. Both passed in Fast Validation run `41941085454`.


## Backup cryptographic key buffer cleanup (2026-11-05)

- AES-256-GCM backup creation and restore derive per-operation keys with scrypt. Those key buffers previously remained allocated until garbage collection after cipher use.
- Encryption and decryption now zero the derived key buffers in `finally` blocks, including authentication failures. Added a regression assertion for both paths. Fast Validation run `41941085454` passed on commit `f5b0f2e`.


## Trash restore paths through symlinked NAS mount aliases (2026-11-05)

- The symlink-safe trash resolver returns a canonical path. When the configured NAS root is itself a symlink alias, the manual restore route passes that canonical path back to tombstone removal; a purely lexical root comparison would reject it and leave a stale active manifest record.
- The resolver now accepts either the configured lexical path or its canonical equivalent only when the configured root itself is a symlink alias. Canonical fallback uses lexical normalization rather than realpath on the requested target, so an outside symlink pointing into the library is still rejected. It checks every descendant component for symlinks. The mount-alias regression exercises both the canonical path returned by the route resolver and an outside symlink attempt.
- Fast Validation run `41941085454` passed on commit `f5b0f2e`.


## Temporary job identifiers cannot escape their child directory (2026-11-05)

- `getTempDir` sanitized job identifiers to letters, digits, dots, underscores, and hyphens, but allowed the exact values `.` and `..`. `path.join(tempRoot, "..")` could therefore return the parent `WillardAI` directory, and an empty ID could return the shared temp root instead of a per-job directory.
- Empty and dot-segment IDs now receive unique generated child names. Added regression coverage verifying empty, `.`, and `..` all resolve to distinct directories directly under `WillardAI/temp`. Fast Validation run `41941085454` passed on commit `f5b0f2e`.


## Windows alternate-stream and reserved archive names (2026-11-05)

- Archive validation rejected drive-qualified paths, but still accepted colon characters in ordinary components such as `photo.jpg:payload`. On NTFS, a colon can address an alternate data stream; Windows also reserves device names such as `CON` and `AUX` and treats trailing dots/spaces specially. These names can behave differently across Linux and Windows extraction targets.
- Archive entry validation now rejects Windows-invalid characters, alternate-stream separators, reserved device names (including COM/LPT aliases), and trailing dots/spaces before any extractor runs. The checks are applied consistently so an archive accepted on Linux remains portable to the Windows desktop runtime.
- Added regressions for ADS names, reserved devices, and trailing dot/space components. Fast Validation run `41941085454` passed on commit `f5b0f2e`.


## Cross-platform archive path portability (2026-11-05)

- Archive paths accepted on POSIX could still be unextractable or ambiguous on Windows: alternate data stream separators (`:`), reserved device names (`CON`, `AUX`, `COM1`, etc.), trailing dots/spaces, and Windows-invalid characters can behave differently after extraction.
- Archive preflight now rejects these Windows-incompatible components for all platforms, so the same archive validation decision is made regardless of the host OS. Regression coverage includes ADS syntax, reserved devices, trailing dot/space, and the portable-path error class.
- Fast Validation run `41941085454` passed on the current audit head, including this follow-up test and path-policy change.


## Integrated validation on 2026-11-05

- Fast Validation run `41939971842` passed on commit `a3e62392773f5aa33dd3338c81d5cb1fdf2ca074`. Both `validate` and `windows-updater-smoke` jobs completed successfully. The Linux job passed workspace typecheck/generated contracts, Expo CLI configuration, desktop web-server safety, release/storage contracts, official static 7-Zip 26.05 download and compatibility with `node-7z`, and the targeted backend regression suite. The Windows job passed hash-verified official 7-Zip staging and updater preservation/rollback smoke tests.
- Dependency review run `41939971796` also passed on that commit.
- The integrated result includes the cleanup manifest fixture corrections, NAS mount-alias restore handling, backup key-buffer zeroization, ZIP reparse-point and drive-relative path checks, and temporary job-ID path containment. Later Windows ADS/reserved-name, control-character, case/Unicode collision, pathless-entry, and NAS temporary-parent tests were added after this commit and are validated by Fast Validation run `41941085454` on `f5b0f2e`.
- The prior targeted backend run `41939454292` had reported 117 passing, 2 skipped, and 2 failing manifest tests. Commit `95bce2a0b0935ed270c12b9572ecb5f28d3d33c7` corrected both fixtures; the targeted suite passed in the integrated run above.

## Trash journal tombstone liveness (2026-11-05)

- The manifest parser previously treated any syntactically valid `REMOVE` record as authoritative, even if the referenced file still existed. A forged or partially written journal append could hide a recoverable file from the trash list and prevent restore.
- The parser now honors a tombstone only when `lstat` confirms the recorded trash path is absent. The removal helper refuses to append a tombstone while the file remains. A regression verifies a forged tombstone cannot hide a live file, that the removal helper refuses it, and that the tombstone becomes effective after the file is actually absent.
- Validation for this follow-up passed in run `41941085454`.


## Cross-platform archive filename collision detection (2026-11-05)

- Archive duplicate detection previously compared normalized names case-sensitively. An archive containing `Photos/Cat.jpg` and `photos/cat.JPG` could pass preflight on Linux but collide on a case-insensitive Windows or macOS filesystem, allowing extraction order to overwrite one entry. Canonically equivalent Unicode names could also alias on common filesystems.
- Duplicate detection now uses NFC-normalized, case-folded collision keys while preserving the original normalized path for extraction. This intentionally enforces portable archive names consistently on all platforms.
- Added regressions for case-only and Unicode-normalization collisions. Fast Validation run `41941085454` passed on commit `f5b0f2e`.


## Cross-platform archive filename collisions (2026-11-05)

- Two distinct paths on a case-sensitive Linux filesystem can collide when the archive is later extracted on a typical case-insensitive Windows/macOS volume. Unicode-composed and decomposed names can also normalize to the same filename on some filesystems.
- Archive path uniqueness now uses NFC normalization plus case folding, rejecting those collisions before extraction. Tests cover both case-only and Unicode-normalization-only collisions.
- Portable filename checks were also tightened to reject ASCII control characters and additional Windows device aliases (`CONIN$`, `CONOUT$`, superscript COM/LPT names, and reserved names with spaces before extensions). Harmless leading `./` archive prefixes remain accepted after normalization. Fast Validation run `41941085454` passed on commit `f5b0f2e`.


## Archive entries without a usable file path (2026-11-05)

- Archive path validation normalized empty, `.` and `./` names to the extraction root. A non-directory entry with no usable filename should never be passed to an extractor because it does not identify a file destination.
- Empty raw names are now rejected, and normalized root-only entries are accepted only when explicitly marked as directories (a common harmless TAR root marker). Added regression coverage for empty/dot file entries and the root-directory case. Fast Validation run `41941085454` passed on commit `f5b0f2e`.


## NAS temporary storage parent permissions (2026-11-05)

- `getTempDir` secured the per-job directory and shared `WillardAI/temp` parent, but an existing `WillardAI` directory with permissive POSIX mode bits could still allow another NAS user to rename or replace the temp parent itself.
- Temporary-directory creation now validates and applies private permissions to the app-managed `WillardAI` root before securing `temp` and the per-job child. Regression coverage checks all three directory levels. On Windows, POSIX mode changes remain best-effort and the configured NAS share's ACL must provide equivalent user-only access; this is still a deployment configuration requirement.
- Fast Validation run `41941085454` passed on commit `f5b0f2e`.


## Latest integrated validation — 2026-11-05

- Fast Validation run [`41946861010`](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41946861010) passed on commit `69a55e3dc37d41b74dc4bc495de60ba96e19b962`. Both Linux `validate` and Windows `windows-archive-and-updater-smoke` succeeded. Linux validation included typecheck/generated contracts, Expo CLI configuration, desktop web-server safety, release/storage contracts, official 7-Zip 26.05 compatibility, archive safety and targeted backend regressions. Windows verified the cross-platform symlink metadata fixture with official 7-Zip 26.05 and `node-7z`, plus updater journal/preservation/rollback behavior.
- Dependency review run [`41941085293`](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41941085293) passed on the same commit.
- This validation includes the Windows-portable archive filename rules (ADS, reserved devices, control characters, trailing dots/spaces, case and Unicode collisions, dot-segment handling, and pathless entries), ZIP Unix/Windows reparse-point rejection, drive-relative path rejection, trash tombstone liveness, NAS mount-alias containment, private temporary-directory parent checks, backup key zeroization, and the earlier authentication/backup regressions.
- Remaining limitations: browser/runtime verification of the uploaded-SVG sandbox CSP is still outstanding. Windows POSIX permission bits are best-effort; the NAS share ACL must restrict the app-managed temporary directories to the service account. The Windows job validates 7-Zip link metadata and updater behavior, but does not yet execute the complete organize route against a malicious Windows archive or validate a packaged installer on a clean end-user machine.
- PR #2 remains open as a draft against `main`, and GitHub reports it mergeable. No main-branch changes, production-data changes, credential changes, or release publication were made.


## Regression fixture corrections confirmed by final validation (2026-11-05)

- Targeted run `41940230121` initially reported 119 passing, 2 skipped, and 2 failing tests. The duplicate-path fixture was updated from an empty path component (`./nested//same.txt`) to the portable harmless-dot form (`./nested/same.txt`); the tombstone fixture was corrected to append a real JSONL newline rather than a literal backslash-n.
- These test-only corrections are in commits `4ea49d1edec4a108d6d9f74e28be068a5de66004` and `49fe5e2497f74bd61ef4c1b32338d72534d5bdd4`. The full targeted backend suite then passed in Fast Validation run `41941085454`.

## Windows-native 7-Zip symlink metadata coverage (2026-11-04)

- Confirmed a validation gap: the official-binary compatibility test created and listed a real symlink archive only on non-Windows hosts (`process.platform !== "win32"`). The Windows smoke job verified ordinary archive creation/extraction and updater behavior, but did not verify that the Windows 7-Zip binary and `node-7z` expose a link entry through the technical `Attributes` Map consumed by the archive preflight.
- The Linux compatibility test now exports its verified symlink-bearing 7z archive as a short-lived CI artifact. The Windows job downloads that fixture and runs the same `node-7z` compatibility test against the hash-verified official Windows 7-Zip 26.05 binary. This avoids depending on Windows symlink-creation privileges while exercising the Windows parser and metadata path.
- The Windows compatibility test lists the fixture only; it does not extract the link-bearing archive. The existing application preflight remains responsible for rejecting links before extraction.
- Fast Validation run [`41946861010`](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41946861010) passed on commit `69a55e3dc37d41b74dc4bc495de60ba96e19b962`. The Linux job created and uploaded the link-bearing fixture; the Windows job hash-verified official 7-Zip 26.05, installed the API server test dependency graph, and passed the same `node-7z` technical-metadata assertion against that fixture. Windows updater journal and rollback smoke tests also passed.
- Remaining limitation: this closes the cross-platform link-metadata test gap only. It does not yet exercise the complete organize route against a malicious Windows reparse-point archive or validate malformed archive behavior on a packaged Windows installation.


## Temporary job identifier sanitization collisions (2026-11-05)

- `getTempDir` sanitized job IDs by replacing unsupported characters with `_` and truncating to 120 characters. Distinct IDs such as `job/one` and `job?one`, or long IDs with the same first 120 characters, therefore mapped to the same per-job staging directory. Concurrent jobs could collide or access each other's temporary files.
- Preserve the readable sanitized prefix but append a deterministic 12-hex SHA-256 suffix whenever the raw ID was changed or truncated. Valid existing IDs retain their previous directory naming. Empty and dot-segment IDs continue to receive unique generated children.
- Added regression tests for punctuation-sanitization collisions and long common-prefix IDs. Fast Validation run [`41946861010`](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41946861010) passed on commit `69a55e3dc37d41b74dc4bc495de60ba96e19b962`, including the targeted `nas-storage-paths.test.ts` suite. These cases ran on Linux; the Windows job focused on 7-Zip metadata and updater behavior. The inspected organize-route callers use lowercase prefixes with parsed integer IDs; case-folding and reserved-name behavior for arbitrary future job IDs remains a portability test gap.


## Integrated Windows archive metadata validation and archive prefix-collision fix (2026-11-05)

- Fast Validation run [#485](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41945225193) passed on commit `f3a8ee5dd0883e9169160356f461d327cf189f3d`. Linux typecheck/generated contracts, desktop and storage checks, official 7-Zip 26.05 hash verification, Linux `node-7z` metadata compatibility, and targeted backend regressions all passed.
- The Windows archive/updater job in the same run completed successfully: official Windows 7-Zip 26.05 staging, cross-platform symlink archive fixture download, Windows `node-7z` technical link-metadata detection, updater journal writes, and updater preservation/rollback smoke all passed. This closes the previously pending Windows metadata-parser validation gap. It still does not run the complete organize route against a malicious archive on Windows or test a packaged installer on a clean end-user machine.
- A further code review found that archive path uniqueness tracked exact normalized names and portable case/Unicode collisions, but did not distinguish files from directories. A regular file named `documents` and a child entry `documents/report.pdf` could both pass preflight even though they cannot coexist on disk; behavior then depended on extractor ordering and could leave a failed staging operation.
- Added separate file-path and directory-path tracking to the archive budget. The preflight now rejects a file used as a parent directory and rejects a file replacing a directory implied by an earlier child, independent of entry order. Explicit directory entries that appear after their child files remain allowed.
- Added focused regressions for both conflicting entry orders and the valid child-before-explicit-directory case. Implementation commit: `a07169f875d3616c5a8035ae456e276d4d9eaba8`; regression-test commit: `4a53b35c51c479c4066d35f8b910bb6422daf808`. The targeted backend regression suite passed in Fast Validation run [`41946861010`](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41946861010) on commit `69a55e3dc37d41b74dc4bc495de60ba96e19b962`.
- Dependency Review run [#249](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41945225196) passed on `f3a8ee5dd0883e9169160356f461d327cf189f3d`. The new archive prefix-collision changes do not modify dependencies.
- Remaining priorities: execute the new prefix-collision regression in Fast Validation; retain the outstanding browser/runtime SVG CSP verification, NAS share ACL confirmation, full Windows organize-route malicious-archive test, and clean-machine installer lifecycle validation.


## Branding logo stream error handling (2026-11-05)

- Confirmed a reliability gap in `GET /settings/logo`: the route piped `fs.createReadStream(settings.logoPath)` directly to the response without an asynchronous error listener. A concurrent logo replacement/deletion or filesystem read failure after the existence check could emit an unhandled stream error; the surrounding route `try/catch` cannot catch that later event.
- Reused the existing private-media stream failure handler. Before response headers are sent, the route returns a specific 404; after headers are sent, it destroys the response with the stream error. The error is also logged.
- Added regression coverage for the route's error listener and the helper's logo-specific not-found response.
- Fast Validation run [`41946861010`](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41946861010) passed on commit `69a55e3dc37d41b74dc4bc495de60ba96e19b962`; Linux targeted regressions and the Windows archive/updater job both succeeded.
- Remaining limitation: this covers the asynchronous stream lifecycle, not a race-free file-handle guarantee against a hostile process replacing a branding path after the realpath check. Browser-level SVG CSP verification remains separate.


## Distinguish missing media from unreadable media (2026-11-05)

- Review of the shared stream-error handler found that every pre-header stream failure was being returned as HTTP 404, including permission errors and I/O failures. That incorrectly represented server-side failures as missing files and could hide storage/ACL problems from monitoring and clients.
- Updated the shared handler to return 404 only for filesystem `ENOENT` and `ENOTDIR`; other pre-header errors return a generic 500. Once headers are sent, the response is still destroyed with the original error to avoid a second response or truncated successful-looking payload.
- Added regression coverage for missing files, logo-specific not-found messaging, permission-denied errors, and post-header stream failure.
- Implementation commit: `04b52bfe9773e4f85db1451891bb6976de228f4f`; tests commit: `be5ca70fb17c015aa2649db757c14d4f82efce82`. Fast Validation run [`41946861010`](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41946861010) passed on commit `69a55e3dc37d41b74dc4bc495de60ba96e19b962`.


## Thumbnail and byte-range stream error consistency (2026-11-05)

- The follow-up stream audit found two related inconsistencies: cached thumbnail delivery returned 404 for every stream failure and ended an already-started response cleanly (potentially making a truncated thumbnail look like a successful response); byte-range media delivery returned 500 even when the underlying file was missing.
- Cached thumbnails now evict the failed cache entry, log the failure, and use the shared media stream handler. Missing paths return 404; permission/I/O failures return 500; failures after headers are sent destroy the response rather than ending it as a successful partial payload.
- Byte-range media delivery now uses the same handler, and its missing-file regression expects 404.
- Regression tests cover thumbnail route wiring and the shared handler's ENOENT/EACCES/post-header behavior.
- Commits: `260b003d08c26a8eb44e7f719b69a5156d52f8ca`, `6c25ed61edc0f826a16d128ed4e9ae38819cd0aa`, `f4f43a1e7852541ab07a836749d3f3a761fc4464`, `65f259f3a0534f948a182922b7566b6c6748bba3`, and `b16814e15267ce4d704a5305b3a7344973817ea7`. Fast Validation run [`41946861010`](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41946861010) passed on commit `69a55e3dc37d41b74dc4bc495de60ba96e19b962`. The first test attempt failed because the thumbnail test looked for `res.destroy` in the route instead of the shared helper; commit `464166eb` corrected the assertion to inspect the helper.


## Branding logo deletion ordering (2026-11-05)

- Confirmed a data-loss path in `DELETE /settings/logo`: the route unlinked the current logo before clearing `appSettingsTable.logoPath`. If the database update failed, the settings row continued pointing at a file that had already been deleted.
- Reordered the operation to clear and verify the database pointer first, then perform best-effort file cleanup. A database failure now preserves the original logo; an unlink failure can leave only an unreferenced orphan.
- Added a regression test that asserts the database pointer update precedes filesystem deletion.
- The route-order regression passed in Fast Validation run [`41946861010`](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41946861010) on commit `69a55e3dc37d41b74dc4bc495de60ba96e19b962`.

## Organization conflict replacement is not rollback-safe (2026-11-05)

- Confirmed a high-priority data-loss risk in both initial execution and resume paths. When `conflictPolicy === "replace"`, `organize.ts` calls `fs.unlinkSync(destFile)` before `verifiedMove` installs and hashes the replacement. If that move/hash fails, or a later file/verification step fails, the catch path calls `rollbackMoves(fileMoves)`; `FileMoveRecord` contains only the new source/destination hashes and `rollbackMoves` has no backup record for the previous destination. The old destination is therefore not restored even though the job reports a rollback.
- Left unchanged because a safe correction requires durable per-file backup intents, crash recovery for the interval between backup/move/checkpoint, and rollback support in both initial and resumed execution. A temporary rename without journaled recovery could strand the only old copy after a process crash; changing `replace` to skip/abort would alter user-visible semantics and needs approval.
- Until that transactional backup design and its crash-recovery tests exist, treat `replace` as unsafe for valuable existing destination files. The default `keep_existing` path is not affected by this finding.


## Explicitly disable 7-Zip symbolic-link materialization (2026-11-05)

- Follow-up review focused on the remaining gap between metadata-based link rejection and actual extraction. The organize route rejected links reported by Seven.list, but Seven.extractFull did not explicitly disable link materialization. That left extraction behavior dependent on the 7-Zip build and archive format if link metadata was incomplete.
- Added the explicit -snl- switch through the documented node-7z $raw option on the organize extraction call. This is defense in depth alongside preflight metadata rejection and the post-extraction lstat tree inspection.
- Added a regression assertion that the real organize route's 7-Zip extraction call passes -snl- and retains an extraction error listener.
- Commits: e811b13b145f73fbea79e1e82678a8940155a141 (implementation) and cf7f16242075d71576f48798671f3a2829504e9f (regression test).
- Fast Validation #515 passed on commit `de8fd173a86bb1dbcadaac0f624ce0ce37792c76`; the follow-up control test in Fast Validation #517 passed on commit `16c3aa9092ce6d21eead71f4764928a0e409401a`. The paired Linux test confirms that a safe symlink is materialized without the switch and is not materialized with the exact `-snl-` switch used by the organize route. Windows symlink-metadata parsing and updater smoke also passed. This still does not replace a full Windows organize-route test with a crafted malicious archive; that remains an explicit validation item.


## Processed archive disposition avoids silent overwrite (2026-11-05)

- Confirmed a data-loss path in both automatic job completion and manual archive disposition: each used `moveFile(job.sourcePath, dest)` for the processed-archive folder. The helper uses rename semantics that can replace an existing destination on POSIX, so two source archives with the same basename could silently overwrite an earlier processed archive.
- Replaced both calls with the existing `moveFileNoReplace` helper. If a processed archive with that basename already exists, the move fails closed and the source archive remains in place.
- Added a route regression asserting both disposition paths use no-replace moves; the helper's existing tests cover the EEXIST/no-overwrite behavior.
- Fast Validation run [#508](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41947582646) passed on commit `2bccbcf815b5bd9797083e7433b92e45900aa6c1`, including the route regression and helper no-overwrite tests. Dependency Review [#272](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41947582831) also passed.



## Prevent concurrent organize jobs from overwriting destinations (2026-11-05)

- Confirmed a cross-job race in the initial and resumed organize paths. They check `fs.existsSync(destFile)` before moving, but separate jobs can both observe an absent destination. The shared `verifiedMove` helper then used `renameSync` semantics through `moveFile`; on POSIX, the later rename can silently replace the first job's completed file.
- A related failure path left an unverified destination behind: `verifiedMove` threw on a post-move hash mismatch/read error before returning its `FileMoveRecord`, so the caller's batch rollback did not include that just-moved file. A later retry could then encounter and keep the unverified destination.
- Updated `verifiedMove` to use the existing exclusive `moveFileNoReplace` helper. A destination created after the route's conflict check now causes the move to fail with EEXIST, preserving both the source and the other job's destination.
- If post-move verification fails after this helper has created the destination, it now attempts a no-replace restoration to the staged source path before rethrowing. If restoration itself fails, an `AggregateError` preserves both errors and leaves the remaining destination in place rather than deleting the only available copy.
- Added focused regressions for a destination appearing between conflict checking and move, and for restoring a hash-mismatch move to staging without leaving an unverified final destination.
- Implementation commit: `2545e195cbfe89d8d2856cc733bfcc67e02f5911`; regression-test commit: `2a728ec97eb02d8ea2be510de48b5ccb21e1d02d`.
- Fast Validation #515 passed on commit `de8fd173a86bb1dbcadaac0f624ce0ce37792c76`; Fast Validation #517 then passed on commit `16c3aa9092ce6d21eead71f4764928a0e409401a` after adding the 7-Zip extraction control test. Workspace typecheck/contracts, release/storage checks, official Linux 7-Zip compatibility, all targeted backend regressions, and the Windows archive/updater smoke job passed. The targeted backend suite reported 138 passed, 0 failed, and 2 skipped. Dependency Review #279 and #281 passed. Earlier run #511 completed the Linux targeted regression step successfully but was canceled by the subsequent branch update before its Windows job.
- Remaining limitation: the existing `conflictPolicy === "replace"` path still deletes the previous destination before a replacement has been safely journaled. Its durable backup/rollback design remains intentionally unmodified and is documented above.


## Fail closed on incomplete folder-source scans (2026-11-05)

- Confirmed a silent-omission correctness issue in the organize folder walker. It caught `readdirSync` failures and returned an empty list for that subtree, and caught per-file `statSync` failures and continued. Analysis and execution could therefore present a partial scan as complete when a NAS subdirectory became unreadable or an entry disappeared during enumeration.
- Moved directory enumeration into the shared organize helper and changed it to fail with the affected path when the root/subdirectory cannot be read or an entry cannot be inspected. Symlinks and special filesystem entries are now rejected explicitly instead of being silently omitted; the walker uses `lstat` so it does not follow file or directory symlinks.
- The route still uses the same file-type mapping and plan structure; only incomplete/ambiguous source scans now fail rather than producing a partial plan.
- Added regressions for nested regular-file enumeration, missing/non-directory roots, symlink rejection, and an unreadable nested directory (the permission test skips only where the runner cannot enforce POSIX mode bits).
- Commits: `fb986e594602a94aa5865f8f4e242b6280dcbbd9` (strict walker), `c748570859b38f1e99f2f203631fc202e62df9c6` (route integration), and `59aaddf790e6b3f0b154ade6507712ed717c0a92` (tests).
- Fast Validation #515 passed on commit `de8fd173a86bb1dbcadaac0f624ce0ce37792c76`, and the follow-up Fast Validation #517 passed on commit `16c3aa9092ce6d21eead71f4764928a0e409401a`. The new nested-file, missing-root, symlink, and unreadable-directory regressions all passed in the targeted backend suite; the complete Linux and Windows workflow jobs also succeeded. The suite total was 138 passed, 0 failed, and 2 skipped.


## Full validation of latest organize reliability fixes (2026-11-05)

- Fast Validation [#517](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41948736075) passed on commit `16c3aa9092ce6d21eead71f4764928a0e409401a`; it includes the additional paired 7-Zip extraction control test. The prior Fast Validation [#515](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41948339444) also passed on the immediately preceding code head. Workspace typecheck/generated contracts, Expo configuration, desktop safety, release/storage contracts, official Linux 7-Zip 26.05 compatibility, and targeted backend regressions all passed.
- The targeted backend test runner reported 138 passed, 0 failed, and 2 skipped. The new regressions specifically passed for concurrent destination no-overwrite, hash-mismatch restoration, nested directory enumeration, missing/non-directory roots, symlink rejection, and unreadable nested directories.
- The Windows archive/updater job in Fast Validation #517 passed: official Windows 7-Zip 26.05 hash-verified staging, cross-platform symlink metadata parsing, updater journal writes, and updater preservation/rollback. The paired symlink materialization control is run on Linux because the Windows runner does not have guaranteed symlink-creation privileges.
- Dependency Review [#281](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41948736057) passed on the same code head. Dependency Review #279 passed on the immediately preceding code head.
- This validates the new helper and route changes on the CI platforms. It does not close the separate conflictPolicy=replace backup/rollback issue, the full malicious Windows organize-route integration test, the browser/runtime SVG CSP check, NAS share ACL confirmation, or clean-machine installer lifecycle testing.


## 7-Zip extraction-switch control test (2026-11-05)

- Review of the existing compatibility regression found that it only asserted that extraction with `-snl-` did not produce a symlink. That did not prove the switch was responsible; the binary's default security behavior could have produced the same result.
- Added a paired control using the same safe relative symlink archive: extraction without `-snl-` must materialize the symlink, while extraction with `-snl-` must not. This tests the exact switch passed by the organize route against the verified official binary.
- The paired test passed with official Linux 7-Zip 26.05 in Fast Validation [#517](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41948736075). The complete Fast Validation run, including the Windows archive/updater job, passed. Dependency Review [#281](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41948736057) passed.
- Test commit: `16c3aa9092ce6d21eead71f4764928a0e409401a`.
- Remaining limitation: Windows CI verifies symlink metadata parsing and updater behavior, but it still does not run the complete organize route against a crafted malicious archive on Windows. The Linux paired control proves the switch behavior on the official Linux 26.05 binary, not every Windows archive-format combination.
