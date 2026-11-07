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

- Confirmed a high-priority data-loss risk in the original implementation: `conflictPolicy === "replace"` deleted an existing destination before the replacement was durably journaled and verified. The old destination could not be restored after a failed move or process crash.
- **Mitigation confirmed on 2026-11-06:** both execute and resume now reject Replace collisions with an explicit no-files-changed error. The Organize UI disables the Replace option. `organize-replace-safety.test.ts` asserts both route guards and the disabled UI control.
- **Current status:** the destructive Replace path is blocked, not repaired. The user-facing Replace feature remains unavailable until a durable displaced-file backup intent, crash recovery, and rollback state machine is implemented and tested. The active route no longer deletes an existing destination under this policy.
- The default `keep_existing` path is not affected by the historical finding.
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

## Organization worker lease is not fenced against stale workers (2026-11-04; historical finding superseded)

- The original source finding was valid: workers shared status and heartbeat timestamps without a unique owner token, allowing stale heartbeat and checkpoint writes to overwrite a replacement worker's state.
- **Superseded by the 2026-11-06 high-severity follow-up** at the later section titled `2026-11-06 high-severity follow-up — organization workers lacked durable ownership fencing`. The current implementation has a nullable `lease_token`, unique tokens for execute/resume/rollback, token-conditional heartbeat/stage/journal/terminal writes, and ownership callbacks around verified moves and rollback mutations.
- **Remaining status:** implementation and source regressions are committed; runtime multi-process takeover, database-loss, Windows, and SMB validation remain pending. A database check immediately before a filesystem mutation is not an atomic filesystem fence; preserve the documented residual check-to-mutation and crash windows until those integration tests prove the supported behavior.
## Rollback success now requires checksum verification (2026-11-05)

- Found that `rollbackMoves` incremented its success count immediately after moving a file back to its source, then merely logged a checksum mismatch. The rollback endpoint uses that count to decide whether to mark the whole job `rolled_back`; a corrupted or externally modified file could therefore be reported as successfully recovered.
- Changed rollback to hash the destination against the journaled original SHA-256 before moving it. A mismatch is left at the destination and is not counted as restored.
- After moving, rollback hashes the restored source again and increments the success count only on an exact match. If bytes change between the preflight hash and the move, it attempts to return the unverified file to its destination and leaves the move incomplete. If that preservation move fails, it logs the failure and still does not claim success.
- Added a regression that tampers with the destination after the forward move and verifies rollback preserves that only remaining copy, returns zero successful restores, and records a verification failure.
- Implementation commit: `b2a8ad536c3eb9e533608d8d2b08bf0074bdc72a`; regression commit: `c27feace4476472d34b7282416ccea68b9b234bf`.
- Validation: Fast Validation #699 (run 42018392739) passed overall; the checksum-verified rollback regression in organize-helpers.test.ts passed. Dependency Review #463 (run 42018392979) passed. This closes the false-success accounting defect; it does not resolve the separate conflictPolicy=replace backup/rollback risk or the stale-worker fencing issue.


## Execute rollback status and journal-checkpoint correction (2026-11-05)

- Follow-up inspection found the normal execute route marked a job `rolled_back` unconditionally after an error, even when `rollbackMoves` reported fewer restored files than the move journal contained. This contradicted the recovery endpoint's stricter behavior and could hide incomplete recovery.
- The execute failure path now marks the job `rolled_back` only when every journaled move was restored and checksum-verified; otherwise it marks the job `failed` and records the incomplete count plus a manual-recovery warning.
- The per-file journal checkpoint is now fail-closed. If the database cannot persist the move journal, execution throws into the rollback path rather than continuing to move additional files without durable recovery records.
- Added source regression coverage for conditional rollback status and fail-closed checkpoint behavior.
- Commits: route fix `f4903220b3af5725231fbf26371a980834c06e61`; regression `3779ca4f331cb511bab6c7d539609e31b5fb955b`.
- Validation: Fast Validation #699 (run 42018392739) passed; the organization execute rollback-incomplete regression passed. The pre-move journaling window and stale-worker fencing still require a separate durable ownership/journal design; this correction prevents continued unjournaled moves after a detected checkpoint failure but does not eliminate a process crash between filesystem mutation and its post-move journal write.


## Resume recovery journal retention (2026-11-05)

- Extended the fail-closed checkpoint behavior to the resume route. A failed per-file journal write now aborts the resume pass and enters its rollback path instead of continuing to mutate files.
- Found that the resume failure handler unconditionally reset the persisted journal to the pre-resume `existingMoves`, even if one or more new moves could not be restored. It now discards the resume-pass entries only when every new move was checksum-verified as restored; otherwise it retains the complete journal and explicitly reports that manual recovery is required.
- Added regression coverage for incomplete-resume journal retention and fail-closed resume checkpointing.
- Commits: route `00bac4bf1946d4237a172d6b5f1c6efad2a88d4c`; regression `c2132abae83f8e62eb2f7a824e60a6f5edbe8fab`.
- Validation: Fast Validation #699 (run 42018392739) passed; the organization resume rollback-incomplete regression passed. The broader pre-move journal-intent and worker-fencing gaps remain open.


## Final destination checksum verification (2026-11-05)

- Found that both execute and resume performed a final existence-only check. A file could pass the immediate post-move SHA-256 check, be modified before the job's completion boundary, and still be included in a completed report because the stored `verified` flag was trusted without re-reading the destination.
- Both completion paths now stream-hash every destination against its journaled `sourceHash` immediately before marking the job completed. Missing files and checksum mismatches fail the operation; resume reports only the files actually re-hashed successfully.
- Added regression coverage asserting both production completion paths perform the final destination hash comparison.
- Commits: route `e29c794ceeeff2a2f97ed1202cec70c637a24078`; regression `d4c1ec630f63670bf916f014ff9e3267fed05c30`.
- Fast Validation passed on commit `cb02c4a4fd6e6a4d8322ab23b796794bb49bce97`. This detects changes before the completion boundary; it cannot prevent a separate actor from modifying a file after the job has completed.


## NAS temporary cleanup refuses symlink redirection (2026-11-05)

- `getTempDir` now creates private NAS-scoped per-job directories and rejects symlinked path components. A separate review found that `cleanTempDir` still recursively removed the caller-provided path without checking its relationship to the NAS root. If a temp parent or job path were replaced with a symlink between creation and cleanup, recursive cleanup could follow the changed parent path and remove data outside the intended job directory.
- `cleanTempDir` now requires the configured NAS root, accepts only a direct child of that root's `WillardAI/temp` directory, and checks each path component with `lstat` immediately before removal. Symlinked parents and targets are left untouched. All organize route cleanup sites pass the NAS root.
- Added tests for ordinary cleanup, a replaced temp-parent symlink, and a job-directory symlink. Fast Validation passed on commit `53bb575796f69026a9e91e02a4e8ba83c3113ea5`: TypeScript typecheck, targeted backend regressions, release/storage contracts, and Windows checks all passed. The NAS temp path and cleanup test suite passed on both Linux and Windows; the Windows job also passed official 7-Zip 26.05 metadata compatibility, updater journal, and developer update rollback smoke tests. Real NAS/SMB ACL and concurrent-user behavior still require installed-environment verification.
- This is defense in depth, not a complete defense against a hostile process running as the same OS account and racing filesystem operations. Private directory permissions reduce that exposure on POSIX; Windows ACL behavior requires installed-runtime verification.


## Organization reset preserves incomplete move journals (2026-11-05)

- The Recovery Center reset endpoint accepted failed or stale-executing jobs and set `fileMoves` to null. If a prior move or rollback was incomplete, this erased the only durable list of source/destination paths and checksums needed to recover the files. A reset could then re-run the plan without acknowledging files still moved or modified.
- Reset now refuses jobs with any non-empty or malformed move journal and directs the user to resume or complete rollback first. The SQL update also compare-and-swaps the journal to null or an empty JSON array, so a concurrent worker cannot add move records between the route's read and the reset update and have them silently cleared.
- Added a regression test for both the user-facing guard and database-side empty-journal predicate. The regression passed in Fast Validation on commit `53bb575796f69026a9e91e02a4e8ba83c3113ea5`.


## Recovery routes validate persisted move journals (2026-11-05)

- A second pass through Recovery Center found that rollback and resume treated any non-array `fileMoves` value as an empty list. Rollback could therefore report success without restoring anything; resume could proceed without the prior move history. Persisted journal entries were also cast directly to `FileMoveRecord[]` without checking path scope or integrity fields.
- Added `parseOrganizationMoveJournal` before rollback and resume claim filesystem work. It rejects malformed journals, non-absolute paths, paths outside the configured NAS, missing/invalid SHA-256 values, mismatched source/destination hashes, and records not marked verified. It returns typed records only after validation.
- Added regression assertions that both recovery routes use the validator and that its path/hash checks remain in place. The tests and TypeScript typecheck passed in Fast Validation on commit `53bb575796f69026a9e91e02a4e8ba83c3113ea5`.

## Storage migration concurrent-copy race and destination overwrite (2026-11-04)

- Confirmed a filesystem data-loss/reliability race in `storage-migration.ts`. Two requests could copy the same manifest concurrently because the service did not claim an operation lock. They shared a deterministic `.partial` path; when one request failed to open that path with `EEXIST`, its catch handler unconditionally removed the path even though the other request owned and was writing it. The final publication also used `rename(partialPath, destination)`, which can replace a destination created after the earlier existence check on POSIX.
- Added a PostgreSQL session advisory lock keyed by migration ID around copy, cleanup confirmation, and cleanup. The lock is released in a `finally`-equivalent path and the client is discarded if unlock fails; connection/process termination releases the session lock automatically.
- Changed partial copies to unique per-attempt names, opened with exclusive creation and private mode, and limited cleanup to the temporary file created by the current attempt. Final publication now reuses the existing `moveFileNoReplace` helper. If another process creates the destination during the copy, different bytes are preserved and the migration pauses; identical verified bytes may be accepted as already published.
- Manifest write temporary names are now unique as well, avoiding same-process and cross-process collisions on the old PID-only temporary filename.
- Added focused regressions: (1) two service instances sharing a simulated database lock cannot copy the same manifest concurrently, and the lock is reusable after completion; (2) a destination created after preview is never overwritten, the source remains intact, and the current operation's partial file is cleaned.
- Commits: implementation `0340a1c02d76d2ba814ac88599cd0c9231f60e00`; regression tests `3111fa7d8db5f54b6c042f9ffcd59b0ff4deb4f7`.
- Validation: Fast Validation passed on commit `2b476dfc5a3ecf776317a1eb34d019fdf54596fa`, including concurrent-copy and destination-collision regressions on Linux and Windows. Dependency Review passed on commit `3111fa7d8db5f54b6c042f9ffcd59b0ff4deb4f7`.
- Remaining limitations: the regression uses a fake database client to exercise advisory-lock ownership; a live PostgreSQL advisory-lock integration test and a real NAS/SMB publication test remain outstanding. If the database connection is lost during a long-running copy, PostgreSQL releases the lock; the exclusive no-replace destination publication still protects existing files, but the manifest can require a retry/reconciliation. Older deterministic partial files left by an interrupted pre-fix copy are not automatically deleted, to avoid removing a file still owned by an older running process.


## Recovery rollback and job deletion preserve filesystem safety (2026-11-05)

- Recovery rollback previously hashed destination paths with normal file reads, which follow symbolic links. A destination replaced with a symlink could therefore be mistaken for the original regular file. `rollbackMoves` now uses `lstat` to reject symlinks and non-regular destination entries before hashing, then rechecks the restored source entry after moving it.
- Organize job deletion previously blocked only `executing` jobs. A failed job with unresolved file moves, or a job in `rolling_back`, could be deleted and lose its recovery journal. Added `canDeleteOrganizationJob` and a database-side DELETE predicate that allows deletion only for terminal completed/rolled-back jobs or inactive jobs with an empty journal. The predicate protects against a concurrent worker acquiring a lease or adding recovery records after the initial read.
- Added regression tests for symlink-safe rollback and recovery-aware deletion. Fast Validation passed on commit `2b476dfc5a3ecf776317a1eb34d019fdf54596fa`.


## Operational NAS directories reject symlink redirection (2026-11-05)

- A follow-up review found that organize operation logs/reports and the library startup-history cache still used `ensurePrivateDir`, which performs recursive mkdir/chmod without validating the directory chain against the configured NAS root. A symlink in one of those paths could redirect writes or permission changes outside the intended library.
- These NAS-owned directories now use `ensureDirectoryWithinRoot`, which checks every component and rejects symlinks before creation. Added tests for symlinked logs and cache paths, plus route wiring assertions for logs, reports, and startup cache.
- Fast Validation #561 passed on audit head `2b476dfc5a3ecf776317a1eb34d019fdf54596fa`, including Linux typecheck/backend regressions and the Windows archive/updater smoke job. Dependency Review #325 passed on the same head. This change does not replace the need for appropriate NAS/Windows ACLs against other users with write access to parent directories.

## Preserve organize recovery journals during job deletion (2026-11-04)

- Confirmed a data-loss/recovery defect in `DELETE /organize/jobs/:id`: the route rejected only `executing` jobs. It still allowed deletion while a job was `rolling_back`, and allowed a `failed` job with non-empty `fileMoves` to be deleted. That could remove the database recovery journal while rollback was active or discard the only record of files that still needed recovery. The UI also disabled deletion only for `executing`.
- Added `canDeleteOrganizationJob`: active analysis/execution/rollback states cannot be deleted; nonterminal jobs can be deleted only with an empty recovery journal; completed and fully rolled-back jobs remain deletable. The DELETE statement repeats the status and JSONB-journal predicates so a concurrent execute/resume/rollback cannot win between the initial read and deletion.
- The organize job UI now disables deletion for active jobs and nonterminal jobs with recovery records, with an explanatory tooltip.
- Added helper-policy and route-wiring regressions. Fast Validation #561 passed on head `2b476dfc5a3ecf776317a1eb34d019fdf54596fa`; the Linux targeted backend suite reported 155 passed, 0 failed, and 2 skipped.
- Remaining limitation: deletion policy is covered by helper and route-source regressions rather than a full HTTP/PostgreSQL race integration test. The conditional DELETE predicate provides the database-side race protection.

## Reject symlink and special-file destinations during organize rollback (2026-11-04)

- Confirmed a rollback integrity/security defect: `rollbackMoves` hashed the destination through a read stream before checking its file type. A symlink whose target happened to contain the expected bytes could therefore be moved into the staging source path and counted as a successful regular-file restore. FIFO/device entries could also be opened as if they were ordinary files.
- Rollback now uses `lstat` before hashing and accepts only regular non-symlink files. It checks the restored path again after the no-replace move and attempts to return an unexpected non-regular entry to its destination instead of counting it as restored.
- Added a regression that replaces a moved destination with a symlink to an external file containing the same bytes; rollback must leave the symlink at the destination, leave the source absent, and report zero restored moves.
- Fast Validation #561 passed on head `2b476dfc5a3ecf776317a1eb34d019fdf54596fa`; the symlink regression passed in the Linux targeted backend suite (155 passed, 0 failed, 2 skipped).
- Remaining limitation: the regression covers a final-component symlink. It does not eliminate every parent-directory replacement race on a hostile writable NAS; the route's canonical-root checks and NAS ACLs remain important.

## Latest integrated validation snapshot (2026-11-05)

- Fast Validation [#561](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41956510026) passed on audit head `2b476dfc5a3ecf776317a1eb34d019fdf54596fa`. Linux typecheck/generated contracts, targeted backend regressions, desktop/release/storage checks, and archive safety passed. The Linux targeted backend suite reported 155 passed, 0 failed, and 2 skipped.
- The Windows archive/updater job in the same run passed, including the newly added storage-migration concurrency/no-overwrite test, NAS temporary-path safety, official 7-Zip 26.05 link-metadata compatibility, updater journal writes, and updater preservation/rollback.
- Dependency Review [#325](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41956510064) passed. No main-branch, production-data, credential, or release changes were made.

## Desktop static web server request and I/O failure handling (2026-11-05)

- Feature review of the packaged desktop web server found two reliability defects in the static-asset request path. First, the request handler constructed `new URL(request.url, ...)` outside its parse-error handler, so a malformed request target (for example, an invalid bracketed authority) could throw synchronously from the HTTP server callback instead of returning a controlled 400 response. Second, static-file read failures were all mapped to 404, including permission-denied and storage I/O errors; synchronous resolver failures such as inaccessible roots could also escape the request handler.
- Added `parseDesktopRequestUrl` to validate the URL and percent-decoded pathname before routing. Malformed URL/path encoding now returns 400. Wrapped static path resolution so inaccessible installed files return a controlled 500. Added `staticFileReadErrorStatus` so only ENOENT/ENOTDIR return 404; EACCES and I/O failures return 500 with a generic message.
- Added focused regressions for malformed URL authority, malformed percent encoding, valid API path parsing, and the 404-versus-500 filesystem error mapping.
- Commits: safety helper `26af1682c5c628df5b141552bde13aded154d5f6`; regression tests `f58e792410528d2025174953af0f47adee798f2c`; server integration `0e2c301abcb6540cd573f2038ef12a20603a77ad`.
- Validation: pending. The narrow command is `node --test desktop/web-server-safety.test.mjs`; the Fast Validation workflow also runs this exact test file. Do not treat the change as validated until the test and workflow result are observed.
- Scope: desktop static request handling only. This does not claim to validate the packaged Windows installer or the full desktop service lifecycle.

## Desktop web server malformed-request and static asset error handling (2026-11-05)

- Feature review found that malformed request URLs were parsed outside the HTTP handler's error boundary, allowing a synchronous URL-construction exception to escape instead of returning a controlled client error. Static asset read failures were also all mapped to 404, including EACCES and disk I/O errors; synchronous static-root resolution errors were not handled at the request boundary.
- Added safe request URL/path parsing, controlled 400 responses for malformed URL or percent encoding, a guarded static-root resolution path, and filesystem error classification that maps only ENOENT/ENOTDIR to 404 and permission/I/O failures to 500.
- Added focused tests for malformed authority, invalid percent encoding, valid API path parsing, and missing-versus-unreadable file error classification.
- Commits: helper `26af1682c5c628df5b141552bde13aded154d5f6`; tests `f58e792410528d2025174953af0f47adee798f2c`; server integration `0e2c301abcb6540cd573f2038ef12a20603a77ad`.
- Validation: local Node test run against a staged copy of the branch helper and regression cases passed **4/4**. GitHub Fast Validation has not yet been observed for this commit; packaged desktop runtime/installer integration remains outstanding.

## Empty-folder cleanup scan fails closed and respects filesystem entries (2026-11-05)

- Feature review found that `GET /cleanup/empty-folders` swallowed directory enumeration failures and could report a partial scan as complete. It also ignored symlinks and special filesystem entries when deciding whether a directory was empty, potentially presenting a directory containing such an entry as empty.
- Extracted the scan into `findEmptyDirectories`. It uses `lstat`, never traverses symlinks, treats symlinks and special entries as contents, reports empty descendant directories and parents that become empty after their empty children are removed, and propagates read/stat errors so the route returns 500 rather than a misleading partial list.
- Fixed a related summary correctness defect: `emptyFolderCount` was inferred only from distinct parent folders in `media_files`. Truly empty folders have no media rows, so they could never be discovered by that query. The summary now uses the same filesystem scan as the Empty Folders feature.
- Added tests for nested empty directories, symlink containment, and a missing scan root. Added the test file to the Fast Validation targeted backend suite.
- Commits: scanner `1fc2c8e95a897da858ef504c2cac2e062b6fb56f`; tests `3b32beec08317d56d1dafc4d05060653ffef4c7e`; route integration `8d6a1fcb56ede3e4150e1338d0563e1e6e52d9a0`; workflow test inclusion `32c40eae697e2cb9bf07d48e7890664e36024c67`; summary correction `d542e41780384333069f93d7fc4ad7358dadd723`.
- Validation: local Node test run against a staged copy of the branch helper and regression cases passed **3/3**. The new Fast Validation command was inspected and its line continuation corrected before finalizing; GitHub CI has not yet been observed for the latest commit. Permission-denied traversal was not separately exercised under a non-privileged account; the missing-root case verifies fail-closed error propagation.

## AI context queries are isolated to the active library (2026-11-05)

- Feature/privacy review found that the OpenAI conversation context builder queried storage totals and the five largest files from `media_files` without a `nas_path` predicate. In a multi-library database, a question about storage/space could therefore include file counts, sizes, names, and paths from libraries other than the active one in the context sent to the configured AI provider. The local filename search also fell back to an unscoped query when no active library path was available.
- Removed the unused unscoped local-search helper. Storage breakdown and largest-file context now require an active NAS path and apply both the active-library predicate and the existing deleted/recycled filter. Local filename search is skipped entirely when no active library is configured and always applies the selected library predicate.
- Added a focused route-source regression covering the active-library arguments, per-query NAS predicates, and no-library fail-closed behavior. Added it to the Fast Validation targeted backend suite.
- Commits: implementation `136bebbd027d3e567397ed613fe51ba9017e2004`; regression test `581e23160d9874d4d62358f13323905c600eb720`; workflow inclusion `ef5d5d513e2af5206f57a4c82c37c3b18e1dc2e8`; unused test import cleanup `62adb3eba8ab9fa10ab145e7832bf93d9f22efff`.
- Validation: pending. No live multi-library database test or AI-provider request test has been run; the focused source regression is intended to prevent the missing-scope query pattern from returning.
- Limitation: this review covers the context builder in `routes/openai/index.ts`; other AI provider integrations and any future context-building modules still require the same active-library scoping review.

## Media Health cleanup no longer treats inaccessible files as missing (2026-11-05)

- Confirmed a high-risk data-loss path in `inspectLibrary`: it wrapped both path resolution and `fs.existsSync` in a catch-all and classified every failure as a missing media file. `existsSync` also returns false for permission-denied paths. If the NAS became unavailable, unreadable, or a stored path was unsafe, the report could classify valid catalog records as orphaned; selecting `orphanedRecords` then deleted those database rows.
- The health inspection now verifies the library root with `checkNasReachable` before examining records. It uses `lstat`-based `isMissingRegularMediaFile` and treats only ENOENT/ENOTDIR as confirmed missing. Permission/I/O errors, unsafe path resolution, symlinks, and non-regular entries abort inspection; cleanup therefore cannot proceed with a false orphan list.
- Added regressions for ENOENT/ENOTDIR versus EACCES/EIO, regular versus missing files, directory and symlink rejection, and route wiring for the library reachability guard.
- Commits: helper `1ac4055eb02ec2cacc19c079ad298e369020dd9c`; tests `78ac6fb239481994cdbe064289e76593b0b64c57`; route fix `8e8f45cbf36bc29d4a25a3b7e464ceb74c59ad7a`; Fast Validation inclusion `6d0a294372de613899f8979b4511fed07dbe9324`.
- Validation: local Node test run against a staged copy of the branch helper and focused regression cases passed **4/4**. GitHub Fast Validation has not yet been observed for the latest branch head. No live NAS outage/permission test or HTTP/SSE cleanup integration test has been run.
- Remaining limitation: thumbnail/cache inventory helpers still intentionally treat inaccessible derived-cache subtrees as best-effort and may under-report cache findings; they do not use that partial inventory to delete canonical media rows. The orphaned-record path now fails closed.


## Organization moves are journaled before filesystem mutation (2026-11-05)

- A move was previously recorded in `organization_jobs.file_moves` only after `verifiedMove` returned. A process crash after the filesystem move but before that database checkpoint could leave the destination populated and the source missing with no recovery record.
- Initial execute and resume now persist a `verified: false` move intent containing the absolute source/destination paths and expected SHA-256 before moving the file. `verifiedMove` checks that the source still matches the intent hash before mutation. After successful move verification, the intent is replaced with the completed `verified: true` record.
- Recovery parsing accepts well-formed pending intents, rollback treats an intact source as a move that never completed (preserving any independently created destination), and resume refuses pending intents until rollback is completed. This avoids silently treating an uncheckpointed move as completed.
- Added regression coverage for crashes before/after the filesystem move, destination races, source changes after intent, and route checkpoint ordering. Fast Validation is pending on the current audit branch.
- Scope limitation: the separate `conflictPolicy = "replace"` path still deletes an existing destination before the new source move is journaled. It remains intentionally unresolved pending a durable replacement-backup state machine; this intent fix does not claim to make replacement safe.

## Active-library switch invalidates the media NAS-path cache (2026-11-05)

- Feature review found that the media router cached the active NAS path for 60 seconds, while Settings allows the user to change the active library during the same process. The existing `invalidateNasPathCache` function was exported but never called by the Settings update route. Media requests made immediately after a successful library switch could therefore continue querying the previous library until the TTL expired.
- The Settings route now invalidates the existing media path cache immediately after the settings row is successfully persisted and only when a non-empty NAS path changes. Failed settings updates do not invalidate or change the active cache.
- Added a regression asserting the Settings route imports and calls the invalidator after persistence. Added it to the Fast Validation targeted backend suite.
- Commits: Settings integration `80a05c46722273badf993022d6ceb23b366ee030`; regression test `fd3fd58daf4a8dcf5538753b2ba2325231011568`; workflow inclusion `5a59a34a078cc9c9c6feee585208ca74ca90a9c3`.
- Validation: the focused source regression passed **1/1** with `node --experimental-strip-types --test` against a staged copy. GitHub Fast Validation has not yet been observed for the latest branch head; no live API library-switch integration test has been run.
- Remaining limitation: the in-memory thumbnail cache is keyed with the NAS path and checks that path before serving, so old-library thumbnails are not served for a newly selected path. This change invalidates the active path lookup; it does not clear old entries, which are harmless stale cache entries until replaced/evicted.

## Apply AI privacy exclusions to every generated library context (2026-11-05)

- Follow-up privacy review found that the existing `aiExcludedFolders` and `aiExcludedExtensions` rules were applied to direct filename-search results but not to storage aggregates, largest-file context, duplicate counts, or the OpenAI system prompt's library statistics. A private folder or excluded extension could therefore still contribute file names/paths or statistics to cloud AI context even when the user had explicitly excluded it.
- Added a shared SQL predicate that normalizes folder separators/case, excludes a folder and its descendants, and excludes configured filename extensions before aggregation or result limits. Applied it to storage breakdown, largest-file results, direct filename search, duplicate counts, and system-prompt statistics.
- The system prompt now fails closed with zero library media statistics when no active NAS path is configured, rather than querying all library rows.
- Added SQL-generation and route-wiring regressions and included them in Fast Validation.
- Commits: SQL helper `da22c5425b8f74ab3e374aac37d6bcf71dd804e9`; route integration `7b1d736dd8635aaf5a9a6793caeb15b6c676f525`; test `c42dd39dd84138523cb3a4d07070e67c0ee54c4f`; workflow inclusion `413aab74592e0662d13130a600f2ff21221c2c6e`; helper normalization corrections `40c726d44b4e95c3d68b4c3038003f6756c83de0` and `315abb06d4a847adb50d96b905634141864f5070` and `5dd81314ca054dd3be58a2ec45a2737a9b24e690`; assertion adjustment `dcfcdcbb536995ce9780b640545bb523a9290175`; direct-search SQL exclusion `c44e51e4bcf66d443b636d345f6b0e8fdcf598f0`.
- Validation: pending. The repository's Fast Validation run has not yet been observed for this work. A local Drizzle SQL-generation test could not be executed in the current scratch environment because the repository's `drizzle-orm` dependency is not installed there; do not treat this change as validated until the branch CI executes the new test.
- Remaining limitation: the privacy regression verifies SQL generation and route wiring, not a live database with two libraries and excluded test fixtures, nor an actual cloud-provider payload capture. The live integration check remains required.

## Canonical active-library selection unified across media features (2026-11-05)

- Continued review of media, search, documents, diagnostics, storage, health, explorer, and people/faces endpoints found multiple independent settings lookups using unordered `LIMIT 1` (including a raw SQL equivalent). The repository already has a canonical resolver in `lib/active-library.ts` that deterministically chooses the authenticated settings row first and then the lowest ID. The independent lookups could select a different row when legacy duplicate settings records exist, causing one screen or feature to query a different library than another.
- Replaced these duplicate lookups with `getActiveNasPath()` in storage, documents, diagnostics (including storage-policy diagnostics), search, files, faces, health, and explorer. Updated `lib/archive-scope.ts` to delegate to the same resolver instead of maintaining a second copy of the settings query.
- Added source-level regressions verifying the listed media feature routes and archive/storage scopes use the canonical resolver and no longer perform direct unordered settings lookups. Added the test to Fast Validation.
- Commits: storage route `71c5c33e17100ecefe1a9eb4ebdbd9efd496ecfb`; storage test `7ed979235bd188ac363ad43ed5e645186a242029`; documents `f511b8e9d982025b51a5de44611c18cb0fd0a72e`; diagnostics `bc107e579ff4c93ac1ccb58704f175fd5fa3c980`; search `bce59102aad2374c180e92335acfef05b9f68ec3`; files `8fc01ba4dfae312e959d62d4bb22814517d0b602`; faces `42cb54dbedaf8b66f1860d77e1e67f84a96c616f`; health `73b11deb85c479659056f62de4a13453742591d9`; explorer `dc2c40e15aef87b88df67e51853853b76b1dff0f`; archive scope `3379dde83ba9876c8b6f946b249141badab2e720`; regression test `841f2b203fbe0bb5747b164b960f119be49dfc1e`; workflow inclusion `2573b2ee21ea154dd7407587e82da03c27e6370`.
- Validation: each changed file and the Fast Validation command were re-read from the audit branch. GitHub did not return a workflow run for the latest workflow commit at the time of review; the prior related workflow attempt was cancelled. Do not report the full test suite as passing until a fresh Fast Validation run completes. Database-backed multi-settings fixtures are still needed to demonstrate deterministic selection end-to-end.

## Conversion jobs are claimed atomically before execution (2026-11-05)

- Feature review found a race in `GET /optimize/jobs/:id/execute`: multiple execution tokens could be issued while a job remained pending, and separate requests could both read that pending status before either wrote `running`. The old unconditional status update allowed both workers to scan and write to the same deterministic staging directory.
- Added a PostgreSQL compare-and-swap claim from `pending` to `running`, scoped by both job ID and the job's NAS path. The claim occurs before scanning or staging; a second worker receives a conflict event and exits. Removed the later unconditional status update.
- Added a route regression that verifies the atomic pending-state predicate, library scope, claim-before-scan ordering, and removal of the unsafe unconditional update. Included it in Fast Validation.
- Commits: implementation `ec8b4d857cba6a761c3898c1201c8094aba1dde4`; regression `59e3929c12258a15ee57216259406f8d7d7e69e1`; workflow inclusion `a6590f2bad98f1559527277d824e15aaf90f0fbe`.
- Validation: focused source regression passed **1/1** with Node's type-stripping test runner against a staged copy. GitHub Fast Validation has not yet been observed for the latest branch head; a live two-request PostgreSQL concurrency test remains outstanding.

## Conversion finalization still has unresolved original-file overwrite risks

- Confirmed that `finalizeHandlerImpl` uses destructive POSIX rename/unlink behavior without a durable per-file journal. The `replace` action unlinks the original before publishing the staged conversion; a publish failure can therefore lose the original. For cross-format conversions, the new extension's destination may already exist and a POSIX rename can overwrite that unrelated file. The `archive`, `recycle`, and `keep-both` actions also use rename destinations without exclusive no-replace semantics, so a prior archive/trash/optimized file can be overwritten on collision.
- The job stores a `backupDir` and the UI labels/displays it as a backup directory, but the inspected optimize route only uses it as a scan exclusion; the finalization path writes originals to `WillardAI/archive` or the OS/`.Trash` and does not publish copies to the configured `backupDir`. This is a feature-contract/usability mismatch.
- No code change was made. Correcting this safely requires deciding whether `backupDir` is a guaranteed retained copy, defining collision behavior for each finalization action, and journaling the original-to-backup and staged-to-destination steps so crash recovery can restore originals. A simple switch to no-replace rename would prevent overwrite but could strand an original in the archive/trash location if publishing the converted file then fails.
- Validation: source inspection only; no finalization regression test or runtime filesystem test was run. Treat `replace` and collision-prone finalization actions as risky for valuable files until the durable backup/rollback design is implemented.

### Background workers and startup recovery included in canonical settings correction

- Extended the same duplicate-settings audit beyond HTTP routes. Library monitor, watcher, face recognition, media scanner, AI enrichment, legacy catalog reconciliation, cleanup recovery, startup recovery, and NAS log-stream initialization had independent unordered settings lookups.
- Monitor, watcher, face recognition, scanner, and AI enrichment now load the selected settings row through `getActiveAppSettings`; path-only recovery/catalog/startup flows use `getActiveNasPath`. AI embedding recomputation now binds the active NAS path as a query parameter instead of using an unordered SQL subquery.
- Expanded `background-active-library.test.ts` to cover these services and the AI embedding path. The test was already part of Fast Validation from the preceding workflow update.
- Commits: monitor `7e18e0b4ef3f7a3797e4e14717cc51eea7455a9c`; face worker `48ad097f82790d219dd4d1810c1c9ade2bc228eb`; watcher `ce95d0695f8fe81856d2f77b532e794b3dfbf3c6`; catalog reconciliation `73a1120caee85c4874e6b0a2165a442539e7bbaa`; cleanup recovery `940a8c5dd8393e0e8cea83d67e0cf5e7cbcda192`; startup recovery `ee3bd43e4c225df7f29fa97c10c476b69e645c09`; app NAS log startup `11025d8004970eed0c8e2bed99422ebf3935fe8a`; scanner `29b6487e51ab89268bab6cf8fcfb1b5b9f85ac06`; AI enrichment `aa6dfc8070816c4e74a5f265c59047a800c2c33e`; expanded regression `1640674dd1f21f0ad8a7147433694791f6125982`.
- Validation remains pending a fresh CI run. The branch's Fast Validation workflow has not yet produced an observed passing run for the expanded suite.

## Use the canonical settings row consistently across library and AI features (2026-11-05)

- Multi-library review found several feature modules still selecting an arbitrary `app_settings` row with `.limit(1)`, even though `getActiveAppSettings()` intentionally selects the canonical authenticated settings row (password-bearing row first, then lowest ID). With legacy duplicate settings rows, Collections, AI consent/exclusion settings, OpenAI conversation context, and Library scanner settings could therefore use a different NAS path or privacy configuration from the rest of the application.
- Collections now resolves its NAS path through `getActiveNasPath()`. Library health/scanner settings and indexing pause/resume/thumbnail-quality writes now use `getActiveAppSettings()` and update only that row by ID. OpenAI context and `getAiPrivacySettings()` now use the same canonical row.
- The AI privacy helper explicitly projects only its seven privacy fields from the full settings row; it does not spread or return password hashes, recovery-key hashes, or unrelated settings.
- Extended `canonical-active-library.test.ts` to check the affected feature routes and privacy helper for canonical resolver use, absence of arbitrary settings selects, and a secret-free AI privacy projection. The existing Fast Validation workflow already runs this test file.
- Commits: Collections `1140b1ac57b02632cb1bbe44d5b7ef870057cfb5`; AI privacy `7b0169a7c2b1922658eec78ffe68cacf5a2c02b0` and secret-free projection `3618fe7aed04506111f274de82842992a37898ce`; OpenAI context `59dca34075e59c7fd3bcabc250813f3ffa1c4705`; Library settings `0c6b335281c675a638b839f2229f1a85cb0e39b1`; regression `9b5e3b3469e4fc796251bccd7956a04e4c696f91` and secret projection assertion `ab7a8a068f152d200fd77b58f2097f9ff70e44bb`.
- Validation: source and test wiring inspected; GitHub Fast Validation has not yet been observed for these latest changes. No live database fixture with duplicate settings rows has been run. The source regression is not a substitute for the missing multi-settings integration test.

## Archive organization and dashboard use canonical active settings (2026-11-05)

- Continued the settings-row review into archive organization and the dashboard. The organizer had six separate unordered settings reads across analyze, preflight, route review, execute, disposition, and resume flows. Those reads could combine a job scoped to one library with preferences or NAS roots from a different legacy settings row.
- Replaced those reads with `getActiveAppSettings()` for full preference access and `getActiveNasPath()` for path-only disposition checks. Dashboard library reachability and last-scan display now use the same canonical settings row.
- Updated archive and dashboard imports after moving the canonical NAS resolver out of `archive-scope.ts` into `active-library.ts`, preventing stale imports of a removed export. Consolidated dashboard imports.
- Extended the canonical active-library source regression to include organize and dashboard routes.
- Commits: organizer `b83d700c798bd87afdcff49f4fd13279d8aa8468`; dashboard `9e905a2f342ee3cc5ab3e8ff599e56523f8c2300`; canonical regression `8a563f6163401111fb9494d63ee353f30cfc7395`; archive import `3a5e022a647cc678f8fdac38a833ff7150cd39f5`; dashboard import `822f94c8bc23276688557fdfb02079af7f6cbe3c`; consolidated imports `da0574894cd9c76259aaf4d85c672e6e009c0471`.
- Validation: source and regression coverage re-read from the audit branch. A subsequent review found that repeated workflow edits had introduced doubled shell continuation backslashes in the targeted test command; corrected all eight affected lines so each continued line has exactly one trailing backslash. Workflow correction commit: `93df5bfdfaea8b63059f9effbceb35766e73d648`. CI still needs to run successfully against the latest branch head; no full compile/test pass is claimed.

## Media Health directory inventory fails closed on unreadable subdirectories (2026-11-05)

- Follow-up review found that the same Media Health inspection still swallowed nested `readdirSync` errors in its directory walker. The health report could therefore claim a complete empty-folder inventory even when part of the library could not be enumerated.
- Removed the catch-and-return behavior. A nested enumeration error now aborts inspection; the health endpoint reports a failure and cleanup marks its job failed before applying any selected action.
- Extended `media-health-scan.test.ts` with a route-source regression ensuring the directory walker no longer suppresses read errors.
- Commits: route `bd989dba145538c9a46b50e960735ce94156bdd4`; test `7f8f87768f4d0a81b9930f209cc9a0c504e97b50`.
- Validation: pending GitHub Fast Validation. The existing local helper tests cover missing-file classification but do not execute the full Media Health route or a permission-denied nested-directory fixture.

### Legacy scan adapter, media detail, and scan completion use the canonical settings row

- Found additional legacy lookups in the compatibility scan API and media-detail API; both now use `getActiveNasPath()`.
- The library job engine already used the canonical helper for several other settings reads, but its scan preference load still used unordered `LIMIT 1`. It now uses `getActiveAppSettings()`.
- Fixed a related multi-settings write hazard: scan completion previously updated `lastScanAt` for every Settings row whose `nasPath` matched. It now re-reads the canonical settings row, verifies the active path still matches the path the job scanned, and updates only that row by ID. If the user switches libraries while a scan is running, the old scan cannot overwrite the new library's last-scan timestamp.
- Added source regressions for the legacy scan adapter, media detail, and job-engine preference and completion-write behavior.
- Commits: scan adapter `c942d8fa367cfefd26fb305aaffb3cd97e5f4fc4`; media detail `ffe9bc3bdb4973c3d03bbc5c5eca3d5bc7416a5b`; job engine `4e31179777fc076fe4217a5ba1f23797f9a8ad32`; regression `98d77b2b0ece33ebd7b45a531d9d5d6a5634c1d2`.
- Validation: static regression added to Fast Validation; full typecheck and live scan/switch integration test still pending CI execution.

## Database backup identifies the canonical active NAS library (2026-11-05)

- Feature review found that the desktop database-backup manifest selected a non-empty `app_settings.nas_path` using `LIMIT 1` without an ordering rule. The application uses a canonical active-settings selection (authenticated/password-bearing row first, then lowest ID), so legacy duplicate settings rows could cause a backup manifest to bind the database snapshot to a different NAS root than the application considers active.
- Updated the backup snapshot query to use the same deterministic ordering as `getActiveAppSettings()`.
- Added a regression to `desktop/database-backup.test.mjs`; the existing Fast Validation workflow invokes this suite through `pnpm run test:database-backup`.
- Commits: implementation `93209c3a21f699a9fd6ab68a541d0a5988070716`; regression `eb7c9b9a83006440835c98bc1697d0549bb125fc`.
- Validation: pending GitHub Fast Validation. No disposable PostgreSQL fixture with duplicate settings rows was run in this turn.
- Remaining limitation: the backup manifest still represents one NAS library identity while the database dump contains the full database. Databases containing media rows for multiple distinct NAS roots need an explicit multi-library manifest/restore design or a fail-closed preflight; this review did not change that behavior.

## Correct missing import exposed by Fast Validation (2026-11-05)

- Fast Validation #637 reached TypeScript checking and failed at `artifacts/api-server/src/routes/organize.ts:2098`: the recovery query referenced Drizzle's `isNotNull` without importing it.
- Added the missing named import. No runtime behavior changed.
- Commit: `e548582021ad29edb5a97162935229ed4e41a342`.
- Validation: the failure is confirmed by Fast Validation #637. The correction itself is not yet validated; a new Fast Validation run is required before proceeding to the regression suite.

## Backup manifest canonical-row correction and integration fixture repair (2026-11-05)

- Fast Validation #639 passed TypeScript typecheck, generated contracts, Expo configuration, and the desktop web-server safety suite (4/4). Its release/storage step then failed in the PostgreSQL recovery drill: `sourceLibrary` returned null and the test dereferenced `manifest.library.root`.
- Inspection found the first canonical-row query still filtered out settings rows with a null/blank `nas_path` before ordering. If the canonical authenticated settings row had no configured library but a stale duplicate row had an old path, the query could select that stale path. The query now selects the canonical row first using `ORDER BY (password_hash IS NOT NULL) DESC, id ASC`, then lets the existing empty-root check return no library identity when the canonical row has no active path.
- The recovery-drill fixture's simplified `app_settings` table omitted the production `password_hash` column. Added that column and an explicit NULL value so the fixture models the production selection query.
- Commits: canonical query `b557f0c61a928da9931b6354dac61d1c700f6e9a`; fixture schema `7dac6e05422b7c95a37fb0425470bb8581ab0e47`; corrected query assertion `cca95e5bec4c4f66c217afbcaf7f14d1ba6dc792`.
- Validation: #639's 18 other database-backup tests passed; the recovery drill failed as described. The corrected fixture/query have not yet passed a rerun. No other Fast Validation stages (7-Zip, targeted backend regressions, Windows) ran because the release/storage step failed.
- Remaining limitation: the single-library backup manifest still does not describe multiple distinct NAS roots stored in one database; that requires a multi-library manifest and restore/remapping design. This change only ensures the one root it records is the canonical active settings row.

## Fast Validation #644: integrated audit fixes and regression corrections (2026-11-05)

- Fast Validation [#644](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41959379158) passed on code/test commit `ff3cb8e1751314448bfd8fce50fc2743293fbdb7`. Linux passed TypeScript/generated contracts, Expo configuration, desktop web-server safety, release/storage contracts, official 7-Zip 26.05 compatibility, and targeted backend regressions (**183 passed, 0 failed, 2 skipped**).
- The Windows `windows-archive-and-updater-smoke` job also passed: storage migration concurrency/no-overwrite regressions, NAS temporary-path/cleanup safety, official Windows 7-Zip hash verification, Linux-created symlink metadata parsing, updater journal writes, and updater preservation/rollback.
- Dependency Review [#408](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41959379311) passed.
- The prior Fast Validation #642 targeted suite reported seven failures. Review confirmed they were test defects: one AI-context assertion expected an obsolete helper signature, the Media Health source assertion searched outside the intended walker, four organization fixtures created directories where files were intended, and the resume-route source test used the wrong end boundary. These tests were corrected; #644 is the passing run for the corrected test head.
- No production data, credentials, main branch, or release artifacts were changed.

## AI enrichment exclusions normalize Windows paths before selecting pending work (2026-11-05)

- Follow-up feature review found that the AI enrichment pending-work SQL compared `lower(f.relative_path)` against normalized excluded-folder paths using SQL `LIKE`. On Windows, stored relative paths can contain backslashes while exclusions are normalized to forward slashes. The SQL filter could therefore fail to exclude the configured folder; the later in-process privacy check skipped those files without marking them complete, allowing excluded rows to repeatedly occupy the batch limit and starve eligible files. SQL `LIKE` also treated literal `%` and `_` characters in folder names as wildcards.
- Updated the query to normalize database separators with `replace(relative_path, chr(92), '/')` and compare folder equality/prefix using `left(..., length(folder)+1)`, avoiding wildcard interpretation and matching the existing in-process exclusion semantics.
- Added a regression to `ai-media-scope.test.ts` checking Windows separator normalization and literal folder-boundary comparison. The test is already part of the Fast Validation targeted backend suite.
- Commits: implementation `f743945ce2773daf5431147f30292ad32466e7a9`; regression `3cc8427e3127155174444ad71617134e10ccbd6f`.
- Validation: pending Fast Validation for this latest AI-enrichment change. The preceding #644 run does not include these two commits.

## Conversion finalization can report success while discarding staged outputs (2026-11-05)

- Confirmed a second, more specific data-loss path in `artifacts/api-server/src/routes/optimize.ts` within `finalizeHandlerImpl` (current source locations: function line 1334; success-file skip checks lines 1386–1387; staging cleanup line 1467; unconditional `done` write line 1475).
- A successful conversion whose staged file is missing is silently skipped. Per-file finalization exceptions are appended to `fileOutcomes`, but the handler still recursively deletes the entire staging directory and marks the job `done` regardless of those errors. In the `replace` path it unlinks the original before attempting to rename the staged output; a rename failure can therefore leave neither the original nor the converted output. The `archive` and non-Windows `recycle` paths move the original away before publishing the staged output, but the catch path does not restore it if publication fails. The unconditional staging cleanup can then delete the only remaining converted copy.
- This is confirmed by source inspection of the current audit-branch head. The existing `optimize-cycle.test.ts` covers only the successful recycle path; it does not cover missing staged files, a failed publish after the original has moved, preservation of the staging directory after a partial failure, or concurrent finalization requests.
- The retry route compounds the crash case: `POST /optimize/jobs/:id/retry` accepts `awaiting_action`, recursively removes `resultJson.stagingDir` (line 1283), then clears `resultJson` and resets the job to `pending` (line 1289). If the process crashed partway through finalization, using Retry destroys the remaining staged outputs and discards the only job-level record of which files were already moved. The route begins at line 1268.
- No application change was made in this run. A safe correction needs a durable per-file finalization intent/result journal, no-replace publication for archive/trash/keep-both destinations, rollback/preservation behavior for each action (including the Windows Recycle Bin path), and an atomic job claim so two finalize requests cannot mutate the same job concurrently. Simply leaving the job in `awaiting_action` or skipping staging cleanup is not sufficient: some files may already have been finalized, so a retry must distinguish completed operations from operations that never started, including a process crash between filesystem mutation and database checkpoint.
- Validation: source inspection only; no code or regression test was changed for this finding, and no test pass is claimed. The current Fast Validation run #646 is for the pre-documentation code head and is still queued at the time of this entry.
- Priority: critical data-integrity follow-up. Until the finalization journal and recovery behavior are implemented, avoid using the conversion `replace`, `archive`, or `recycle` actions on the only copy of valuable media. `keep-both` avoids deleting the original but still has an overwrite-collision risk and can lose the staged conversion on partial failure.

## Fast Validation #646 outcome and remaining feature-security findings (2026-11-05)

- Fast Validation [#646](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41959808901) completed its Linux validation job successfully on the code/test head containing the AI enrichment path fix. TypeScript/generated contracts, Expo configuration, desktop web-server safety, release/storage contracts, official Linux 7-Zip compatibility, and targeted backend regressions all passed (**184 passed, 0 failed, 2 skipped**).
- Dependency Review [#410](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41959809000) passed.
- The Windows archive/updater job completed all substantive checks successfully: storage migration concurrency, NAS temp cleanup, official Windows 7-Zip hash verification, cross-platform symlink metadata parsing, updater journal writes, and updater preservation/rollback. The overall Fast Validation run was subsequently cancelled during job completion after another branch update; therefore the Windows job is recorded as step-level success, not as a completed successful workflow.
- The AI enrichment exclusion regression was included in the passing Linux targeted suite. This validates the SQL normalization/source regression, not a live Windows PostgreSQL enrichment run.

## Public first-run setup can be claimed by the first visitor (2026-11-05)

- Security review confirmed that `POST /auth/setup` is intentionally unauthenticated while no password hash exists, is listed as a public auth path, and has no setup-specific rate limiter or bootstrap-token check. The API server calls `app.listen(PORT)` without a host restriction, so deployments exposed on a LAN or public reverse proxy can make this route reachable to remote visitors.
- The route correctly prevents setup after a password has been stored and serializes the first successful credential write, but that means the first visitor to an uninitialized exposed instance can become its administrator and set the recovery key.
- No code change was made. A safe correction requires a product/deployment decision: e.g. a one-time bootstrap secret supplied out-of-band, a local-loopback-only initialization mode with a documented remote-host alternative, or an explicit owner activation flow. Simply adding a rate limiter does not prevent first-visitor takeover.
- Validation: source inspection only. No public deployment or network-exposure test was performed. Treat an uninitialized instance as untrusted and do not expose it to an untrusted network before the owner completes setup.
- Priority: critical for publicly reachable first-run deployments.

## Feature-family audit coverage snapshot (2026-11-05)

- **Authentication and sessions:** password setup/login/recovery/session races reviewed; session lock and recovery regressions are covered. First-run setup takeover remains open for exposed uninitialized deployments.
- **Library selection, scanning, and indexing:** canonical settings selection applied across Library, Collections, AI privacy, and OpenAI context; active-library cache invalidation added. Multi-settings live DB coverage remains outstanding.
- **Media browsing, streaming, thumbnails, rename, and health:** stream error handling corrected; health cleanup now fails closed on inaccessible roots, unreadable files, symlinks, and incomplete directory scans. NAS share ACL verification remains deployment-specific.
- **AI search, enrichment, and chat:** local-only saved-search policy, active-library scoping, folder/extension exclusions, and Windows separator normalization reviewed and regression-tested. A live provider-payload capture and two-library DB integration test remain outstanding.
- **Collections, faces, and metadata:** active-library scoping reviewed; face/media paths and assignment flows inspected. Full browser interaction coverage remains outstanding.
- **Cleanup and archive handling:** empty-folder scanning and media orphan cleanup now fail closed on incomplete scans. Archive traversal/link/reparse-point protections and official 7-Zip metadata checks are covered; a complete malicious Windows organize-route test remains outstanding.
- **Organization jobs:** exclusive destination moves, pre-move intents, checksum-verified rollback, journal checkpoint failure handling, resume journal retention, and final destination integrity checks are implemented. Per-attempt database lease tokens and pre-mutation ownership callbacks are also implemented, but multi-process takeover/Windows/SMB runtime validation remains pending; filesystem-level fencing is not yet proven. Replace collisions are rejected in both API execution paths and disabled in the UI until durable displaced-file backup/recovery is implemented.
- **Conversion/optimization:** pending jobs use an atomic execution claim; finalization persists per-move intents before mutation, verifies no-overwrite publication, attempts checksum-verified rollback, and runs staging cleanup only after the database records `done`. Startup and request-path recovery reconcile interrupted finalization journals. The critical remaining issue is stale-worker fencing: session advisory-lock loss can leave an old worker mutating shared job-level staging/publish paths while a retry or recovery starts. Attempt-specific staging, durable per-file conversion checkpoints, and a filesystem mutation fence still require an architectural batch and fault-injection tests.
- **Database backup/restore:** canonical active settings row selection and recovery-drill fixture corrected. Multi-library backup manifests and restore remapping remain unsupported/uncertain when one database contains multiple NAS roots.
- **Desktop web server, updater, and installer:** request-target/path handling and updater journal/rollback checks are covered. Clean-machine installer lifecycle, browser SVG CSP, and full Windows malicious-archive route validation remain outstanding.

- Scope limitation: this is a broad source-level and targeted-regression audit of the major API, storage, AI, desktop, updater, and installer feature families. It is not a complete end-to-end browser test of every UI workflow or a destructive test against a live NAS/production database.

## Windows updater smoke test now supports detached CI checkouts (2026-11-05)

- Fast Validation #646 passed its complete Linux job, including typecheck/generated contracts, desktop web-server safety, release/storage contracts, official 7-Zip 26.05 compatibility, and the targeted backend regression suite. The Windows archive/updater job completed its storage-migration, NAS temp-path, official 7-Zip, symlink-metadata, and updater-journal steps successfully, then failed in `scripts/windows/update-smoke.ps1:69`: a pull-request checkout was detached, so `git branch --show-current` returned an empty value and PowerShell threw when calling `.Trim()`.
- Fixed the smoke harness to create a unique `smoke-update-<guid>` branch from the temporary clone's current commit before creating its update commit (script line 71). This keeps the test independent of whether GitHub Actions checked out a named branch or detached PR merge commit.
- Added regression assertions to `scripts/windows/installer-config.test.mjs` (test line 1232) for explicit branch creation and the absence of the unsafe `branch --show-current` assumption. This file is already included in `pnpm run test:release-contracts`, which Fast Validation runs.
- Commits: updater smoke fix `ee3078a110701dbd202bfb966ffde61268f1ec70`; regression test `21b409fb1c2fefda026a013027668906190193f8`.
- Validation: Fast Validation #655 passed the Linux job. Its `pnpm run test:release-contracts` suite passed **57/57**, including the detached-clone regression; targeted backend regressions passed **184, 0 failed, 2 skipped**. The Windows job passed storage migration, NAS temp-path, official 7-Zip, symlink-metadata, and updater-journal checks, and got past the detached-branch setup. It then exposed a separate shallow-history failure, resolved by the full-history checkout correction documented below; the complete Windows updater smoke passed in Fast Validation #658.
- Scope: test harness only. No application runtime, installer payload, credentials, production data, main branch, or release artifacts were changed.

## Windows updater smoke local remote requires complete Git history (2026-11-05)

- Fast Validation #655 exposed the next failure after the detached-branch correction: the temporary local remote could not traverse the parent history of the checked-out PR merge commit. The Windows log reports a missing base commit object (`694a055aeb10a41ee8e98f5b776faef89cbd449d`) and `remote did not send all necessary objects`; the updater smoke stopped in `Initialize-DeveloperGitCheckout` before exercising the remaining update/rollback cases.
- Root cause: the Windows job in `.github/workflows/fast-validation.yml` used the default shallow `actions/checkout` depth. Cloning that workspace as a local test remote copied an incomplete history. The Windows updater smoke needs the full ancestry of the PR merge commit so its temporary remote can serve parent objects.
- Changed the Windows smoke job checkout to `fetch-depth: 0` and added a regression to `scripts/windows/installer-config.test.mjs` that asserts this job keeps full history. The test is included in `pnpm run test:release-contracts`.
- Commits: workflow `4d12053312d1ab139cb841d3bc553387b24afa36`; regression `5f2045d4b18843097906f9fd8924642ebf3f11fc`. The detached-branch test fix remains in `ee3078a110701dbd202bfb966ffde61268f1ec70`, with its runtime reproduction in `49b8c1360674e1468ea24403d65a32381ba58208` and accurate branchless fixture in `3462a7cf6e2f5d16326e0d321001042751e76d17`.
- Validation: an isolated Node regression reproduced a detached source checkout with no local branch refs, cloned it, verified the parent commit remained readable, and successfully created the explicit smoke branch (**1/1 passed**). The workflow checkout assertion was evaluated against the current workflow and passed. Final Fast Validation **#658** on code head `2146bcca206582619bcf4ea1caad2a987deac148` completed successfully: Linux validation passed; `pnpm run test:release-contracts` passed **58/58** (including both new updater regressions); targeted backend regressions passed **184**, with **0 failures and 2 skipped**; the Windows archive/updater job passed all steps, including the full developer updater preservation/rollback smoke (`Windows updater smoke passed: full-version update, preservation, and rollback.`). Dependency Review **#422** also passed. Run #657 was superseded/cancelled; #658 is the complete successful run.
- Scope: CI/test harness only. No application runtime, user media, credentials, production data, main branch, or release artifacts were changed.


## Awaiting-action conversion retry no longer discards staged outputs (2026-11-05)

- Confirmed that `POST /optimize/jobs/:id/retry` accepted both `failed` and `awaiting_action`. For an awaiting-action job it recursively removed `resultJson.stagingDir`, then cleared `resultJson` and reset the job to `pending`. After an interrupted/partial finalization, the staging directory can still contain the only remaining converted outputs; retry therefore provided a direct way to destroy recoverable work and its job-level file list.
- Changed retry eligibility to `failed` only. An `awaiting_action` job now receives HTTP 409 before any update or filesystem mutation, with an explanation that staged outputs must be preserved for finalization/recovery. Removed the retry-time recursive staging deletion.
- Added a regression to `artifacts/api-server/src/__tests__/optimize-job-claim.test.ts`. It asserts the retry guard is before the state reset, returns 409 for non-failed states, and the retry handler no longer removes staging or accepts `awaiting_action`. The UI already marks only failed jobs retryable.
- Commits: implementation and initial regression `4c16ad10e178f2019faa65b2de732ff4b6d39eea`; corrected the regression's source-boundary assertion `55bb016463c65004d0c4538d047dd3e12c8f54a4`.
- Validation: Fast Validation #659 failed only in the new test because its assertion assumed the Drizzle `.update()` call was on the same line as `await db`; inspection of the log confirmed this was a test assertion defect, not an application failure. The assertion was corrected to find `.update(conversionJobsTable)` after the guard. Fast Validation #660's Linux job then passed typecheck/generated contracts, Expo configuration, desktop web-server safety, release/storage contracts, official 7-Zip compatibility, and targeted backend regressions (**185 passed, 0 failed, 2 skipped**); the new retry regression explicitly passed. Dependency Review #424 passed. The Windows archive/updater job was still running when this entry was written; its final outcome is recorded separately if it completes.
- Test limitation: the new regression is a source-contract test, not a live HTTP/database integration test of the retry endpoint. The full `optimize-cycle.test.ts` integration workflow was not run by Fast Validation.
- Remaining limitation: this guard prevents the retry endpoint from explicitly deleting an awaiting-action staging directory, but it does not make finalization transactional. The confirmed partial-finalization defect remains: missing staged files and per-file failures can still be followed by staging cleanup and a `done` status; replace/archive/recycle can still move or remove originals before output publication. Durable per-file intent/result journaling, atomic finalization claiming, no-replace publication, and crash recovery remain the critical next work. Do not treat this retry guard as a complete conversion data-loss fix.


## Fast Validation #660 completed across Linux and Windows (2026-11-05)

- Fast Validation [#660](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41964162188) completed successfully for code/test commit `55bb016463c65004d0c4538d047dd3e12c8f54a4`.
- Linux validation passed TypeScript and generated contracts, Expo configuration, desktop web-server safety, database backup/release/storage contracts, official 7-Zip 26.05 compatibility, and targeted backend regressions (**185 passed, 0 failed, 2 skipped**). The conversion retry guard regression passed in that targeted suite.
- The Windows archive/updater job also passed: storage-migration concurrency/no-overwrite tests, NAS temp-path/cleanup checks, official Windows 7-Zip hash verification, cross-platform symlink metadata parsing, updater journal writes, and the full developer updater preservation/rollback smoke.
- Dependency Review [#424](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41964162185) passed on the same code/test commit.
- The subsequent commit `9cce52233fa7c7e018d0d7512ab3a491db617ea2` records the Linux result while the Windows job was running; this entry records the final successful Windows outcome. No application code or tests changed after the successful #660 validation. No production data, credentials, main branch, or release artifacts were touched.


## Conversion scan, JPEG analysis, and NAS path-safety corrections (2026-11-05)

### Unreadable conversion directories were silently omitted

- Confirmed that walkForConversion swallowed every readdirSync error and returned as though the directory were empty. An inaccessible nested directory could therefore be omitted from the conversion job; an unreadable root could be mistaken for a library with no convertible files.
- Changed the walker to throw a path-specific error. The existing execution error handler now marks the job failed rather than treating an incomplete traversal as a successful empty scan. No source files are modified by this scan failure.
- Added a regression to artifacts/api-server/src/__tests__/optimize-job-claim.test.ts covering the fail-closed walker and the execution route's failed-state handling.

### JPEG analysis errors were incorrectly treated as “already optimal”

- Confirmed that analyzeJpegFile returned an empty issue list for every exception, and its file-size lookup converted statSync failures to zero. The execute path interprets an empty list as “already optimal”, so a missing, unreadable, or uninspectable JPEG could be silently skipped instead of reported.
- Analysis and file-size errors now propagate as a path-specific error. The execute path records the file as failed, increments failedFiles, emits a failed file_done event, and continues with the remaining files. It no longer classifies analysis failure as an optimal file.
- Added a regression covering error propagation and per-file failed accounting. The scan-time Promise.allSettled path still leaves a failed analysis without a cached decision; execution rechecks it and records the failure rather than assuming it is optimal.

### Conversion staging and finalization paths needed NAS-root checks

- Confirmed that conversion staging used recursive fs.mkdirSync, which follows an existing symlink in WillardAI/conversions or a nested staging directory. Finalization also trusted persisted stagingDir, original, staged, and output paths without checking them against the active NAS root.
- Staging root and per-file staging directories now use the existing ensureDirectoryWithinRoot helper. Finalization validates the staging directory, original and staged file paths, converted output, keep-both output, archive destination, and trash destination with assertWithinRoot before filesystem operations and validates the staging path again before recursive cleanup.
- Added a route-wiring regression. The existing nas-storage-paths.test.ts suite exercises the helper's symlink rejection on real temporary directories; it is part of Fast Validation.
- Limitation: these checks reject existing/stable symlink escapes and out-of-root persisted paths, but they do not eliminate a time-of-check/time-of-use race between canonical path validation and a later path-based filesystem operation. Strong race resistance requires handle-relative operations or a journaled filesystem transaction.

### Validation for these changes

- Code/test head: 55ad1c17c1851532d0de343365e4157948c6d998.
- Fast Validation #666 (https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41974529162): Linux job passed TypeScript/generated contracts, Expo configuration, desktop web-server safety, release/storage contracts, official 7-Zip 26.05 checks, and targeted backend regressions (188 passed, 0 failed, 2 skipped). All three new conversion regressions explicitly passed. The overall run was later cancelled when the documentation-only commit triggered #667; the Windows updater smoke had printed its success line before cancellation, but #666 has no successful overall conclusion.
- Fast Validation #667 (https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41974879054) is the current full validation on the documentation commit 92970b99301777dd125af337e51b0470c9c5f9fe. Its Linux job completed successfully with the same 188 passed, 0 failed, 2 skipped, including all three new conversion regressions. Its Windows archive/updater job has passed the storage-migration concurrency/no-overwrite tests, NAS temp-path/cleanup checks, official Windows 7-Zip verification, cross-platform symlink metadata checks, and updater-journal writes; the final developer-updater preservation/rollback step is still running. No full #667 pass is claimed yet.
- Dependency Review #430 (https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41974529111) and #431 (https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41974879139) passed.
- Test limitation: the new route regressions are source-contract tests, not live HTTP/database integration tests. The full optimize-cycle.test.ts integration path was not run by Fast Validation.

### Critical conversion finalization remains unresolved

The path checks above do not make conversion finalization transactional. Confirmed destructive gaps remain:

1. A missing staged output is still silently skipped.
2. Per-file finalization failures can still be followed by staging-directory deletion and a job status of done.
3. replace can unlink the original before the staged output is installed.
4. archive and recycle can move the original before output publication succeeds.
5. fs.renameSync can replace an existing destination on POSIX; cross-format output and _optimized keep-both paths are not protected by no-replace publication.
6. Concurrent finalization requests are not protected by an atomic claim, and there is no durable per-file intent/result journal for crash recovery.

Do not treat the scan, JPEG-analysis, or path-boundary fixes as a conversion finalization/data-loss fix. The next safe implementation should adapt the existing organization engine's persisted move-intent, verifiedMove, no-overwrite, and rollbackMoves patterns to conversion finalization, with an atomic job claim and crash recovery. The finalization rewrite was not attempted in this pass because a partial patch could strand or overwrite user media.

### First-run authentication bootstrap remains an unresolved deployment/security decision

- Reconfirmed that /auth/setup is in the public-path allowlist and the setup route accepts the first password while passwordHash is null, without an owner-provisioning token or local-only restriction. The API currently calls app.listen(port) without an explicit loopback host restriction.
- On an uninitialized instance reachable by an untrusted network visitor, the first visitor can claim the initial administrator password. This is a concrete exposure if the service is deployed publicly or on an untrusted LAN.
- No code change was made: a safe fix depends on the intended deployment model and owner bootstrap mechanism (for example, installer-generated one-time setup secret or explicit local-console provisioning). A rate limit alone would not prevent first-visitor takeover.


## PNG-to-JPEG conversion safety (2026-11-05)

- Confirmed a media-preservation defect: the PNG scan inspected only the first 20 files in each extension group, ignored metadata-read failures, and used that sample-level result to label the entire group convertible. The execution path did not independently validate PNG transparency, bit depth, or animation before encoding PNG bytes to JPEG. A transparent, 16-bit, animated, or unreadable PNG outside the sample could therefore be converted in a way that discarded image information.
- Added a shared fail-closed PNG classifier. JPEG conversion is allowed only when metadata positively identifies a valid opaque, static, 8-bit PNG. Missing dimensions, unknown alpha state, non-8-bit depth, invalid page counts, transparency, and animation are preserved.
- Scan-time PNG analysis now covers every tracked path in bounded batches, records per-file decisions, and marks the extension group for attention when any file is unsafe, uninspectable, or beyond the scan path cap. The execute path rechecks each PNG immediately before conversion, so a stale scan decision cannot authorize a newly changed unsafe file. Files without cached decisions are still analyzed at execution.
- Bumped the optimization scan cache version from 6 to 7 so old sample-only PNG classifications are not reused.
- Corrected the user-facing PNG explanation: PNG-to-JPEG is explicitly described as lossy; the previous copy incorrectly called it lossless and claimed pixel data was identical.
- Added pure classifier regressions for opaque 8-bit PNGs, transparency, high bit depth, animation, missing metadata, and invalid page counts, plus route-contract regressions for bounded full-path analysis, execution-time rechecking, cache invalidation, and truthful copy.
- Fast Validation #668 (https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41979142120), code/test head `35bccee65a154e9967c64c562a8379a47acf8983`: Linux and Windows validation both completed successfully. TypeScript/generated contracts and all pre-test validation steps passed; the targeted backend suite reported 197 passed, 0 failed, 2 skipped (199 total). All six PNG classifier tests and all three PNG route-contract regressions passed. The Windows archive/updater smoke job also passed, so the overall workflow conclusion is success.
- Dependency Review #432 (https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41979141989) passed.
- These are focused unit/source-contract tests; a full HTTP/database conversion integration run with real Sharp-generated transparent, 16-bit, and animated PNG fixtures remains outstanding.
- This fix reduces PNG conversion risk but does not resolve the separately documented conversion-finalization transaction/data-loss gaps (replace ordering, no-overwrite publication, partial failure cleanup, concurrent finalization, and crash recovery).

## Conversion worker ownership and restart recovery (2026-11-05)

- Confirmed a multi-instance reliability race in `recoverInterruptedConversionJobs`: startup recovery unconditionally changed every `running` conversion job to `failed`. If a second API process started while another process was actively converting, it could incorrectly mark the live job retryable. A concurrent retry could then overlap the original worker.
- Confirmed that conversion execution had a database compare-and-swap claim, but finalization had no equivalent ownership guard. Two simultaneous finalize requests could both observe `awaiting_action` and mutate the same staged files.
- Added a shared PostgreSQL session advisory lock, namespaced separately for conversion jobs and keyed by job ID. Execution and finalization acquire the same lock before reading/claiming the job and hold the same pool connection until the operation exits. Startup recovery uses `pg_try_advisory_lock`, skips jobs held by live workers, and conditionally updates only rows that are still `running`.
- The lock helper verifies unlock before returning a connection to the pool. If unlock cannot be verified, it discards the connection so a potentially-held session lock is not returned to another request.
- Corrected execution error handling: the route now records whether its pending-to-running compare-and-swap succeeded. A connection/preflight failure before ownership is claimed no longer changes a pending job to `failed`; after a successful claim, failure updates are conditional on the row still being `running`.
- Added five focused lock-helper regressions (successful acquire/release, busy lock, query failure, failed unlock, invalid ID), route-contract tests for execution/finalization/recovery lock ordering and claim-aware failure handling, and a real PostgreSQL integration test using independent connections. The PostgreSQL test verified mutual exclusion, release after explicit unlock, and automatic release when the owning connection is destroyed.
- Fast Validation #41989315095 (https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41989315095), code/test head `4b7d1c1e0fdda4be1f18eaef9fe3c9ffffc394ee`: **passed**. TypeScript and generated API contracts passed; the PostgreSQL advisory-lock integration test passed (1/1); the targeted backend regression suite reported 204 passed, 0 failed, 2 skipped (206 total). The Windows archive/updater smoke job also passed, including storage migration concurrency/no-overwrite, NAS path cleanup, official 7-Zip symlink metadata, updater journal writes, and full updater preservation/rollback.
- Dependency Review #41989315288 (https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41989315288) passed.
- An additional live-database regression was added to `conversion-recovery.test.ts` to verify that startup recovery skips a locked active job and recovers it after unlock. That API/database integration suite is not part of Fast Validation #41989315095; it remains unexecuted in this PR run. The source-contract recovery test and independent-connection PostgreSQL lock test did pass.
- Limitation: session advisory locks are cooperative. Every concurrently running API instance must use this lock protocol and preserve the PostgreSQL session connection. If a connection is lost while its process continues executing filesystem work, the database lock can be released before the process stops; a durable fencing token/lease and per-operation checks would provide stronger protection. This change does not claim to solve that failure mode.
- The critical conversion-finalization data-integrity issue remains open: missing staged outputs are still silently skipped; `replace` still deletes the original before publishing the converted output; archive/recycle still move originals before publication; destination renames can overwrite existing files; and partial failures can still be followed by staging cleanup and a `done` status. The advisory lock prevents concurrent finalizers but does not provide per-file transaction journaling, rollback, or crash recovery.
- The first-run `/auth/setup` administrator-takeover exposure also remains unresolved pending a safe owner-provisioning decision.
- Next priority: implement durable per-file conversion intent/result journaling, no-overwrite publication using the existing organization move helpers, verified rollback, and crash recovery. Keep original media recoverable until the replacement is verified and its journal checkpoint is durable.



## Conversion finalization preservation and rollback (2026-11-05)

- Confirmed the finalizer could silently skip missing staged outputs, delete originals before replacement publication, overwrite an existing destination through POSIX rename semantics, continue after per-file failures, remove the staging directory, and mark the job `done` despite incomplete finalization.
- Added `artifacts/api-server/src/lib/conversion-finalize.ts` and routed both finalization endpoints through it. The helper preflights every successful result before changing any file, requires regular original/staged files under the active NAS/staging roots, hashes both sides, rejects missing staged outputs and destination/backup collisions, and uses the existing `verifiedMove` helper (exclusive no-replace publication plus SHA-256 verification).
- `replace` now moves the original into a private `.originals` backup inside the job's staging directory, publishes the verified output, and only removes that backup when the database has committed the job as `done`. `archive` and `recycle` first move originals into recoverable destinations; `recycle` consistently uses WillardAI's `.Trash` on all platforms, matching the UI's stated behavior and avoiding a Windows OS Recycle Bin side effect that cannot be rolled back deterministically. `keep-both` and all other output publication paths refuse to overwrite an existing destination.
- Any ordinary filesystem failure triggers reverse-order `rollbackMoves`. If rollback completes, the job remains `awaiting_action`, the staging files remain available, and the API returns a conflict with the failure detail. If rollback is incomplete, the unresolved move records are stored in `resultJson.finalizationRecoveryMoves` and subsequent automatic finalization is blocked pending manual recovery. The job is marked `done` only after all planned file operations have been verified and the database status update succeeds. Staging cleanup happens last; cleanup failure is logged and leaves extra recoverable files rather than undoing a committed result.
- Added six filesystem regressions: replace keeps the original backup until commit; missing staged output fails before mutation; existing cross-format destinations are not overwritten; keep-both sibling collisions are rejected; a mid-finalization destination race rolls prior moves back while preserving the competing file; and recycle uses the app-managed trash. Updated the route-contract test and added the new test file to Fast Validation.
- Commits: implementation `b8343d309812ea0386e3eebd7475e698a09dfcbf`; rollback-race regression and rollback count check `57d5acc925b1ecdb4435b4a6389aca4524bdc704`; corrected cross-format replace assertion `8e8873fab5c5a701cb7e1f2c7d445e5b38cb8b0b`.
- Fast Validation #675 (https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41997697766), code/test head `8e8873fab5c5a701cb7e1f2c7d445e5b38cb8b0b`: **passed overall**. TypeScript and generated API contracts passed; PostgreSQL advisory-lock integration passed (1/1); targeted backend regressions reported 213 tests, 211 passed, 0 failed, 2 skipped. All six new conversion-finalization filesystem tests and the route-contract regression passed. The Windows archive/updater job also passed, including official 7-Zip staging, symlink metadata compatibility, updater journal writes, and full updater preservation/rollback.
- Dependency Review #439 (https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41997697876) passed.
- Limitation: the new rollback is an in-process safety boundary, not a durable per-file intent/result journal. A process or database connection can fail after a filesystem move but before the final job-status update. The original remains in the job staging backup, archive, or app trash and staging is not cleaned, but the job does not yet automatically reconcile that state after restart; manual recovery may be required. A durable pre-move journal, idempotent reconciliation, and crash-recovery tests remain the next step. The full HTTP/database conversion-finalization integration flow is also not part of Fast Validation; the new filesystem tests exercise the production helper directly.
- The first-run `/auth/setup` administrator-takeover exposure remains unresolved pending a safe owner-provisioning model. No authentication behavior was changed in this pass.
- Next priority: persist per-file finalization intent before each move, reconcile intent against source/destination hashes after restart, and test crashes at every boundary. Then address first-run owner provisioning without locking legitimate local installs out of setup.


## Windows conversion-finalization cross-platform check and transient download failure (2026-11-05)

- Added the six production-helper filesystem regressions to the Windows Fast Validation job as well as Linux. Fast Validation #676 (https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41998355343), workflow head `e73e43dc16c6595456807dda671f9828cec80c15`: Linux validation passed (213 tests, 211 passed, 0 failed, 2 skipped); the Windows conversion-finalization test step passed all 6 tests. The full Windows job then failed at the later official 7-Zip download step, before the archive/updater checks, because GitHub Releases returned HTTP 504 from `Invoke-WebRequest` at 2026-11-05 08:59:29 UTC. This was a transport failure, not a conversion-finalization test failure. Do not treat #676 as an overall passing run.
- The Windows failure confirmed a reliability gap in `scripts/windows/prepare-official-7zip.ps1`: a single transient release-download timeout aborted the entire Windows validation/installer staging path. Added four bounded download attempts with 2/4/8-second backoff and partial-file cleanup. The pinned SHA-256 comparison remains outside the retry loop; a checksum mismatch still fails immediately and is never retried or accepted.
- Added `scripts/windows/prepare-official-7zip-retry.test.mjs` to verify the bounded retry loop, partial-file cleanup, backoff, terminal error, and strict post-download checksum verification. Added it to Fast Validation.
- Commits: Windows conversion-finalization test/workflow `e73e43dc16c6595456807dda671f9828cec80c15`; download retry implementation and regression `3ab7bbbec83417656a1d30ed09e63a19004b25bc`.
- Dependency Review #441 (https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41998875173) passed. Fast Validation #677 (https://github.com/christopherlwillard-debug/willard-ai/actions/runs/41998875126), head `3ab7bbbec83417656a1d30ed09e63a19004b25bc`, is running; the retry regression and new Windows run have not yet been claimed as passing.
- Remaining conversion limitation: the rollback is still in-process, not a durable per-file intent/result journal. A process or database connection can fail after a filesystem move but before the final status update. Originals remain in staging backup, archive, or app trash and staging is not cleaned, but automatic restart reconciliation and the full HTTP/database conversion-finalization integration flow remain outstanding.


## Durable conversion finalization journal and startup ordering (2026-11-05)

- Confirmed a process-crash window remained after the in-process rollback change: a finalization move could finish on disk before its completion record / final `done` update reached PostgreSQL. After restart, the job could remain `awaiting_action` without enough durable information to know which original or staged paths had moved.
- Added a durable `finalizationJournal` to each conversion job's existing `result_json`. For every backup or publish move, the finalization route now commits a pre-move intent containing source path, destination path, and expected SHA-256 before calling `verifiedMove`; after verification it checkpoints the completed move record. If the intent checkpoint fails, no filesystem mutation is attempted.
- The finalization helper retains all intent records and unresolved records separately. Ordinary errors still attempt reverse-order `rollbackMoves`; incomplete rollback retains the full journal and unresolved moves, and automatic finalization remains blocked.
- Added request-time reconciliation under the existing per-job advisory lock before another finalization attempt. Startup recovery now scans `awaiting_action` jobs with non-empty journals, acquires the same lock, validates both paths against the job's NAS root, and uses the existing no-overwrite/hash-verified rollback helpers. A complete rollback clears the journal and leaves the job retryable; a changed, missing, malformed, or out-of-root record is retained for manual recovery. An ambiguous rollback count also fails closed instead of clearing the journal.
- Confirmed a separate startup-order bug: `app.ts` invoked conversion recovery during module evaluation, before `index.ts` awaited `startupMigrations`. On a fresh or schema-upgrade startup, a recovery query could therefore run before required schema was ready and would not be retried. Moved the conversion recovery call to the post-migration `app.listen` callback in `index.ts`; it runs in the background and does not delay listener readiness. Corrected the log message because the recovery count now includes rolled-back finalization journals as well as interrupted running jobs.
- Added focused filesystem regressions for: intent-before-mutation / completion-after-verification ordering; restart after a move but before completion checkpoint; restart before the move begins; a changed backup that must remain untouched; and an out-of-root journal path that must never be operated on. Added route/startup source-contract coverage.
- Added a real PostgreSQL integration test using a disposable database and temporary filesystem roots. It verified startup recovery restores an original and clears the journal (1 test), and preserves a changed backup while durably retaining the recovery block (1 test).
- Fast Validation #689 (https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42001467742), code/test head `a014703151dbcf9ea37f3ac13aab2299c1736a16`: **passed overall**. TypeScript and generated API contracts passed. The targeted backend suite reported 220 tests, 218 passed, 0 failed, 2 skipped. The PostgreSQL finalization-recovery integration step passed 2/2. The Windows job passed the conversion-finalization filesystem tests, NAS/storage safety checks, official 7-Zip hash verification and symlink compatibility, updater journal writes, and the full updater preservation/rollback smoke.
- Dependency Review #453 (https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42001467787): **passed**.
- Commits: `de8da5de` (durable move-intent callbacks), `aa7630f2` (route checkpoints and request-time recovery), `a3bf319d` (startup journal reconciliation), `8b115eaf` (filesystem crash-recovery tests), `3a2c91a7` (route-contract regression), `29062d89` (ambiguous recovery fails closed), `b7d12620` (PostgreSQL recovery integration), `16731291` (CI step), `3c8652e5` and `a544c271` (post-schema startup ordering), `a0147031` (startup-order regression).
- Remaining limitations: the new PostgreSQL test exercises the actual startup recovery function against temporary files, but the complete HTTP/API finalization flow is still not covered end-to-end. The move helpers do not explicitly fsync every affected parent directory, so sudden power-loss durability is not absolute; the journal makes ordinary process-crash states reconcilable and retains ambiguous states for manual recovery. Advisory locks are cooperative and session-scoped: if a worker loses its PostgreSQL lock connection but continues filesystem work, another process could acquire the lock; a fencing token/lease with checks between moves is still needed. Path operations remain subject to a narrow filesystem TOCTOU race.
- The first-run `/auth/setup` takeover exposure remains unresolved. The endpoint still allows the first unauthenticated visitor to claim an uninitialized instance, and the server listens on its default network interfaces. No authentication behavior was changed because the safe bootstrap model (installer-generated one-time owner secret versus loopback-only setup with an explicit remote-provisioning path) requires an installation/owner-provisioning decision.
- Next priority: secure first-run owner provisioning without locking legitimate local installs out of setup; then add a fencing mechanism for conversion workers so a lost database lock cannot leave an old process mutating files after recovery begins.


## Same-path rollback journal safety (2026-11-05)

- Confirmed a destructive edge case in the shared `rollbackMoves` helper: a malformed or stale journal entry with identical source and destination paths passed the same-inode recovery check, then unlinked the destination name. When both names were the same path, that removed the only copy.
- Added a fail-closed guard before any filesystem inspection or mutation. It compares resolved paths and also compares case-insensitively on Windows. Same-path entries are skipped and remain unresolved; the caller therefore retains the recovery journal rather than reporting a successful rollback.
- Added a regression through the production `recoverConversionFinalizationMoves` path. It supplies a same-path journal entry and verifies recovery is incomplete, the entry remains unresolved, and the original bytes remain present.
- Implementation commit: `b4d5d7d540b97f9f0479fc7e0400fa7b3a17c15e`. Regression commit: `1a6b41f93357ba1a51ae46bb3f2ea147e325b4fd`.
- Fast Validation #42011702175 (https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42011702175), code/test head `1a6b41f93357ba1a51ae46bb3f2ea147e325b4fd`: Linux validation job passed. The targeted backend suite reported 221 tests, 219 passed, 0 failed, 2 skipped. The new same-path recovery regression passed explicitly. TypeScript/generated contracts, Expo configuration, desktop web-server safety, release/storage contracts, official 7-Zip 26.05 compatibility, and both PostgreSQL conversion lock/recovery integration steps passed.
- The Windows job in Fast Validation #42011702175 also passed the conversion-finalization no-overwrite/rollback test step, including the new same-path regression. At the time this report was updated, the later Windows updater preservation/rollback smoke was still running; do not treat the overall workflow as passed until that job completes.
- Dependency Review #456 (https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42011702201): passed.
- Remaining limitations: this guard protects lexically identical paths, including Windows case-only aliases; path-based filesystem operations still have the separately documented TOCTOU exposure. Session advisory locks remain cooperative and need worker fencing. The first-run `/auth/setup` owner-takeover issue remains unresolved pending an explicit bootstrap/provisioning design.
- Next priority: resolve first-run owner provisioning safely, then add conversion-worker fencing so a process that loses its database lock cannot continue filesystem mutations after another process begins recovery.


## Optimization scan fails closed on incomplete directory traversal (2026-11-05)

- Confirmed a separate silent-partial-scan defect in the Optimize Center summary path. `GET /optimize/scan` used `walkForOptimize`, which swallowed `readdirSync` errors and converted per-file `statSync` failures into zero-byte entries. The conversion execution walker already failed closed, but the earlier summary scan could undercount files and savings or present incomplete recommendations as a complete scan.
- Extracted the summary walker into `artifacts/api-server/src/lib/optimize-scan.ts`. Directory enumeration and file metadata failures now throw path-specific errors; file entries are rechecked with `lstatSync` and must still be regular non-symlink files. The existing route error handler returns a failed scan response rather than caching or presenting partial totals.
- Added five filesystem regressions: normal nested grouping and byte totals, missing-root failure with path context, unreadable nested-directory failure (POSIX), symlink exclusion, and positive scan-limit validation. Added the test file to Fast Validation.
- Fast Validation #697 (https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42017375961), head `6aea61e83026609316652dc72daebc6939d5e8ad`, failed one newly-added fixture assertion: the fixture expected two scanned files, but the existing scan contract intentionally counts every recognized extension, including its `.txt` fixture. The production walker behavior was correct; the assertion was corrected to expect three total files and one text file. No other test failed in #697.
- Fast Validation #698 (https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42017739135), code/test head `3aca80b3c59ddaf7141c65a17fa66cc42fa5f012): **passed overall**. TypeScript/generated contracts, Expo configuration, desktop web-server safety, release/storage contracts, official 7-Zip verification, PostgreSQL conversion lock integration (1/1), and PostgreSQL conversion restart-recovery integration (2/2) passed. The targeted backend suite reported 226 tests, 224 passed, 0 failed, 2 skipped. All five new optimization-scan regressions passed. The Windows archive/updater job passed storage migration concurrency/no-overwrite, NAS path/cleanup safety, conversion-finalization rollback/no-overwrite, official 7-Zip hash verification, symlink metadata compatibility, updater journal writes, and full updater preservation/rollback.
- Dependency Review #462 (https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42017739148), head `3aca80b3c59ddaf7141c65a17fa66cc42fa5f012`: **passed**.
- Implementation/test commits: `656b327b9bb52d1e69f3effc68503abf323e584d` (extract fail-closed scan walker and wire route/CI), `054e46bf21e6ba2f5e3177a11129462615abac03` (symlink regression semantics), `2926254953abe5b681bc3f65d8d96fe0971914a3` (filesystem-order-independent assertion), `6aea61e83026609316652dc72daebc6939d5e8ad` (remove obsolete path-limit constant), and `3aca80b3c59ddaf7141c65a17fa66cc42fa5f012` (correct scan-total expectation).
- Historical limitation at the time of this finding: the 500,000-file cap had no user-facing indicator. The follow-up below adds scanLimitReached/scanLimit, cache-version invalidation, an Optimize Center warning, and an exported-report marker. The fixed cap remains; the flag is intentionally conservative and may warn when a library contains exactly 500,000 recognized files.
- The first-run `/auth/setup` owner-takeover exposure remains unresolved for publicly hosted deployments: the first unauthenticated visitor can still claim an uninitialized Replit instance. Local non-Replit API and Vite listeners now default to loopback; explicit HOST=0.0.0.0 can intentionally expose a non-Replit hosted deployment. Conversion worker fencing also remains open: a stale worker that loses its PostgreSQL session lock could still race filesystem operations outside a checked boundary.
- The scan-cap indicator is resolved in the follow-up below. Next priority remains secure first-run owner provisioning, followed by stronger conversion-worker fencing.


## Desktop API network exposure (2026-11-05)

- Confirmed the Windows desktop web server binds to `127.0.0.1` and proxies API requests to `127.0.0.1:8080`, but the API process previously called `app.listen(port)` without a host. Node therefore exposed the API listener on network interfaces as well as loopback, allowing LAN clients to bypass the intended desktop proxy.
- The API listener now honors an explicit `HOST` environment variable while preserving the existing default for hosted deployments. The Windows launcher explicitly sets `HOST=127.0.0.1` before starting the API, restricting the packaged desktop API to the local machine.
- Added a regression contract covering the API host option and the packaged launcher setting.
- This closes the direct LAN listener exposure for the Windows desktop deployment. It does **not** resolve the separate remote first-run `/auth/setup` owner-takeover issue for hosted deployments; that still needs a secure provisioning mechanism.
- The packaged-only correction was broadened to the standard developer/manual local path in the follow-up below. Final combined validation is pending.


## Audit batch — cryptographic Windows session-secret generation

**Finding:** Both Windows first-run launchers generated new `SESSION_SECRET` values with PowerShell `Get-Random`. That generator is not intended for cryptographic secrets, so new desktop/developer installations did not use the operating system's cryptographic random-number generator.

**Correction:** The source launcher and packaged desktop launcher now generate 32 random bytes with .NET `RandomNumberGenerator`, dispose the RNG instance, and encode the bytes as 64 lowercase hexadecimal characters. Existing `.env` secrets are preserved; only new settings-file creation is affected.

**Regression coverage:** Added a source-contract test requiring cryptographic RNG use in both launchers and rejecting the former `Get-Random` session-secret construction.

**Verification status:** The initial source change exposed a malformed duplicate helper block in an intermediate commit; scripts/launcher/common.ps1 was restored to one helper set and Ensure-EnvFile was repaired. The writer now uses UTF-8 without a BOM so Windows PowerShell 5.1 output is readable by Node's --env-file. Source regressions, a PowerShell parser step, and a real Windows env-file/Node smoke are committed; final combined validation is pending.

**Risk remaining:** The separate first-run administrator provisioning issue remains unresolved. This secret-generation correction does not close the unauthenticated `/auth/setup` exposure.


## Optimize Center scan-limit reporting (2026-11-05)

**Confirmed issue:** The Optimize Center summary walker stopped at 500,000 recognized files but returned no indication that the cap had been reached. Counts, storage totals, savings estimates, and per-file video decisions could therefore look exhaustive when they represented only a prefix of a large library.

**Correction:**
- OptimizeScanCounter now records limitReached as soon as the configured cap is reached. This is deliberately conservative: exactly 500,000 files also raises the warning because the walker stops without scanning beyond the cap.
- The scan and status responses include scanLimitReached and scanLimit; the recommendation key includes completeness state.
- Scan cache version increased from 7 to 8 so older cached records cannot be presented as complete.
- Optimize Center displays a visible partial-scan warning and the exported report records whether the limit was reached.
- The warning explains that counts/estimates cover only scanned files and that video files outside the per-file analysis window are safely skipped during conversion.

**Regression coverage:** Added direct walker tests for reaching the cap and staying below it, plus route/cache/UI wiring assertions. The existing fail-closed scan, symlink, and metadata regressions remain in the targeted suite.

**Validation history:**
- Fast Validation #703 (run 42028657169) initially failed one stale source-contract assertion that still expected cache version 7. The application code had intentionally moved to version 8; the assertion was corrected in commit 2fcdf48315c75148d92a40d21dfa7af4927324dc.
- Fast Validation #704 (run 42029108847), on code/test head 2fcdf48315c75148d92a40d21dfa7af4927324dc, passed Linux validation: 229 backend tests, 227 passed, 0 failed, 2 skipped. The Windows job was superseded by later launcher-security commits and is not claimed as a completed pass for that head.
- Dependency Review #468 (run 42029108841) passed.
- The current combined branch includes further listener and Windows launcher hardening; its final Fast Validation is pending.

**Commits:** 4800c9aa (walker limit state), 6757ef6a (API/cache wiring), c2c44fdb (walker and route/UI regressions), e9483206 (Optimize Center warning/report), 2fcdf483 (cache-version regression correction).

**Remaining limitation:** There is still no pagination or resumable scan. Libraries beyond the 500,000-file cap receive a partial summary, but it is now explicitly labelled. The flag may be conservative when a library contains exactly the cap and no more recognized files.

## Local API and Vite listeners default to loopback off Replit (2026-11-05)

**Confirmed issue:** The packaged desktop launcher was corrected to set HOST=127.0.0.1, but review of Start Willard AI.bat, scripts/launcher/start.ps1, and the manual two-terminal flow in LOCAL_SETUP.md found a second local path. That launcher started the API without a host, while Vite dev and preview servers were configured for 0.0.0.0 even outside Replit. A LAN client could reach the Vite proxy and API from a local installation.

**Correction:**
- The developer launcher sets HOST=127.0.0.1 before starting the API.
- The API defaults to 127.0.0.1 when REPL_ID is absent and HOST is unset. An explicit HOST still overrides; Replit retains its wildcard listener.
- Vite dev and preview listeners use 127.0.0.1 off Replit and 0.0.0.0 on Replit.
- The packaged desktop launcher also explicitly sets HOST=127.0.0.1.

**Regression coverage:** install-auth-reliability.test.ts checks the API host default, developer launcher ordering, and both Vite listener hosts. These are source-contract tests, not a live socket reachability test.

**Validation:** The latest combined validation is pending. The prior Fast Validation #711 was cancelled when the branch advanced; no overall pass is claimed for that run.

**Remaining limitation:** An explicit HOST=0.0.0.0 can intentionally expose a non-Replit deployment. The public Replit instance still needs secure first-run owner provisioning; loopback defaults do not fix remote /auth/setup takeover.

## Windows launcher session-secret, helper, and env-file hardening (2026-11-05)

**Confirmed issues and corrections:**
- Both Windows first-run launchers previously used PowerShell Get-Random for new SESSION_SECRET values. Both now generate 32 bytes with .NET RandomNumberGenerator and encode 64 lowercase hexadecimal characters.
- An intermediate helper update duplicated 17 shared functions and split the Ensure-EnvFile replacement command, leaving common.ps1 malformed. The file was restored to one helper set; Ensure-EnvFile now contains its complete write operation.
- Start Willard AI.bat invokes Windows PowerShell 5.1, whose default Set-Content encoding is UTF-16LE. Node's --env-file expects UTF-8. The developer launcher now writes the updated .env using UTF8Encoding(false) and File.WriteAllLines, avoiding a BOM and UTF-16 output.

**Regression and validation work:**
- installer-config.test.mjs now requires 32-byte cryptographic buffers, rejects the old Get-Random construction, verifies helper names are unique, and checks the complete UTF-8 write occurs inside Ensure-EnvFile.
- The Windows workflow now parses every PowerShell script under scripts/launcher, scripts/windows, and desktop.
- A Windows runtime smoke dot-sources the real common.ps1, creates a temporary .env, and verifies Node can read the generated 64-character secret with --env-file.

**Commits:** 248e7ab356ffec52f52894dfa245116fbde3d380 (restore single helper set and repair secret persistence), 8c8e930c64b76186ee58139b590e9f661b5a8f37 (duplicate-helper and env-body regression), 3c4fcb0f088ad506389d77a47c8aa64493ab1ecb (PowerShell parser CI), 777bbebf96f39b9b33d06285a5515f1af3ca44b2 (repair source assertions), 9bd3478bb9d7b2751ab634818db907fa3c15a586 (UTF-8 no-BOM writer), e1edcfa06897ac22604c399f92c56df2aeeaa907 (UTF-8 regression), 55727ad49ebae4c2a67f3c785861f6e1308d63ce (Windows runtime smoke), c2c00e9cb80d07aea17cd4dfd303fe5f79ad3181 (256-bit buffer assertions).

**Validation status:** The latest combined Fast Validation has not yet completed. The earlier run #719 on c2c00e9 was cancelled by later commits; the current Windows parser and env-file smoke must pass before this batch is called validated.

**Remaining limitation:** These changes harden local installation secrets and listener exposure but do not fix the public first-run /auth/setup takeover issue for hosted deployments. That still needs an explicit bootstrap/owner-provisioning model.


## 2026-11-05 follow-up — conversion retry claim race

- Confirmed a retry race in `POST /optimize/jobs/:id/retry`: the route read a job as `failed`, then reset it using only the job ID. A concurrent request or worker could change the job after that read, and the stale retry could reset a newly running or otherwise changed job.
- Changed the reset to a compare-and-set update requiring the same job ID, active NAS path, and `failed` status. If the row no longer matches, the route now returns HTTP 409 and leaves the changed job untouched.
- Added a regression assertion covering all three predicates and the conflict response in `optimize-job-claim.test.ts`.
- Validation: GitHub Actions has not yet completed for this follow-up commit; do not treat this source change as validated until the targeted test and workflow pass.


## 2026-11-05 follow-up — remote first-run administrator takeover

- Confirmed that `POST /auth/setup` was public and only relied on the first password-row write winning. Atomicity prevented two successful setups, but it did not establish that the first requester was the owner.
- Added a fail-closed bootstrap authorization helper. Requests from IPv4/IPv6 loopback may complete local desktop setup without a token. Requests from LAN or public addresses must provide the server-side `WILLARD_SETUP_TOKEN`, configured with at least 32 characters. Missing or undersized server configuration returns HTTP 503; a missing or incorrect supplied token returns HTTP 403.
- The supplied token is compared in constant time, is not logged, and is only accepted by the first-run setup endpoint. Setup attempts are rate-limited to five per 15 minutes. Existing password setup, login, recovery, and session behavior are otherwise unchanged.
- Added a first-run token field to the setup screen, documented the environment variable in the API contract, updated the generated request type, and added direct helper plus route-source regression tests.
- Hosted/LAN deployment action: before exposing a fresh installation, set a unique `WILLARD_SETUP_TOKEN` server secret (generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) and enter the same value in the first-run screen. Do not commit the secret. Local desktop setup from localhost remains token-free.
- Validation: pending GitHub Actions on the audit branch. No production credentials or data were changed. Existing installations with a password are unaffected; the guard only matters while the first-run password is unset.

- Hardening detail: the loopback exception uses the TCP socket peer address rather than `req.ip` or `X-Forwarded-For`, so a client cannot spoof a localhost address through forwarded headers. The helper's five isolated Node tests passed in a staged-copy run; the full repository workflow remains unverified.

## 2026-11-05 audit batch — reverse-proxy-safe first-run setup authorization

**Finding (high, deployment-dependent):** The first-run setup guard treated a loopback TCP socket peer as sufficient proof that the browser was local. Express trusts a reverse proxy in Replit/production, and a same-host reverse proxy can connect to the API over 127.0.0.1. In that topology, a remote browser can appear to have a loopback socket peer. Using `req.socket.remoteAddress` prevents spoofing `X-Forwarded-For`, but does not distinguish a local browser from a same-host proxy.

**Correction:** The loopback exception now requires all of the following: a loopback socket peer, explicit `WILLARD_LOCAL_SETUP=true`, no Replit runtime marker, and `HOST=127.0.0.1`. Only the two supported Windows desktop launchers set the local capability, and they set it before spawning the API. Hosted and generic reverse-proxy deployments must use the operator-provisioned `WILLARD_SETUP_TOKEN`. The local bypass flag is explicitly documented as launcher-owned and must not be placed in `.env`.

**Regression coverage:** Added direct helper tests proving that a loopback peer alone does not bypass setup, that explicit local-launcher opt-in works for loopback, and that the opt-in does not authorize LAN peers. Added source-contract checks for the route's deployment gates and both launcher settings. The helper tests are in `setup-authorization.test.ts`; route/launcher contracts are in `install-auth-reliability.test.ts`.

**Verification status:** Source inspection complete. Targeted tests and Fast Validation are pending for the resulting commit; no full validation claim is made yet. The previous Fast Validation run #737 on code commit `1fa65ad04c465aab3082ec416b6caac8d6d48583` concluded failure. The workflow-job endpoint returned no job details through the available GitHub connection, so the precise failing step could not be verified from that run. This batch adds focused regressions and will trigger a fresh validation run.

**Remaining risk:** The bootstrap token is still a bearer secret and must be provisioned through a trusted deployment secret store and delivered to the legitimate installer/operator out of band. The audit does not alter hosted deployment secrets or production configuration. The complete first-run flow has not yet been exercised against a real reverse-proxy deployment.

## Prioritized findings ledger (current audit snapshot)

| Priority | Finding / affected workflow | Status | Commit / evidence | Remaining risk |
|---|---|---|---|---|
| High | Remote first-run administrator claim — hosted setup | target-tested | Fast Validation #755 passed setup-authorization and install-auth-reliability targeted regressions | Full hosted reverse-proxy integration remains outstanding |
| High | Same-host reverse-proxy loopback ambiguity — first-run setup | target-tested | Fast Validation #755 passed setup-authorization and install-auth-reliability targeted regressions | Live reverse-proxy topology test remains outstanding |
| Critical | Stale conversion worker after advisory-lock connection loss — media conversion/finalization | blocked | Source-reviewed: session lock is on a separate PostgreSQL client; worker filesystem operations and ordinary checkpoints continue outside an atomic filesystem fence | Connection loss releases the DB lock while the old process may still be writing; a second worker can acquire the lock and overlap unless the filesystem mutation gate itself serializes owners |
| Critical | `replace` policy backup/rollback safety — archive/media organization | blocked | Source-reviewed: organize route unlinks the existing destination before it persists the incoming source move intent; current move journal only describes the incoming source | A failed move or crash can permanently lose the displaced destination; requires a durable displaced-file journal and verified restore path |
| High | Malicious link-bearing archive end-to-end behavior on Windows — ZIP/7z extraction | blocked | Fast Validation #754/#755 passed Windows 7-Zip symlink-metadata and official-binary checks; archive-safety regressions passed on Linux | Full Windows organize-route integration against malicious fixtures is outstanding |
| High | Clean standard-user installer upgrade/uninstall lifecycle — Windows installer | blocked | Lifecycle smoke exists in windows-release.yml but is coupled to the release workflow, which publishes artifacts | End-user ACL, service shutdown, upgrade, rollback, and uninstall behavior were not run on this audit branch; do not trigger release workflow for validation |
| Medium | 500,000-file Optimize Center cap — scan/report UX | target-tested | Fast Validation #755 passed optimize-scan regressions; API exposes scanLimitReached/scanLimit and the UI shows a role=alert warning for incomplete totals and skipped video analysis | No pagination/resume; scanner conservatively marks the limit reached at exactly 500,000 |
| Medium | Private media stream I/O error semantics — thumbnail/logo/media preview | target-tested | Fast Validation #755 passed private-media-response and thumbnail-engine targeted regressions | Browser-level interrupted-stream behavior remains to be exercised |
| Medium | Search control accessibility — search, favorites, saved searches | target-tested | Commit e0d69e50; Fast Validation #755 test:ui-contracts passed 2/2 source-contract tests | Browser/screen-reader verification remains outstanding |
| High | Developer updater journal atomic replacement — Windows update/recovery | integration-tested | Commit 69091d09; Fast Validation #754 and #755 both passed Windows developer updater preservation/rollback smoke | Standard-user packaged installer lifecycle remains separate and untested in this audit |

Statuses distinguish code inspection and focused tests from integration and full workflow validation. No blocked item is represented as fixed or fully validated.

## 2026-11-05 audit batch — repair malformed Fast Validation Windows job

**Finding (high, CI/release confidence):** Source inspection of `.github/workflows/fast-validation.yml` found that the Windows environment-file smoke step had been split in the middle of its PowerShell condition. A duplicate copy of the Windows archive/updater steps was interleaved before the condition's closing text, and the complete Windows step sequence remained later in the job. This made the workflow definition malformed and coincided with the latest Fast Validation pushes (#737–#739) failing immediately; the available GitHub job-list endpoint returned zero job records, so no step-level log was available to attribute those failures independently.

**Correction:** Reconstructed the PowerShell smoke step as one complete YAML block, removed the interleaved duplicate job section, and retained exactly one ordered Windows validation sequence. The smoke still creates a disposable environment file, runs the real launcher helper, and verifies that Node reads the generated 64-character hexadecimal session secret as UTF-8.

**Regression/verification:** Added no new runtime dependency. The workflow's own successful parse and execution is the authoritative validation. A new Fast Validation run is triggered by this commit; until it completes, the workflow repair is source-reviewed but not called validated. The earlier runs #737, #738, and #739 remain failures and are not retroactively relabeled.

**Remaining limitation:** The GitHub connection exposes the workflow run status but returned no job records/logs for the malformed runs. The repaired run must create both Linux and Windows jobs and complete them successfully before this batch can be marked fully validated.

## 2026-11-05 audit batch — generated API contract parity for remote setup token

**Finding (high, build/contract correctness):** Fast Validation #740 passed artifact checks, workspace TypeScript, router checks, and both runtime-route parity tests, but failed the final generated-contract drift check. The OpenAPI contract had the optional `setupToken` field and the Zod type file had been edited manually, while the generated React client schema and generated Zod runtime schema were not synchronized. Orval regenerated three files and `git diff --exit-code` correctly rejected the drift.

**Correction:** Committed the Orval-equivalent output for `api-client-react/src/generated/api.schemas.ts`, `api-zod/src/generated/api.ts`, and `api-zod/src/generated/types/authSetupInput.ts`, including the generated max-length constant and schema description. No hand-written API contract or runtime behavior changed in this correction.

**Verification:** The failing run #740 log was inspected. It confirms workspace typecheck passed, runtime-route parity passed 2/2, and Orval code generation completed; the failure was specifically the generated-file diff. This correction triggers a fresh Fast Validation run. Contract parity is not called fixed/validated until the new `check:api-contracts` step passes.

**Remaining limitation:** The bootstrap flow still requires a real hosted reverse-proxy integration test; generated contract parity alone does not validate deployment secret provisioning.

## 2026-11-05 generated-contract validation follow-up

- Fast Validation #741 again reached `check:api-contracts` and failed only on two generated JSDoc indentation differences in `api-client-react/src/generated/api.schemas.ts` and `api-zod/src/generated/types/authSetupInput.ts`. The generated Zod runtime schema now matched exactly; workspace typecheck and runtime-route parity had already passed in #740.
- Corrected the two interface comments to the exact Orval output shown by the #741 diff. The next Fast Validation run will verify the complete generated diff and continue through the backend and Windows jobs.
- Status remains pending until that run completes; no claim of full validation is made.

## 2026-11-05 audit batch — fail-closed Windows installer shutdown

**Finding (high, installer reliability/data preservation):** `PrepareToInstall` launched the packaged `-Stop` helper but ignored both the `Exec` launch result and the helper's exit code. The packaged `Stop-Services` and developer `Stop-TrackedProcesses` functions also ignored `taskkill` outcomes and cleared their PID manifests without confirming the owned processes had exited. An upgrade could therefore continue into `[InstallDelete]` while an old API/web process was still alive, risking a mixed or partially replaced application directory.

**Related confirmed cleanup defect:** `scripts/launcher/common.ps1` contained sixteen duplicate, byte-identical PowerShell helper definitions (`New-WillardShortcut`, `Test-DatabaseConnection`, `Ensure-AppDatabase`, `Read-TrackedPids`, `Clear-TrackedPids`, `Stop-TrackedProcesses`, `Get-EnvValue`, `Wait-ForDatabase`, `Test-PortFree`, `Get-PortOwnerPid`, `Get-ProcessIdentity`, `Test-ProcessIdentity`, `Save-TrackedPids`, `Test-ProcessAlive`, `Get-LogTail`, and `Wait-ForUrl`). The existing uniqueness regression failed with 54 unique names versus 71 declarations because it also counted JavaScript functions inside PowerShell here-strings. The later duplicate PowerShell definitions silently overrode the earlier ones and made future edits easy to apply to the wrong copy.

**Correction:** Removed all sixteen duplicate PowerShell definitions after confirming each pair was identical. Corrected the uniqueness regression to ignore here-string contents and count only actual PowerShell functions. Both stop routines now issue a bounded wait, recheck the exact process identity, retain the PID manifest and throw if an owned process remains. Inno Setup now aborts before payload deletion when the launcher cannot start or returns a nonzero stop result.

**Regression coverage:** Extended `scripts/windows/installer-config.test.mjs` to assert the fail-closed Inno result handling, bounded process wait, identity recheck, and delayed PID-manifest cleanup. The helper-name regression now excludes JavaScript function declarations embedded in here-strings. The test is part of `pnpm run test:release-contracts` in Fast Validation.

**Verification status:** The #742 run confirmed generated API contracts, workspace typecheck, Expo config, and desktop web-server safety passed, then failed in release contracts at the helper-name assertion (54 !== 71). The installer correction and focused regression are committed after that failure; targeted/full validation is pending.

**Remaining limitation:** The new stop guard has source-contract coverage, but a fault-injected Windows integration run where `taskkill` deliberately fails is not yet present. Clean-machine standard-user install/upgrade/uninstall coverage remains a separate blocked milestone.

## 2026-11-05 audit batch — restore developer launcher environment-file generation

**Finding (high, installer/startup correctness):** The #744 release-contract test failed because `Ensure-EnvFile` in `scripts/launcher/common.ps1` ended at an unterminated `-replace '^SESSION_SECRET=.*` expression. The function never wrote the generated 256-bit secret back to `.env`, and the PowerShell source was syntactically incomplete. The existing UTF-8/no-BOM regression caught the missing `WriteAllLines` call before the Windows smoke could run.

**Correction:** Restored the complete anchored replacement expression, writes the updated environment file with `UTF8Encoding(false)`, and preserves the OS-generated 32-byte cryptographic secret. This makes the developer launcher setup path consistent with the packaged launcher and the existing security requirement.

**Verification:** Fast Validation #744 reached release contracts and failed specifically at the existing `Ensure-EnvFile must persist the generated secret as UTF-8 without a BOM` assertion. The repair is source-reviewed and triggers a new run. The Windows workflow's fresh-environment smoke then executes the actual PowerShell helper and checks Node can read the 64-character hexadecimal secret; that integration result is still pending.

**Remaining limitation:** No live Windows runner has yet confirmed this repaired helper in the current batch. The next run must pass both the source contract and Windows environment-file smoke.

### Follow-up correction — stale helper snapshot detected and repaired

The first duplicate-helper cleanup was followed by a stale-file update that reintroduced the original duplicate block and left `Ensure-EnvFile` truncated. Fast Validation #745 exposed the duplicate declarations (53 unique names versus 69 declarations). I rebuilt the helper file from the exact current branch blob, removed all 16 identical duplicate definitions without dropping unique functions, restored the complete UTF-8 secret write, and reinstated the developer stop guard. This correction is intentionally recorded because the earlier cleanup commit did not remain effective. The next run must pass the existing helper uniqueness, UTF-8 source, and Windows fresh-environment smoke checks before these installer fixes can be considered validated.


## 2026-11-05 follow-up — repair corrupted Windows launcher helper tail

**Confirmed finding (high, Windows first-run reliability):** Inspection of the current audit branch found that `scripts/launcher/common.ps1` contained 70+ orphaned lines after the complete closing brace of `Wait-ForUrl`. The orphaned fragments repeated the tail of `Ensure-EnvFile` three times and left the shared helper file syntactically invalid for PowerShell parsing. This contradicted the earlier note that the helper file had been repaired; the corruption had reappeared in the current branch snapshot.

**Correction:** Removed only the trailing orphaned fragment, retaining the complete `Ensure-EnvFile` implementation (32-byte OS cryptographic secret and UTF-8 without BOM) and all 55 unique helper definitions. The file now ends at the complete `Wait-ForUrl` function. Added regression assertions that the final helper is complete at end-of-file and no orphaned `SESSION_SECRET` write fragment follows it.

**Commits:** implementation `2301c9a93a36b3b7e7c796551ab137f8826395d6`; regression `22a7287d4e2d9b5351620a5114557842f13c5cba`; regex assertion correction `e672563485067387467cae86eeba94782aa3ecc8`.

**Validation:** Not yet run on GitHub Actions for this batch. The source boundary and helper count were inspected after the edit; the new regression and Windows PowerShell parser/runtime smoke must pass before this correction is marked validated.

**First-run administrator protection:** The current branch already contains the operator-provisioned `WILLARD_SETUP_TOKEN` guard, constant-time comparison, rate limiting, and reverse-proxy-safe local-launcher opt-in. This addresses the earlier unauthenticated remote first-visitor claim in code. The token is required for LAN/hosted setup; local bypass is restricted to the two supported launchers, loopback bind, and non-Replit runtime. The hosted reverse-proxy deployment test and current full workflow validation remain outstanding; no production secret was provisioned or changed.

**Optimize scan cap:** The current API explicitly returns both `scanLimitReached` and `scanLimit` in the scan and recommendation-status responses. This makes truncation detectable by clients, but the scan remains capped at 500,000 files with no pagination/resume. A visible UI warning and resumable pagination require frontend workflow inspection and are not claimed complete in this pass.

**Remaining critical limitation — stale conversion worker fencing:** PostgreSQL session advisory locks are released when their connection is lost, but a worker may still be executing a filesystem operation. A simple database re-check immediately before a move cannot close the check-to-move race. I have not added a cosmetic lease/check that would falsely claim fencing. A safe fix must make the filesystem mutation boundary itself honor a monotonically increasing fencing generation (or introduce an equivalent cross-process primitive that is valid on supported NAS filesystems), with crash and partition tests. This remains blocked pending that design.
## 2026-11-05 audit batch — Windows updater journal replacement

**Confirmed failure and correction:** Fast Validation #753 passed its Linux validation job but failed the Windows developer updater smoke because the atomic journal replacement left one or more temporary/backup artifacts. The log did not expose the artifact names, so the precise filesystem artifact was not independently identified. Commit 69091d09 changed the same-directory replacement to pass a null backup path, retained cleanup of the temporary file in finally, added a focused source regression, and improved the Windows smoke failure message to print any remaining names.

**Validation:** Fast Validation #754 completed successfully on commit 69091d09. Its Linux validate job passed generated contract checks, workspace typecheck, router and API contract checks, desktop server safety, release/storage contracts, official Linux 7-Zip compatibility, PostgreSQL conversion advisory-lock serialization, conversion-finalization restart recovery, and targeted backend regressions. Its Windows job passed PowerShell parsing, fresh .env generation and Node readability, storage migration/no-overwrite checks, NAS temp-path safety, conversion finalization rollback, official Windows 7-Zip metadata checks, packaged updater journal writes, and the developer updater preservation/rollback smoke. Dependency Review #518 also passed. These are Fast Validation and dependency-review workflow results, not a claim that every feature or the release lifecycle is fully validated.

**Status:** Developer updater journal cleanup is integration-tested. Run #753 remains a historical failure and is not relabeled. The successful #754 run is the matching latest run for commit 69091d09.

## 2026-11-05 architecture review — destructive replace policy

**Confirmed data-loss path:** In artifacts/api-server/src/routes/organize.ts, the replace branch calls fs.unlinkSync(destFile) before the incoming source's FileMoveRecord intent is saved. The existing FileMoveRecord contains the incoming source path, destination path, and source hash; rollbackMoves can restore that incoming file but has no record of the old destination. If the incoming move then fails or the process stops, the prior destination is already gone. The UI warns that existing files will be permanently overwritten, but that warning does not provide rollback or recovery.

**Safe implementation plan (not applied):**
1. Version the organize recovery journal and add a displaced-destination record containing the old destination path, unique same-volume backup path, expected SHA-256, job ID, and phase.
2. Persist the complete displacement intent before touching the existing destination. Verify the destination is a regular file, hash it, and recheck its identity immediately before moving it with no-replace semantics into a per-job recovery area on the same filesystem.
3. Verify the backup hash, then persist the incoming source move intent and publish the source using the existing exclusive no-replace verifiedMove path. Keep the displaced original until the job's completed state and report are durably committed.
4. On failure or restart, restore the incoming source and displaced destination in reverse order, using no-replace moves and hash checks. If either path is occupied or content differs, preserve both candidates and retain the recovery journal for manual action; never unlink an ambiguous file.
5. Add crash-injection tests at every boundary (intent saved, original displaced, source published, report committed, cleanup), including NAS/SMB behavior, duplicate names, tampered journal paths, and retry/idempotency. Migrate old JSONB records without assuming they contain displaced-file metadata.
6. Decide the retention destination and duration for replaced originals. A recoverable trash/recovery folder is safer than immediate deletion, but the retention policy and user-visible restore path need a product decision.

Until this journal and recovery behavior are implemented and tested, the replace policy remains a critical blocked finding. No partial unlink/rename workaround was applied.

## 2026-11-05 architecture review — conversion worker fencing

**Confirmed concurrency limitation:** The PostgreSQL advisory lock is session-scoped and tied to a dedicated checked-out client. The conversion execution and finalization routes acquire it once, then perform multiple filesystem mutations while ordinary database checkpoints use the shared application database pool. If the dedicated lock connection is lost, PostgreSQL releases the lock automatically, but the old JavaScript worker and any child media process may still be alive. Another process can acquire the database lock while the old worker continues. A database recheck immediately before each file operation still has a check-to-mutation race and is not sufficient fencing.

**Safe implementation plan (not applied):**
1. Add a monotonic owner generation/lease epoch and owner ID to the conversion job, acquired with a database compare-and-swap. Every status, progress, cancellation, and journal checkpoint must include that generation in its WHERE clause so an old worker cannot update a newer owner's database state.
2. Separately serialize filesystem mutations with a process-lifetime exclusive mutation gate scoped to the active library/job. The gate must remain held while conversions, child processes, finalization, and cleanup can touch files; process death must release it automatically. A replacement worker must not begin filesystem work until the old process no longer holds the gate.
3. Validate the gate against every supported local, Windows, SMB, and NFS/NAS filesystem. If no reliable cross-process primitive exists on a supported target, use a single-writer worker service or explicitly mark that storage topology unsupported for concurrent workers; do not rely on expiring lock files alone.
4. On lease loss, stop scheduling files, terminate/wait for child media processes, stop database finalization, and leave the durable journal for the next owner to reconcile. The new owner must obtain the filesystem gate before recovery.
5. Test two independent processes with forced database disconnects at pre-move, during-copy, after-move, during-ffmpeg, and finalization boundaries; verify no overlapping writers, no stale completion, and hash-correct recovery after process kill or network partition.

No lease-only or periodic-check workaround was added because it would not fence filesystem writes. This remains a critical blocked architectural item.

## 2026-11-05 user-facing workflow review — Optimize Center and search

**Optimize Center:** Source inspection confirms the API exposes scanLimitReached and scanLimit, and the current page renders a role=alert warning explaining that counts, storage totals, and savings cover only the scanned files and that videos outside the scan window are skipped. The 500,000-file limit remains a deliberate cap with no pagination/resume; no misleading full-library totals are shown when the cap is reached.

**Search accessibility:** The search field and saved-search name field lacked explicit accessible names; the favorites-only control relied on a title attribute and did not expose its pressed state, and the saved-search delete icon button had no accessible name. This batch adds explicit aria-labels, aria-pressed, and a small dependency-free source-contract test wired into Fast Validation. The source test does not replace browser or screen-reader testing. Fast Validation #755 passed both source-contract tests (2/2); this is targeted source validation, not an actual assistive-technology test.

## Windows installer validation boundary

The repository contains scripts/windows/installer-lifecycle-smoke.ps1, which exercises standard-user install, startup, upgrade, interrupted update recovery, diagnostics, and uninstall. It is invoked by .github/workflows/windows-release.yml, whose triggers are pushes to main or manual dispatch and whose later steps publish a GitHub release. That workflow was intentionally not run: this audit must not modify main or publish releases. Fast Validation #754 and #755 both passed the source/developer updater preservation and rollback smoke, but neither establishes a clean-machine packaged installer lifecycle. This remains blocked pending a non-publishing lifecycle validation path.


## 2026-11-05 validation update — search and Windows regression checks

Fast Validation #755 completed successfully on commit e0d69e50: both the Linux validate job and Windows archive/updater smoke job passed. The Linux job ran workspace typecheck and generated contract checks, release/storage tests, the new UI accessibility source-contract suite (2/2), PostgreSQL advisory-lock and finalization-recovery integration tests, and targeted backend regressions. The Windows job passed PowerShell parsing, environment-file encoding, storage migration concurrency/no-overwrite, NAS temp cleanup, conversion finalization rollback, official 7-Zip/symlink metadata checks, packaged updater journal writes, and developer updater preservation/rollback. Dependency Review #519 also passed.

**Interpretation:** Search control accessibility is target-tested at source-contract level only. Developer updater journal cleanup is integration-tested on Windows. Neither result proves browser/screen-reader behavior or a clean standard-user installer lifecycle. Critical replace rollback and stale-worker fencing remain blocked as documented above.


## 2026-11-05 audit batch — strict numeric route identifiers

**Finding (medium, API correctness and unintended record targeting):** Several media, archive, saved-search, organize-job, and conversion-job handlers converted path identifiers with JavaScript `parseInt` or `Number`. These coercions accept malformed segments such as `12garbage`, `12.9`, or `1e2` as valid identifiers (and `Number` can accept whitespace or exponent notation). A malformed request could therefore act on a different, valid record than the path visibly names; other malformed values could reach PostgreSQL and become a 500.

**Correction:** Added a shared, dependency-free `parsePositiveIntegerParam` that accepts only canonical decimal positive safe integers. Applied it to media tag/favorite/delete/rename, archive detail/peek, saved-search run/delete and similar-media lookup, organize-job lifecycle handlers, and optimize-job lifecycle handlers. Invalid identifiers now receive a 400 before database lookups, action-token consumption, or state changes. No database schema or data was changed.

**Regression coverage:** Added positive-boundary and invalid-coercion cases, plus a source-contract assertion that the affected route files do not regress to `parseInt(req.params...)` or `Number(req.params...)`. Added the test to Fast Validation's targeted backend suite.

**Validation status:** Source changes and regression tests are committed together on the audit branch. Targeted test, typecheck, and Fast Validation results remain pending until the matching latest GitHub Actions run completes.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Media, archives, saved search, organize jobs, conversion jobs — malformed numeric path IDs | fixed; target test pending | This audit batch | Other route modules may contain additional numeric path parsing; continue repository-wide inventory |


## 2026-11-05 route-input audit expansion

The first strict-ID batch exposed additional instances during the complete route-module inventory. The same permissive coercion pattern was present in collections, face/person routes, media detail, library-job controls, and OpenAI conversation routes. Collection membership/merge bodies also used `Number`/`parseInt(String(...))`, which could silently turn malformed IDs into another valid file or album ID.

**Additional corrections:** Extended the shared parser to accept either a positive safe-integer JSON number or a canonical decimal string. Applied it to collection IDs, collection item IDs, face/person IDs, and OpenAI conversation IDs; malformed collection file/source ID arrays are rejected instead of silently filtering/coercing values. Collection pagination and library-job list limits now use bounded integer validation. Cleanup duplicate/large-file/old-file pagination now rejects malformed or out-of-range limits/offsets with HTTP 400 rather than allowing permissive prefixes or negative values to reach SQL.

**Regression coverage:** Extended helper tests for JSON-number and string values, invalid coercions, and route-source wiring across the additional modules. The same Fast Validation backend test executes the expanded suite.

**Ledger update:** The medium-severity malformed numeric identifier finding now covers media, archives, search, organize, optimize, collections, faces, library jobs, media details, and OpenAI conversations. Query-boundary correctness also covers collection/library/cleanup pagination. The batch is fixed in source; targeted and CI validation are pending.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Collection membership/merge, face reassignment/merge, library jobs, media details, OpenAI conversations, cleanup pagination | fixed; target test pending | This audit batch | Other non-route inputs and body schemas still require independent validation; no runtime browser test claimed |


## Prioritized findings ledger — 2026-11-05

Statuses use the strongest evidence currently available: found, fixed, target-tested, integration-tested, fully-validated, or blocked. Targeted tests are not full feature validation.

| Priority | Workflow / finding | Status | Commit / evidence | Remaining risk |
|---|---|---|---|---|
| Critical | Organize → replace existing destination | **blocked** | Source inspection: `organize.ts` unlinks the old destination before persisting the incoming move intent. | A failed checkpoint or process exit can lose the old file. Needs a durable replacement journal, verified recovery copy, crash-recovery states, tests, and a retention decision. No partial workaround applied. |
| Critical | Optimize → conversion worker ownership | **blocked** | `conversion-job-lock.ts` uses a PostgreSQL session advisory lock; filesystem work uses separate pooled DB calls. | If the lock connection is lost while the worker process remains alive, another worker can acquire the lock while the old process may still write. Needs a process-lifetime filesystem mutation gate proven on Windows, local disks, SMB, and NAS. |
| High | Windows installer lifecycle | **blocked** | The lifecycle smoke exists but is invoked from the Windows release workflow. No release workflow was run. | Clean-machine standard-user install, upgrade, rollback, and uninstall are not validated. A non-publishing test path is still needed. |
| Medium | Archives → filter correctness and accessibility | **target-tested** | Fast Validation #799 on a6e724946097aff92acc59e7af5c738195f68d98 passed Linux validation and Windows smoke; Dependency Review #562 passed. | Actual HTTP/database integration and browser/screen-reader checks remain outstanding. |
| Medium | Windows updater journal | **integration-tested** | Commit a6e724946097aff92acc59e7af5c738195f68d98; Fast Validation #799 passed PowerShell parsing, packaged journal writes, and developer updater preservation/rollback on Windows. | Does not prove full installer lifecycle readiness. |
| Medium | Search accessibility | **target-tested** | Commit `e0d69e50d0033e90984e4aa52b700d3070e24921`; Fast Validation #755 passed focused tests 2/2 and release-contract tests 61/61. | Browser and assistive-technology validation remains outstanding. |

### Archive filter batch

- Size filters now reject malformed, fractional, negative, repeated, and unsafe-integer values; inverted min/max ranges return a validation error.
- Date-only filters validate calendar dates and order; `dateTo` includes the full selected day via a half-open UTC range.
- A maximum size of zero is no longer dropped by UI truthiness checks.
- OpenAPI and generated client/type contracts include the date filters and size bounds; filter controls have accessible names.
- Fast Validation #776 exposed an invalid generated-Zod file during a pattern-based date-schema experiment. That experiment was reverted to standard OpenAPI `format: date`; do not count #776 as a pass. Fast Validation #777 and latest-head #779 are not yet confirmed complete.

### Validation boundary

Source inspection is complete for this batch. Focused parser, route-wiring, API-contract, and accessibility tests were added. Latest-head targeted tests are pending #779; archive HTTP/database integration and browser/screen-reader testing have not been run. Full release CI was intentionally not run because the Windows release workflow can publish artifacts.


## 2026-11-05 generated API artifact repair

**Finding (high, build and API-contract reliability):** Fast Validation run `42057014248` failed at the workspace typecheck step with TypeScript `TS2451` duplicate block-scoped declarations in `lib/api-zod/src/generated/api.ts`. The run stopped before contract generation, backend regressions, or Windows validation. Dependency Review run `42057014279` succeeded on the pre-fix head; it does not validate this code change.

**Source inspection:** The committed Zod API module contained 851 top-level exported declarations but only 328 distinct names. 262 names were declared three times and one was declared twice. The duplicate archive query schemas disagreed: one used the current OpenAPI `format: date` representation (`zod.date()`), while another retained the abandoned pattern-based date-regex experiment. A malformed stale regex helper and orphaned closing tokens were also present. The OpenAPI source currently uses `format: date`; the generated React API module had no duplicate exports.

**Correction:** Rebuilt the generated Zod API module with one declaration per symbol, kept the schema matching the current OpenAPI date format, and removed the stale date-regex artifacts. The repaired module has 327 unique exported declarations. Added a dependency-free regression test that checks both generated React and Zod API modules for duplicate exported symbols. The test runs immediately after Orval code generation and before the generated-library typecheck.

**Validation workflow correction:** Fast Validation now runs API contract parity/code generation before the broad workspace typecheck. This lets the generated-contract step refresh and validate generated artifacts first, rather than allowing stale generated output to stop the workflow before codegen runs.

**Status:** Source repair and test wiring are committed. Targeted test, regenerated-output parity, workspace typecheck, full Fast Validation, and Windows validation are pending the latest branch run. The failed pre-fix run is not counted as a pass.

| Priority | Workflow / finding | Status | Commit / evidence | Remaining risk |
|---|---|---|---|---|
| High | API code generation → duplicate Zod exports blocking TypeScript validation | fixed; target test pending | Generated artifact repair, generated-export regression test, and codegen/CI ordering commits in this batch | Latest codegen must reproduce the committed output; Fast Validation must pass contract parity and typecheck. Archive HTTP/database integration and browser testing remain outstanding. |


## 2026-11-05 archive index failure-state repair

**Finding (medium, user-facing reliability):** The archive page only consumed `data` and `isLoading` from its list query. When the API returned a validation, library-configuration, or network error, the table had no error branch and the header displayed `0 archives indexed` even though no result had loaded. This made an unavailable archive index look like a valid empty library and left the user without a retry action.

**Correction:** The page now distinguishes loading, unavailable, and loaded states; it does not report a zero count when the query has failed. Query failures are announced in an accessible alert, stale results remain visible if a background refresh fails, and a Retry action calls the query's existing `refetch` function. No new dependency or API endpoint was added.

**Regression coverage:** Extended the existing UI contract suite to assert the error state, accessible alert, accurate unavailable count label, and retry wiring. The test is included in the existing Fast Validation UI contract step.

**Status:** Source correction and focused UI regression are committed. Targeted UI contract test and browser verification are pending the latest Fast Validation run. This is not browser/screen-reader validation.


### Exact commits and current validation boundary

- Generated Zod artifact cleanup: `0b3d45ee33adc8317cd920ae5ddf343c029a3f92`.
- Generated-export guard: final test `c8e003c0a907d262f684834ca564e970620275f6`; API-spec codegen wiring `8462e7890e00f880c7430203a8b8596b5c520eeb`; Fast Validation ordering `a686b048ddfcbaad5978c61ca0244a7b8f0e2e53`.
- Archive index UI repair: final page formatting/content `6dc11ea3f1b0c8979c43dfb2cf769e02b1d66824`; final UI regression assertions `f8174e8c8177fc6f5809702525212b2f2893ea1b`.
- The intermediate UI commits `3c8c4105965957bf0f97bfde73e8573e87bf87aa` and `a158ab98041e8ac3bb3a4fcc36bd742eee2f07b8` were superseded by the final formatting and test corrections above.

At the latest repository check, PR #2 remained **open and draft**, with 802 commits and 133 changed files; GitHub reported it mergeable. The branch comparison reports 802 commits ahead and 1 behind `main`. No merge, close, main-branch update, production-data change, credential change, or release publication was performed.

No workflow run or combined status was visible for the latest head `f8174e8c8177fc6f5809702525212b2f2893ea1b` when checked. Therefore the generated-export test, codegen parity, TypeScript checks, archive UI regression, integration tests, and Windows tests are all **pending** on this head. Fast Validation run `42057014248` is a pre-fix failure and is not counted as a pass; it exposed the duplicate generated exports before the codegen step could run. The successful Dependency Review run `42057014279` is also from the pre-fix head and does not validate these changes.


## Windows installer lifecycle — additional source review

The installed lifecycle smoke is comprehensive in several areas: it uses a disposable standard Windows user, a unique PostgreSQL database, a separate media directory, verifies first install/start and in-place upgrade, exercises interrupted-update recovery, checks startup diagnostics, and confirms that uninstall preserves external media, settings, and database state.

One uninstall assertion is missing: the smoke verifies that the desktop shortcut is removed, but it only verifies Start Menu shortcut creation after install. It does not check that the Start Menu shortcut is gone after uninstall. This is a **test-coverage finding**, not a confirmed installer defect. The product behavior remains unknown until the isolated Windows lifecycle test runs.

| Priority | Workflow / finding | Status | Evidence | Remaining risk |
|---|---|---|---|---|
| Medium | Windows installer → Start Menu shortcut cleanup on uninstall | found | `installer-lifecycle-smoke.ps1` checks the Start Menu shortcut after first install, but the uninstall phase only asserts removal of the desktop shortcut and packaged launcher. | The Start Menu shortcut may be left behind; no product defect is claimed. Add a post-uninstall Start Menu assertion and run the smoke on a disposable Windows runner. |

The lifecycle smoke was not run. The only existing invocation is inside `.github/workflows/windows-release.yml`, which also publishes the installer and release assets. That workflow was not invoked. A safe non-publishing validation path is still required before installer lifecycle status can advance beyond blocked.

## 2026-11-05 audit batch — Windows updater smoke false-positive correction

**Finding:** Fast Validation #796 failed in the Windows developer-updater smoke at the temporary/backup-artifact assertion. The only reported name was the live journal, .recovery-atomic.willard-update.json; no .tmp or .bak sidecar was reported. The PowerShell Get-ChildItem -Filter wildcard matched the extensionless/dot-prefixed journal itself on Windows, so the assertion was broader than its intent. This was a test false positive, not evidence that the writer left a backup artifact.

**Correction:** The smoke now enumerates files and matches only the exact generated sidecar form: a 32-character hexadecimal write ID followed by .tmp or .bak. It also explicitly asserts that the live journal remains present until the test removes it. An intermediate edit caused a PowerShell parse failure in Fast Validation #798; the smoke was restored from the pre-edit version and corrected in commit a6e724946097aff92acc59e7af5c738195f68d98.

**Validation:** Fast Validation #799 (run 42070432819) passed both the Linux validation job and the Windows archive/updater smoke job. The Windows job passed PowerShell parsing, storage migration/no-overwrite checks, NAS temp-path safety, conversion finalization rollback, official 7-Zip symlink-metadata validation, packaged updater journal writes, and developer updater preservation/rollback. Dependency Review #562 (run 42070432915) passed. This is Windows integration coverage for the updater path, not full installer lifecycle validation.

## 2026-11-05 audit batch — organize job creation correctness

**Confirmed user-facing failure:** The organize form defaults archiveDisposition to waiting. When a user switches the source type from archive to folder, the archive-only disposition control disappears but the state remained waiting; the form still submitted that value. The API correctly rejects non-keep dispositions for folder jobs, so the default folder workflow returned HTTP 400 unless the user first changed the archive disposition to keep and only then switched source type.

**Related API correctness findings:** The create route coerced archiveId with Number(), accepted malformed string representations such as exponent notation, silently replaced unsupported conflict policies with keep_existing, and allowed unsupported archive dispositions to fall through as a no-op.

**Correction (commit c36ef16ad0cfe951be7a34f83c17a916625e3b45):**
- Folder-source submissions now send archiveDisposition: "keep"; archive-source selections retain their chosen disposition.
- Archive IDs use the existing strict positive-safe-integer parser. Invalid IDs receive HTTP 400, and folder jobs cannot carry an archive ID.
- Archive disposition and conflict policy are checked against their supported values. Invalid values now receive HTTP 400 rather than silently changing the requested behavior.
- Added focused tests for the allowed-value parser and source/UI contract. No database schema, stored data, or dependencies changed.

**Validation boundary:** Source inspection confirms the default folder-form/API mismatch and the route coercion/fallback paths. The targeted tests are committed but have not yet run on commit c36ef16; the next Fast Validation run must confirm them. No live HTTP/database integration or browser workflow test is claimed.

| Priority | Workflow / finding | Status | Commit / evidence | Remaining risk |
|---|---|---|---|---|
| Medium | Organize → folder-source job creation and job-option validation | **fixed; target test pending** | c36ef16ad0cfe951be7a34f83c17a916625e3b45; focused cases added to request-validation.test.ts. | Latest-head Fast Validation is pending; actual HTTP/database route integration and browser workflow validation remain outstanding. |

### Current repository state

PR #2 remains open and draft. The current audit branch head is c36ef16ad0cfe951be7a34f83c17a916625e3b45. The Windows updater correction is integration-tested by Fast Validation #799; the organize creation batch is awaiting its first matching validation run. The two critical data-integrity findings remain blocked: destructive organize replace can lose the previous destination, and conversion-worker filesystem writes are not fenced against a lost advisory-lock connection. The standard-user installer lifecycle is also not validated because its only existing invocation is inside the release-publishing workflow.

No merge, PR close, main-branch change, production-data change, credential change, or release publication was performed.


## 2026-11-05 audit batch — archive disposition confirmation and recovery

**Confirmed findings (source inspection):**
- The archive disposition endpoint accepted any truthy `confirm` value. A request with `{ "confirm": "false" }` or `{ "confirm": 1 }` could pass the confirmation gate even though the contract requires the literal boolean `true`.
- Successful archive deletion was tracked only in `DoneStep` component state. Reopening the completed job or refreshing the page could show the destructive confirmation again because the result was not saved in `reportJson`.
- A missing archive was returned as `already_gone`, but the UI presented every successful response as “Archive deleted successfully,” overstating what the server had verified.
- Automatic `move_to_processed` errors were logged and swallowed. The job could still be marked completed with `dispositionPending: false` while the archive remained in its original location.

**Corrections:**
- The endpoint now requires `req.body.confirm === true`; truthy strings and numbers are rejected.
- Completed disposition results are persisted in the existing job `reportJson` field. Repeated requests return the saved terminal result rather than repeating the filesystem action.
- A missing source is recorded as `already_gone` and is presented accurately as “no longer present,” not as a confirmed deletion.
- Processed-folder moves are SHA-256 checked and use the existing no-overwrite move helper. Failed automatic moves retain `dispositionPending: true`, include a redacted error, and expose a retry action in the completed-job report.
- The UI reads persisted disposition state after reload and distinguishes deleted, already-missing, and moved-to-processed outcomes.
- No schema migration, new dependency, credential change, or production-data operation was introduced.

**Regression coverage:** Extended `request-validation.test.ts` with checks for the literal-boolean confirmation gate, persisted disposition result, checksum verification, accurate UI state, and the processed-move retry action. These are source-contract regressions; they do not replace live HTTP/filesystem integration tests.

**Validation boundary:** Fast Validation #801 (run `42071283343`) passed on the parent commit `f4aca0a3bbe4add1fe021bc5a70c4d89deb863e1`: Linux validation/typecheck/generated contracts/targeted backend regressions and the Windows archive/updater integration job all succeeded; Dependency Review #564 also passed. Those results predate this batch. The new disposition changes require their own matching Fast Validation run. No full release workflow was run.

| Priority | Workflow / finding | Status | Commit / evidence | Remaining risk |
|---|---|---|---|---|
| High | Organize → explicit archive delete/move confirmation accepted truthy non-booleans | **fixed; target test pending** | This batch; literal-boolean check and regression assertion added | Latest Fast Validation pending; HTTP route integration and concurrent-request behavior remain untested |
| Medium | Organize → disposition result lost after report reload | **fixed; target test pending** | This batch; result persisted in `reportJson` and UI derives terminal state from it | Crash between filesystem action and final DB result write can still require manual reconciliation |
| Medium | Organize → move-to-processed failure silently reported as completion | **fixed; target test pending** | This batch; failed moves remain pending with error and retry UI | Live NAS/Windows filesystem retry integration remains outstanding |

### Validation update — parent commit

Fast Validation #801 (run `42071283343`) completed successfully on `f4aca0a3bbe4add1fe021bc5a70c4d89deb863e1`:
- Linux validation job: all steps succeeded, including typecheck/generated API contract checks, release/storage contracts, PostgreSQL conversion-lock and restart-recovery tests, and targeted backend regressions.
- Windows archive/updater job: all steps succeeded, including PowerShell parsing, storage migration no-overwrite tests, conversion finalization rollback, official 7-Zip symlink metadata, packaged updater journal writes, and developer updater preservation/rollback.
- Dependency Review #564 (run `42071283227`) succeeded.
- These checks validate the parent only, not this new disposition batch. No full CI/release publishing workflow is claimed.


## 2026-11-05 audit batch — media browser query correctness

**Confirmed findings (source inspection):**
- The media listing route cast `mediaType`, `favorites`, `folder`, `search`, and `sort` query values to strings without runtime validation. Repeated scalar parameters are parsed as arrays by Express and could reach SQL filters or silently fall through to the default sort.
- User-supplied `%` and `_` characters in folder and filename filters were interpreted as SQL `LIKE` wildcards rather than literal characters. A search for a literal underscore or percent sign could return unrelated files.
- The Explorer route similarly cast `path` to a string. A repeated `path` parameter could cause a runtime `.replace` error and return a generic 500 rather than a client validation response.

**Corrections (implementation commit 68094f3142698fca517ca63af488d5035aa2dfe4):**
- Media scalar query fields now use the existing `parseOptionalQueryString` validator; repeated and non-string values return HTTP 400.
- Media type and sort values are restricted to the values supported by the UI and query implementation. `favorites` accepts only `true` or `false`.
- Added a PostgreSQL `LIKE` pattern helper that escapes backslash, `%`, and `_`; both folder-prefix and filename-substring filters now match those characters literally.
- Explorer validates `path` as a single optional string before path normalization or filesystem access.
- Added focused regression tests for scalar rejection, literal wildcard escaping, route wiring, and Explorer validation. Registered the suite in Fast Validation.
- No schema migration, new dependency, production data operation, or filesystem mutation was introduced.

**Validation boundary:** The source paths and UI-supported media types/sorts were inspected on the audit branch. Focused regression tests are committed but await the matching Fast Validation run. The tests exercise the pure parser/escaping helper and assert route wiring; they do not replace live HTTP/PostgreSQL integration or browser testing.

| Priority | Workflow / finding | Status | Commit / evidence | Remaining risk |
|---|---|---|---|---|
| Medium | Media browser → repeated scalar query parameters and unsupported filters | **fixed; target test pending** | 68094f3142698fca517ca63af488d5035aa2dfe4; `media-query-validation.test.ts` | Latest Fast Validation pending; live HTTP route validation remains outstanding. |
| Medium | Media browser → literal `%`, `_`, and backslash filter matching | **fixed; target test pending** | 68094f3142698fca517ca63af488d5035aa2dfe4; `sql-like.ts` and regression cases | Requires PostgreSQL integration verification to confirm the bound pattern/escape behavior on the deployed PostgreSQL version. |
| Medium | Explorer → repeated `path` query parameter returns generic server error | **fixed; target test pending** | 68094f3142698fca517ca63af488d5035aa2dfe4; `media-query-validation.test.ts` | Filesystem-backed HTTP test and Windows path behavior remain outstanding. |


## 2026-11-05 audit batch — Explorer accessibility, Windows installer validation, and media SQL integration

### Validation of the previous media-query batch

Fast Validation #810 (run 42088350368) completed successfully on implementation/documentation head `db8b85782ae9938cc85cd503b33f4f645f9fb898`:
- Linux validation job: passed, including generated API checks, all workspace TypeScript checks, release/storage contracts, UI accessibility contracts, PostgreSQL conversion lock/recovery tests, and targeted backend regressions.
- Targeted backend regressions: **257 tests, 255 passed, 0 failed, 2 skipped**. All four new media/Explorer query tests passed.
- Windows archive/updater integration job: passed all steps, including PowerShell parsing, fresh environment-file encoding, storage migration no-overwrite tests, NAS temporary-path cleanup, conversion rollback, official 7-Zip staging and symlink metadata, packaged updater journal, and developer updater preservation/rollback.
- Dependency Review #573 (run 42088350365): passed.
- This is Fast Validation and Windows integration coverage, not full release CI or installed-product lifecycle validation.

### Explorer keyboard accessibility

**Confirmed source finding:** The Explorer sort headers and entire file/folder rows used click handlers on table elements without keyboard-operable controls. The icon-only library-root button also lacked an accessible name. The folder error state was not announced as an alert.

**Correction (commit 83b0f0ea26a96c4960e0b382fae0fbd382fbd3b1):**
- Sort headers now contain real buttons, expose the active sort direction through `aria-sort`, and provide current-state accessible names.
- Folder/file navigation and file details use named buttons inside the name cell; the parent-folder action is also a button.
- The library-root icon button has an accessible name.
- Explorer load errors use an alert role.
- Added Explorer-specific assertions to the existing UI accessibility suite. No new dependency.

**Validation boundary:** The source and test contracts are committed. Latest Fast Validation is pending. These are source-contract checks; keyboard-only browser and screen-reader verification remain outstanding.

### Windows installer lifecycle validation

**Confirmed test-coverage gap:** The standard-user lifecycle smoke verified Start Menu shortcut creation after install, but did not verify that upgrade preserved exactly one shortcut or that uninstall removed it.

**Correction (same commit 83b0f0ea26a96c4960e0b382fae0fbd382fbd3b1):**
- Added Start Menu shortcut count assertions after in-place upgrade and after uninstall.
- Added a `validate_only` boolean input to the existing Windows release workflow. Manual dispatch defaults to validation-only. When true, the workflow builds and signs local artifacts and runs the installed lifecycle tests but skips the GitHub Release publication step. Push-to-main release behavior is unchanged.
- Updated trust-summary wording so a validation-only run does not claim an artifact has already been published.
- Added static regression coverage for the new assertions and publish guard.

**Validation boundary:** The workflow and smoke changes await the matching Fast Validation run. The full standard-user installer lifecycle has **not** been run in this audit. The manual validation-only path requires the repository's existing signing secrets; it does not modify them. No release was published or workflow dispatched.

### PostgreSQL LIKE integration

**Correction (same commit 83b0f0ea26a96c4960e0b382fae0fbd382fbd3b1):**
- Added a real PostgreSQL test for literal `%`, `_`, and backslash matching using the same escaping helper and explicit backslash `ESCAPE` semantics used by the media route.
- Registered a dedicated Fast Validation step against the disposable PostgreSQL 16 service. The existing source-level route tests remain in the targeted backend suite.

**Validation boundary:** The PostgreSQL integration test is committed and awaits the matching Fast Validation run. It validates the SQL pattern semantics, not the full HTTP route or browser interaction.

| Priority | Workflow / finding | Status | Commit / evidence | Remaining risk |
|---|---|---|---|---|
| Medium | Explorer → sort, folder navigation, file details, and error announcement accessibility | **fixed; target test pending** | 83b0f0ea26a96c4960e0b382fae0fbd382fbd3b1; `scripts/ui-accessibility.test.mjs` | Browser keyboard navigation and assistive-technology verification remain outstanding. |
| Medium | Windows installer → Start Menu shortcut lifecycle coverage | **test coverage fixed; lifecycle unvalidated** | 83b0f0ea26a96c4960e0b382fae0fbd382fbd3b1; `installer-lifecycle-smoke.ps1` and static tests | Requires a manual validation-only Windows workflow run; not run here. |
| Medium | Windows installer → accidental publication during manual validation | **guard added; target test pending** | 83b0f0ea26a96c4960e0b382fae0fbd382fbd3b1; `validate_only` defaults true and gates the publish action | Static test pending; actual workflow_dispatch behavior has not been executed. |
| Medium | Media browser → literal SQL LIKE wildcard semantics | **integration test added; pending** | 83b0f0ea26a96c4960e0b382fae0fbd382fbd3b1; PostgreSQL test step | Latest PostgreSQL integration run pending; HTTP route integration remains outstanding. |



### Validation correction — PostgreSQL integration test dependency

Fast Validation #811 (run 42089569389) failed during workspace TypeScript validation because the new test imported `pg` directly, but `pg` is not a direct API-server workspace dependency. No test execution or Windows validation occurred in that run; downstream steps were skipped.

**Correction (commit 8a7f00ef6d6ec2cd240e336562b732f4dde96ea8):** The test now lazily imports the repository's existing `@workspace/db` shared pool only when `DATABASE_URL` is present. This reuses the existing database dependency and avoids adding a package or opening a connection during the ordinary targeted test invocation without a database URL.

Fast Validation #811 is recorded as **failed**, not passed. The correction is awaiting its matching latest-head Fast Validation run. No database schema, production data, credentials, or dependencies were changed.


## 2026-11-05 — Windows launcher serialization and signed-update version correctness

### Confirmed fixes

**Packaged launcher startup race — fixed.**

Source inspection found that two fresh shortcut launches could both read an empty or stale services.json, then independently run the GitHub update check, stage/swap the same installation, and start competing service processes. The existing-instance check was correct for sequential clicks, but it did not serialize simultaneous launches.

Commit [6c29894e7d9f533c43b92d463da9a2238cd40f99](https://github.com/christopherlwillard-debug/willard-ai/commit/6c29894e7d9f533c43b92d463da9a2238cd40f99):

- Adds a per-Windows-session named mutex around the complete launcher startup decision.
- Acquires the lock before checking existing service processes or calling the update routine.
- A second shortcut launch waits for the first startup to finish, then detects the running services, opens the UI, and exits without another update check.
- Treats an abandoned mutex as recoverable ownership after a launcher crash.
- Uses a bounded five-minute wait and reports a clear startup-lock error on timeout.
- Releases the lock on stop, existing-instance, success, and caught-failure paths.
- Adds the helper to the packaged release payload.
- Adds a Windows multi-process smoke test for lock contention, normal release, and abandoned-owner recovery.
- Adds source-contract assertions that the running-instance branch precedes the update call.

The new helper is tested on Windows, but this is not yet a complete installed-shortcut lifecycle test.

**Updater SemVer handling — fixed.**

Commit [21d3b19f47526f8cfa0afb02a2082f6decc8c3cf](https://github.com/christopherlwillard-debug/willard-ai/commit/21d3b19f47526f8cfa0afb02a2082f6decc8c3cf):

- Replaces the launcher's version comparison after stripping prerelease suffixes. That old logic treated 1.2.0-beta.1, 1.2.0-beta.2, and 1.2.0 as the same version.
- Uses the existing release-contract module's semantic-version comparator through a small --compare CLI mode.
- Correctly orders numeric prerelease identifiers (beta.10 after beta.2), numeric versus nonnumeric identifiers, and shorter versus longer identifier sequences.
- Rejects invalid SemVer core leading zeroes, empty prerelease identifiers, numeric prerelease leading zeroes, and unsafe core integers.
- Verifies the signed release manifest before using its version to decide whether an update is needed.
- Adds direct comparator, CLI, invalid-version, stable-versus-prerelease, and launcher call-order regression tests.

The launcher still falls back to the installed version when manifest retrieval or verification fails; this batch did not change that fallback policy.

**Validation-contract correction.**

Fast Validation #813 (run 42089895124) failed because scripts/windows/installer-config.test.mjs still expected the old workflow text "Release URL:" while the workflow now correctly says "Potential release URL (only if published):". This was a stale assertion, not a product failure. Commit 6c29894e7d9f533c43b92d463da9a2238cd40f99 updates the assertion and adds explicit checks that validate_only defaults to true and gates the publish action.

### Validation evidence

- [Fast Validation #814](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42101572293) — **passed on Linux and Windows**.
  - Linux typecheck/generated-contract validation and targeted backend regressions passed.
  - Windows PowerShell parsing, launcher mutex smoke, environment-file encoding, storage migration/no-overwrite, NAS temporary-path cleanup, conversion rollback, official 7-Zip verification, symlink metadata preservation, packaged updater journal, and developer updater preservation/rollback all passed.
- [Dependency Review #577](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42101572210) — **passed**.
- [Fast Validation #815](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42102458214) — **passed on Linux and Windows**.
  - Release-contract tests: 65/65 passed, including the new SemVer and CLI cases.
  - Installer configuration/source-contract tests: 19/19 passed.
  - UI contract/accessibility tests: 6/6 passed.
  - Targeted backend regressions: 255 passed, 0 failed, 3 skipped.
  - Typecheck, generated API contracts, PostgreSQL media wildcard integration, PostgreSQL conversion-lock/recovery tests, and release/storage contracts passed.
  - Windows PowerShell parsing and the new launcher mutex smoke passed; Windows storage/NAS/conversion, 7-Zip/symlink, packaged updater journal, and developer updater preservation/rollback checks also passed.
- [Dependency Review #578](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42102458109) — **passed**.

These are Fast Validation and Dependency Review results, not full CI or release validation. The Windows release workflow was not dispatched, no installer was published, and no release was created. The full installed-product lifecycle remains unverified because the Authenticode signing certificate has not been configured, as previously reported.

### Updated prioritized findings ledger

| Severity | Workflow / finding | Status | Commit | Remaining risk / next action |
|---|---|---|---|---|
| Critical | Organize → replace can remove the destination before durable displaced-original recovery intent exists | **blocked** | — | Design a durable replacement journal and verified recovery copy; add crash-injection tests before changing destructive operations. |
| Critical | Conversion worker can continue filesystem writes after losing its PostgreSQL advisory-lock connection | **blocked** | — | Design process-lifetime filesystem mutation fencing and validate on Windows, local disks, SMB, and supported NAS filesystems. |
| High | Packaged updater → malformed or unreadable update journal is silently treated as absent | **integration-tested** | `83b9cf1f1ac002c87e31af21b187049c18654e35`; Windows packaged journal smoke in Fast Validation #822 | Existing journals now fail closed, schema/path validation is enforced, ambiguous missing-backup states are preserved, and same-process rollback uses its captured backup path. This is not full installed-product validation. |
| High | Packaged updater → crash after the install directory is moved can leave the shortcut target unavailable | **found / blocked** | Source inspection: `installer/WillardMediaCenter.iss` shortcuts target `{app}\\desktop\\WillardMediaCenter.ps1`; `Invoke-PackagedVersionSwap` temporarily renames `{app}` | If the process dies after renaming the install root and before activating the candidate, the shortcut points into a missing directory and cannot run the recovery code. Design a stable bootstrapper outside the swap root or a versioned-directory layout; add process-crash tests. |
| High | Packaged updater → stale non-terminal journal after backup cleanup | **found / blocked** | Source inspection: `Remove-UpdateJournal` suppresses deletion errors; success and restore paths can leave `swapped`/`backup-created` journal after backup removal | Add durable `committed` and `restored` terminal phases before deleting rollback directories; make cleanup/recovery idempotent and test journal-delete failures. |
| High | Windows release workflow → manual validate_only still runs with workflow-level contents: write and receives production manifest-signing and Authenticode secrets | **found / blocked** | — | Split validation and publication into separate jobs. Give validation read-only permissions and ephemeral test signing identities; expose production signing secrets and write permission only to the protected publish job. No workflow dispatch was run. |
| High | Windows installer → complete standard-user install/upgrade/interruption/rollback/uninstall lifecycle | **blocked** | — | Requires a non-publishing test-signing path; current release workflow requires Authenticode secrets. |
| Medium | Release minimumWindowsVersion metadata is informational only | **found** | — | make-release.ps1 writes "10", but the installed launcher does not enforce it and the Inno Setup script has no explicit MinVersion. Align the installer and updater with the signed minimum before declaring OS compatibility complete. |
| High | Packaged launcher → concurrent fresh starts can race update and service startup | **integration-tested** | 6c29894e7d9f533c43b92d463da9a2238cd40f99 | Windows mutex contention and abandoned-owner smoke passed. Full installed-shortcut lifecycle and browser behavior remain unverified. |
| Medium | Packaged updater → prerelease comparison and signed-manifest decision ordering | **target-tested** | 21d3b19f47526f8cfa0afb02a2082f6decc8c3cf | Linux release-contract/CLI tests passed. Add a Windows PowerShell-to-Node CLI smoke to verify argument handling on the packaged Windows runtime. |

### Branch and PR preservation

The remote `audit/full-repository-review-2026-11` branch is still the exact head of PR #2 at `1ef0e77c28006e05622a4847320ea639c3a8e342`. It is 841 commits ahead of `main` and 1 behind; GitHub currently reports the PR as mergeable. No rebase, force-push, merge, or main-branch update was performed. The separate Replit workspace previously reported on `main` was not modified by this GitHub-side work; if it still shows `main`, it must fetch and check out the existing audit branch before local Replit work resumes.

No production data, credentials, or published releases were changed.


## 2026-11-05 audit batch — packaged updater journal fail-closed recovery

**Confirmed defects:** `Read-UpdateJournal` previously converted every read/JSON error into `$null`, making a corrupt journal indistinguishable from no pending update. `Recover-InterruptedUpdateSwap` also treated a missing backup as cleanup-safe even in `backup-created` or `swapped` phases, which could discard the candidate and journal while the installation was incomplete. In-process rollback read the journal before using the backup path already captured by the running process, so a damaged journal could prevent that process from restoring the directory it had just displaced.

**Implemented:**
- A missing journal is the only state that returns `$null`; an existing non-file, unreadable, malformed, unsupported, or path-mismatched journal now stops startup without deleting recovery data.
- Validate the journal version, phase, required fields, install root, and expected sibling candidate/backup naming and parent paths.
- Preserve the journal and candidate when a phase that requires the previous installation backup cannot find it. Only a `prepared` journal with the original installation still present can discard the unused candidate.
- Capture the trusted in-process backup path immediately after moving the old install and before writing the next journal phase. Same-process rollback now uses that captured path even if the journal becomes unreadable afterward.
- Extend `scripts/windows/update-journal-smoke.ps1` to exercise the production functions in isolated temporary directories: atomic journal writes, corrupt JSON preservation, path escape rejection, missing-backup preservation, safe prepared-phase cleanup, in-memory rollback with a corrupt journal, and valid previous-version restoration.

**Commits:** final launcher implementation `83b9cf1f1ac002c87e31af21b187049c18654e35`; packaged journal regression coverage `077bdb0ac7b5473efe206dfc51cf97d88758d053`. The test fixture cleanup correction is in `f35300fe6d133c96a3d14da6599ec0e4839e20eb`.

**Validation:** [Fast Validation #822](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42114708776) passed both Linux and Windows jobs. Linux passed typecheck/generated contracts, release/storage contracts, release-contract tests (65/65), installer configuration tests (19/19), UI accessibility contracts (6/6), PostgreSQL media LIKE integration, PostgreSQL conversion-lock and finalization-recovery integration, and targeted backend regressions (255 passed, 0 failed, 3 skipped). Windows passed PowerShell parsing (19 scripts), launcher mutex, environment-file encoding, storage concurrency/no-overwrite, NAS temp cleanup, conversion rollback, official 7-Zip and symlink metadata, packaged updater journal smoke, and developer updater preservation/rollback. [Dependency Review #585](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42114708793) passed.

**Validation correction:** Fast Validation #821 failed because the first launcher source replacement duplicated the script body; the existing launcher-flow source contract caught it. Commit `83b9cf1` restored the original single launcher body and reapplied the journal changes. The matching latest Fast Validation #822 then passed. Superseded runs #817–#819 were cancelled and are not counted as passes.

**Remaining risk / design work:** This batch is Windows integration-tested at the helper level, not a complete installed-product lifecycle. The Start Menu/Desktop shortcuts point to a script inside `{app}`, while the swap temporarily renames that directory; a process crash in that window can leave no launcher available to run recovery. A stable bootstrapper outside the swap root or a versioned-directory design is required. Journal cleanup also suppresses deletion errors, and there are no durable `committed`/`restored` terminal phases yet; a failed journal deletion after backup cleanup can leave a stale phase. Both require an idempotent state-machine design and crash-injection tests. No installer was published, no release was created, and the validation-only release workflow was not dispatched.


## 2026-11-05 follow-up — organization worker lease fencing and current validation

### Validation confirmation

- [Fast Validation #824](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42115395491) completed successfully on the current PR head `2969ca26638a2a75db2438b9f8f8d812c53105e5`.
- Linux job passed workspace typecheck/generated API contracts, Expo CLI configuration smoke, desktop web-server safety, release/storage contracts, official 7-Zip download retry and binary compatibility, PostgreSQL media wildcard integration, PostgreSQL conversion advisory-lock and finalization-recovery integration, and targeted backend regressions.
- Windows job passed PowerShell parsing, concurrent launcher serialization, fresh environment-file encoding, storage migration concurrency/no-overwrite, NAS temp-path cleanup, conversion finalization rollback, official 7-Zip staging and symlink metadata preservation, packaged updater journal writes, and developer updater preservation/rollback.
- [Dependency Review #587](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42115395467) passed.
- These are Fast Validation and Dependency Review results, not full CI, a complete installed-product lifecycle, or full malicious-archive organize-route integration on Windows.

### Newly confirmed high-priority finding — organization worker lease is not a filesystem fencing mechanism

**Affected workflow:** Organize → execute/resume/rollback and Recovery Center.

**Source inspection:** `artifacts/api-server/src/routes/organize.ts`.

- `startOrganizationJobHeartbeat` renews `stageUpdatedAt` every 30 seconds, but catches database errors, logs a warning, and lets the worker continue.
- The heartbeat update is conditional on job ID, library path, and status, but does not use `RETURNING` or inspect whether any row was actually updated. A zero-row update after another actor changes the status is therefore indistinguishable from a successful lease renewal.
- The execute and resume stage-checkpoint helpers also catch and suppress checkpoint failures. Their updates are scoped by job ID only, rather than by the worker's ownership generation and expected status.
- Recovery Center considers an executing/rolling-back job reclaimable after the five-minute heartbeat lease becomes stale. A worker that is still performing filesystem operations can therefore outlive its database lease after a prolonged database outage or ownership transition. A stale worker's stage checkpoint can also update `stageUpdatedAt` after another actor has changed the status.

**Status:** found; critical concurrency/data-integrity risk; blocked pending fencing design. No partial heartbeat-only workaround applied.

**Required safe design:**
1. Give every claimed execution/resume/rollback attempt a unique owner generation/token persisted by the atomic claim.
2. Make heartbeat renewal return and verify the claimed generation and expected status; a failed or zero-row renewal must transition the worker to a no-more-mutations state.
3. Require the same owner generation at every durable journal update and before each filesystem mutation. A process-local abort signal alone is insufficient if a mutation is already in flight or if another process can reclaim ownership.
4. Add a filesystem mutation gate/fencing mechanism that prevents a stale process from writing after a newer owner is admitted. Validate its semantics on Windows, local filesystems, SMB, and supported NAS configurations.
5. Add PostgreSQL-backed race tests: lost DB connection, zero-row heartbeat renewal after ownership changes, slow/in-flight copy, stale worker resumption, and concurrent Recovery Center rollback/resume. Assert that no two generations can mutate the same job's paths.
6. Preserve the existing move journal and never clear recovery records when ownership or rollback completion is ambiguous.

**Remaining risk:** Current five-minute timestamp lease is a liveness heuristic, not proof that the previous process has stopped. The existing conversion-worker advisory-lock concern has the same class of problem. Both need filesystem-level fencing, not just a database recheck.

### Replacement-policy source confirmation

The current organize execute and resume paths still unlink an existing destination for `conflictPolicy === "replace"` before calculating/persisting the incoming file's move intent. The pre-move intent journal protects the incoming move, but does not preserve the displaced destination. This remains critical and blocked; replacement backup/recovery must be designed as part of the durable journal rather than patched by adding an untracked rename.

### Current PR/branch snapshot

- PR #2 remains open, draft, unmerged, and reported mergeable.
- Head branch: `audit/full-repository-review-2026-11`.
- Head SHA: `2969ca26638a2a75db2438b9f8f8d812c53105e5`.
- Base: `main` at `694a055aeb10a41ee8e98f5b776faef89cbd449d`.
- GitHub reports 842 commits and 141 changed files in the PR.
- No merge, close, rebase, force-push, or main-branch modification was performed.
- No production data, credentials, or release artifacts were changed.


## 2026-11-05 follow-up — signed minimum-Windows-version requirement is not enforced

### Finding — update compatibility metadata is authenticated but ignored by the installed updater

**Affected workflow:** Installed Windows app → automatic update check and installation.

**Evidence:**
- `desktop/release-contract.mjs` includes `minimumWindowsVersion` in `SIGNED_FIELDS`, so the value is covered by the release signature.
- `validateReleaseManifest` accepts an optional string for `minimumWindowsVersion` but does not validate a version format or expose a compatibility decision.
- `desktop/WillardMediaCenter.ps1` verifies the signed manifest and compares release versions, then downloads and installs the newer package. It does not inspect `remote.minimumWindowsVersion` or compare it with the current Windows version.
- `scripts/windows/validate-release.mjs` separately checks the packaged `version.json` prerequisite is `10+`, but that is a fixed payload validation assertion; it does not enforce a signed per-release minimum against the end user's machine.

**Impact:** If a future signed release raises its minimum supported Windows version (for example, to a newer Windows release), an older unsupported machine can still be offered and can begin installing that release. The update may then fail at runtime or leave the user with an incompatible installation.

**Status:** Confirmed source-level compatibility gap. No update behavior changed in this pass.

**Safe fix requirements:**
1. Define one canonical supported value format and comparison function for the signed minimum Windows version (avoid loose string comparison).
2. Determine the actual Windows version using a supported Windows API/runtime source; do not trust a user-editable environment variable.
3. Check compatibility after signature verification and before artifact download or service shutdown.
4. If incompatible, keep the installed version untouched, display a clear message that names the minimum required Windows version, and record a non-sensitive diagnostic.
5. Add Windows tests for absent requirement (backward-compatible), current OS equal to minimum, newer OS, older OS, malformed signed values, and version-boundary cases.
6. Keep the check in the shared release/update contract where possible so validation, updater, and tests cannot drift.

**Risk classification:** Medium (availability / failed update), elevated because the update path can replace a previously working installation. The signed metadata is not currently an enforced compatibility boundary.


## 2026-11-05 follow-up — media rename input and no-overwrite safety

### Finding: media rename could throw on non-string JSON and overwrite a racing destination

**Severity:** Medium (data integrity and cross-platform correctness).
**Affected workflow:** Media Explorer → rename file.
**Source inspection:** `artifacts/api-server/src/routes/media.ts`, `artifacts/api-server/src/lib/media-rename.ts`, and existing `moveFileNoReplace` in `organize-helpers.ts`.

The rename route called `.trim()` on `req.body.name` before checking its JSON type, so an array/number/object could throw rather than return HTTP 400. It also performed an `existsSync(newAbs)` preflight and then used `fs.renameSync`; another process could create the destination between those operations, and POSIX rename semantics can replace that file. The route also accepted Windows-reserved device basenames and Windows-invalid trailing dots/characters, making names non-portable when a library is moved between supported operating systems.

**Fixes:**
- Added `isPortableMediaFileName` to validate a single portable filename component, including reserved device names with extensions, COM/LPT superscript variants, control characters, invalid Windows characters, trailing dots/spaces, dot components, and the 255-character component limit.
- Non-string JSON values now produce HTTP 400 rather than throwing.
- Reused the existing `moveFileNoReplace` helper for forward rename and rollback so a destination created after preflight is not overwritten.
- Renaming a file to its existing relative path is a no-op, but only after confirming the source still exists.
- A racing `EEXIST` is returned as HTTP 409 rather than a generic HTTP 500.
- Added focused regression tests for the filename matrix, malformed JSON values, a destination created between preflight and move, no-op ordering, and route wiring.

**Commits:**
- `e9507fce5739b46f303695a7847917588b77d0f6` — portable filename validation and no-replace rename.
- `5c8afebe4d969bacc519bae563a278709bddcfbb` — corrected regression assertions.
- `225f2d33e60bb15b6b3823323ec470f9689f4c60` — source-check ordering, HTTP 409 mapping, and Windows test step.

**Status:** target-tested.
**Validation:** Fast Validation #828 passed Linux targeted tests on the implementation/test head. Fast Validation #829 passed Linux and Windows, including the new Windows media-rename test ([#829](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42122492014)); Dependency Review #592 passed ([run](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42122491867)).
**Remaining risk:** The no-replace helper's cross-device fallback uses an exclusive copy; preservation of all platform-specific extended metadata on every NAS implementation is not proven. The filesystem-to-database crash window is not journaled, and case-only rename on case-insensitive filesystems remains a separate UX edge case.

## 2026-11-05 follow-up — media rename race response and Windows test coverage

Fast Validation #828 ([run](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42121778144)) passed Linux typecheck/generated contracts, release/storage contracts, PostgreSQL media wildcard and conversion integration, targeted backend regressions, and the Windows launcher/storage/conversion/7-Zip/updater smoke job. Its Windows job did not yet execute the media-rename test file. Dependency Review #591 ([run](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42121777938)) passed.

A source-order review found that the initial no-op branch could return success before confirming the source still existed. The branch was moved after the source existence check. The route also maps a racing `EEXIST` from the no-replace operation to HTTP 409. The Windows Fast Validation job now executes `media-rename.test.ts`, exercising the no-overwrite and portable filename behavior on Windows.

**Status:** target-tested by Fast Validation #829 on both Linux and Windows. See the finding above for exact commits and remaining risk.

## 2026-11-05 follow-up — media rename UI state and accessibility

**Source finding:** The MediaViewer rename dialog updated only the in-memory `file.name` after a successful API rename. It left `file.relativePath` stale and did not notify the parent page, so the viewer path and React Query media-list cache could continue showing the old path. The dialog also lacked a programmatic name/label, did not announce validation errors, and had no keyboard focus loop or explicit focus restoration.

**Fixes:**
- The rename request now returns the server's authoritative `id`, `name`, and `relativePath`.
- MediaViewer exposes an `onRenameChange` callback; the parent updates matching cached media rows and invalidates the media query.
- The viewer uses the returned relative path rather than reconstructing it from stale state.
- The dialog now has `role=dialog`, `aria-modal`, and a labelled title; the filename input has a real label, invalid state, and described error.
- Error messages use an assertive alert.
- Focus moves into the input on open, Tab/Shift+Tab are kept within the dialog, Escape closes it, and focus returns to the Rename trigger.

**Commit:** `8075d59e25aa9419f59b4d24fcfec5cbc38292ca`.

**Status:** target-tested by Fast Validation #830 ([run](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42123498776)). Linux typecheck/generated contracts, release/storage/UI contracts (including the new media rename accessibility and cache-state assertions), PostgreSQL media wildcard and conversion integration, and targeted backend regressions passed. The Windows job also passed, including the media-rename no-overwrite/portable-filename test and the packaged/developer updater recovery tests. Dependency Review #593 passed ([run](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42123498763)).

**Remaining risk:** Browser-based keyboard and screen-reader verification is still outstanding. The rename filesystem-to-database crash window remains separate and needs a durable reconciliation design; this UI batch does not solve it.

### Prioritized findings ledger addendum — 2026-11-05

| Severity | Affected workflow | Status | Commit / validation | Remaining risk |
|---|---|---|---|---|
| Critical | Organize → replace existing destination | blocked | Existing audit findings; source reconfirmed | Displaced original still lacks a durable, verified replacement journal. |
| Critical | Organize execute/resume/rollback ownership | blocked | Source inspection in current audit | Timestamp heartbeat is not filesystem fencing; stale workers may outlive database ownership. |
| Critical | Conversion worker ownership | blocked | Existing PostgreSQL lock/recovery tests pass, but do not prove filesystem fencing | A stale worker may still write after losing its advisory-lock connection. |
| High | Windows updater recovery bootstrap | found | Source inspection of installer shortcuts and directory swap | Launcher is inside the directory moved during update; stable bootstrapper/versioned directory design needed. |
| High | Updater journal terminal cleanup | found | Source inspection and packaged updater tests | Terminal phase ordering and backup cleanup need crash-safe reconciliation. |
| High | Minimum Windows version enforcement | found | Signed release metadata is generated but not enforced by installer/updater | Unsupported Windows systems may attempt an update; enforce signed minimum before download/install. |
| High | Validation-only release workflow permissions/secrets | found | Workflow source inspection | Separate read-only validation and protected publishing/signing identities. |
| Medium | Media rename input, portable names, and no-overwrite race | target-tested | `e9507fc`, `5c8afeb`, `225f2d3`; Fast Validation #829 | No durable rename journal; cross-device metadata and case-only rename need further verification. |
| Medium | MediaViewer rename state and dialog accessibility | target-tested | `8075d59`; Fast Validation #830 | Browser/screen-reader verification remains outstanding. |
| High | Complete standard-user installer lifecycle | found | Fast Validation smoke tests are not a full installed-product lifecycle | Clean install, real upgrade, interruption, rollback, and uninstall still need isolated end-to-end execution. |

### Current PR snapshot

- PR #2 remains open, draft, unmerged, and reported mergeable.
- Branch: `audit/full-repository-review-2026-11`.
- Head: `8075d59e25aa9419f59b4d24fcfec5cbc38292ca`.
- GitHub reports 848 commits and 143 changed files.
- Comparison with `main`: 848 ahead, 1 behind; merge base `bd206ed99f06fb08fa792bbc94b03312fe01a0f0`.
- No review threads were returned.
- No merge, close, force-push, rebase, main-branch change, production-data change, credential change, or release publication was performed.

**Validation classification:** Fast Validation #829 and #830 plus Dependency Review #592/#593 passed. These are targeted, integration, and Windows smoke validations. They are not full CI, a complete installed-product lifecycle, or browser-based accessibility validation.

## 2026-11-05 audit batch — keyboard-operable media workflows and artifact base-path routing

### Findings and fixes

**Medium — Search result cards were pointer-only.** The result card was a clickable `div`, so keyboard users had no native open action. The Similar action was nested inside the same click surface and hidden until hover. The card now has a labelled native open button, while Similar is a separate button; its visibility works on touch and keyboard focus.

**Medium — Media grid actions could trigger the wrong action.** The thumbnail container used `role="button"` with nested select/favorite buttons. Its key handler could also open the viewer when a keyboard user activated a child control. Selection and favorite controls also lacked reliable accessible names and were visually hidden on touch. The card now uses a native open button with independent labelled select/favorite buttons, `aria-pressed` state, focus indicators, and touch-visible controls. The selected check remains visible.

**Medium — People grid had the same nested-action problem.** A role-button tile contained a Move face button. It is now a native open button with a separate labelled Move face action; the action is visible on touch and keyboard focus.

**Medium — Documents and Organize history rows were not keyboard-operable.** Their table rows opened only through pointer clicks. Both now expose a labelled native button in the primary filename cell. Full-row pointer opening is retained, with an event guard so activating an inner button does not trigger the row action a second time. Organize's filename label also normalizes Windows backslashes before extracting the basename, so it no longer displays the full Windows source path.

**Medium — Cleanup duplicate choices were pointer-only.** The candidate tile is now a native button with a descriptive accessible name, `aria-pressed` selection state, and a visible focus indicator.

**Medium — Three frontend API URLs bypassed the configured artifact base path.** Vite sets `BASE_PATH` per artifact, but Cleanup thumbnails, Media Detail streaming, and Optimize scans hardcoded root-relative `/api` URLs. Those requests now use the shared `apiUrl` helper. A source scan of the audited web page set found no remaining hardcoded root-relative `/api/` URLs in those pages.

### Focused regression coverage

Expanded `scripts/ui-accessibility.test.mjs` with source-contract checks for Search, Media, People, Documents, Organize, Cleanup, Windows path basename handling, and the three base-path URLs. These are focused source-contract tests, not browser or screen-reader tests.

### Validation

- Fast Validation #856 ([run](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42126912114)) passed on code head `83bd8216c2dad78346baefff67161ea9ebf458f2`. Both jobs passed: Linux `validate` and `windows-archive-and-updater-smoke`.
- Linux validation included workspace typecheck/generated API contracts, Expo configuration, desktop web-server safety, release/storage contracts (including the new UI source-contract tests), official 7-Zip checks, PostgreSQL media-filter and conversion-lock/finalization integration, and targeted backend regressions.
- Windows smoke included PowerShell parsing, launcher concurrency, environment-file encoding, media rename, storage migration concurrency/no-overwrite, NAS temporary-path cleanup, conversion finalization, official 7-Zip symlink metadata, packaged updater journal writes, and developer updater preservation/rollback.
- Dependency Review #619 ([run](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42126912567)) passed on the same code head.
- Earlier Fast Validation attempts #842, #848, and #853 exposed defects in the newly added static test assertions (invalid regex escaping and over-specific source matching); those test-only issues were corrected before #856. The application typecheck passed in those attempts. Only #856 is counted as the successful latest-head validation.
- No browser-based keyboard/screen-reader run, real non-root Replit deployment, or complete installed-product lifecycle was performed. The Windows job above is the existing archive/updater smoke, not the full Inno Setup clean-install/upgrade/uninstall lifecycle. No release workflow was run.

### Prioritized findings ledger — current batch

| Priority | Workflow / finding | Status | Commit / evidence | Remaining risk |
|---|---|---|---|---|
| Medium | Search result card keyboard and touch access | target-tested | `e4ff6ade`, `bfb83d89`; Fast Validation #856 | Browser and assistive-technology verification |
| Medium | Media grid open/select/favorite action separation | target-tested | `aa1ce941`, `940e2adb`, `186c29c7`; Fast Validation #856 | Browser and assistive-technology verification |
| Medium | People face-grid open/Move face controls | target-tested | `1fafc482`; Fast Validation #856 | Browser and assistive-technology verification |
| Medium | Documents and Organize table navigation | target-tested | `191a86d9`, `552914e6`, `7cdfe938`, `4854e134`; Fast Validation #856 | Browser and assistive-technology verification |
| Medium | Cleanup duplicate keep selection | target-tested | `1e7cb573`; Fast Validation #856 | Browser and assistive-technology verification |
| Medium | Cleanup, Media Detail, and Optimize artifact base-path URLs | target-tested | `ff270f26`, `49ae062a`, `390361b6`; Fast Validation #856 | Live non-root Replit deployment verification |
| Low | Windows source-path basename in Organize history | target-tested | `bb567532`, `c372c25a`; Fast Validation #856 | Browser verification on an actual Windows library path |

### PR and safety snapshot

- The validated application-code head was `83bd8216c2dad78346baefff67161ea9ebf458f2`.
- PR #2 remained open, draft, unmerged, and mergeable at that head.
- All code and audit updates remain on `audit/full-repository-review-2026-11`. No changes were made to `main`, production data, credentials, or published releases.

**Next batch:** prioritize the Critical Organize `replace` displaced-file journal and stale organization/conversion worker filesystem fencing. These need durable ownership/recovery design and race/crash tests; do not apply a superficial rename or heartbeat-only workaround. The separate Windows installer lifecycle and signed minimum-Windows-version enforcement findings remain open.


## 2026-11-05 follow-up — enforce the signed minimum Windows version before updating

### Finding and correction

**Medium — The signed `minimumWindowsVersion` field was not enforced by the packaged updater.** The release signature authenticated the field, but manifest validation only checked that a truthy value was a string. The Windows launcher verified the signature and then proceeded to download and install a newer release without checking the operating system. A future release raising its Windows requirement could therefore be offered to an unsupported computer.

**Fix in this batch:** the release contract now validates a numeric Windows NT version in `MAJOR[.MINOR[.BUILD]]` form and exposes a comparator used by the packaged PowerShell launcher. The launcher reads the local OS version from `Win32_OperatingSystem.Version`, checks the signed minimum after signature verification and before artifact download, and skips the update without stopping the current working installation when the machine is below the requirement. If Windows version detection fails, the update fails closed while normal startup continues. The current manifest value `10` means Windows NT major version 10 or later (Windows 10/11); a future Windows 11 build requirement can be expressed as `10.0.22000`.

### Regression coverage

- Release-contract tests cover numeric version ordering, Windows 10/11 build boundaries, malformed values, and signed manifest validation.
- The Windows updater journal smoke now exercises the production comparison helper and verifies the local CIM version probe.
- Installer source-contract tests assert signature verification precedes the compatibility check and the compatibility check precedes artifact download.

### Prioritized findings ledger — current batch

| Severity | Workflow / finding | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Packaged updater ignores signed minimum Windows version | integration-tested | `6c0518f5`; Fast Validation #858 and Dependency Review #621 | Actual Windows 10/11 machine update and full installer lifecycle were not run |

**Validation classification:** Fast Validation #858 passed on code head `6c0518f59ff723e7098cb19b60d0af27e682dbba`; both Linux validation and the Windows archive/updater smoke job succeeded. Dependency Review #621 passed. The Windows smoke exercised the CIM version probe and production comparison helper, and the Linux job ran the signed-manifest and version-comparison regressions. This is integration coverage for the compatibility helper, not an end-to-end signed release update on Windows 10 and Windows 11, a full installer lifecycle, or release-readiness validation.


## 2026-11-05 follow-up — safe Windows uninstall and fail-closed service tracking

### Findings

**Medium — The Inno Setup installer stopped services before an upgrade but did not stop them before uninstall.** The only shutdown event was `PrepareToInstall`; the uninstaller could begin deleting the bundled Node runtime while the packaged API and web server were still running. The existing installed-lifecycle smoke reached uninstall only after an injected database-startup failure had already left the services stopped, so it did not exercise this real-user path.

**Medium — Corrupt process state and WMI errors could be mistaken for no running services.** `Read-Pids` returned `$null` for malformed JSON, and `Get-ProcessIdentity` returned `$null` for every CIM query error. `Stop-Services` could therefore delete the state file and report success without proving that tracked processes were gone. That behavior was unsafe for both installer shutdown and packaged updates.

### Fixes

- Added one shared Inno Setup shutdown helper for upgrades and uninstall.
- Added `CurUninstallStepChanged(usUninstall)` so the uninstaller stops Willard after the user confirms uninstall and before payload deletion. If the shutdown helper cannot run or returns a failure code, the uninstaller logs the error, displays an actionable message when interactive, and aborts instead of deleting files.
- `Read-Pids` now validates the JSON structure, supported journal versions, run token, process IDs, and executable identity fields. A corrupt or incomplete file is preserved and raises an actionable error rather than being treated as an empty process list.
- `Get-ProcessIdentity` now distinguishes a process that no longer exists from a failed CIM query. Query failures and incomplete executable identity information abort shutdown rather than silently allowing installation changes.
- The startup failure handler now preserves the original startup error while separately reporting any failure to stop services safely.
- Expanded the Windows updater smoke with corrupt/incomplete process-journal regressions. Expanded the installed-lifecycle smoke to start both services immediately before uninstall and assert both listening ports close and the external media, settings, and PostgreSQL markers remain intact.

### Prioritized findings ledger — current batch

| Severity | Workflow / finding | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Inno Setup uninstall while Willard services are running | fixed / target-tested pending CI | this batch | The installed-lifecycle smoke is source-updated but has not run on this PR branch; Inno compile/runtime uninstall validation remains pending |
| High | Corrupt or unreadable packaged service process journal treated as no services | fixed / target-tested pending CI | this batch | Windows smoke and real stop/uninstall integration pending; stale PID reuse is still intentionally handled by refusing to kill a process whose identity does not match |

**Validation classification:** source inspection and focused regression-test changes complete. The Windows updater smoke is expected to exercise the process-state parser; the actual Inno uninstall-while-running lifecycle is covered by the updated lifecycle script but is not part of ordinary Fast Validation. No new test or CI pass is claimed until the matching branch-head run completes.

### Follow-up correction — rollback must not move the installation after an unverified stop

Source review of the new fail-closed process handling found an additional consequence: the launcher startup failure handler attempted to restore the previous release even if `Stop-Services` itself failed. That could rename the active installation while a service process was still using it. The handler now gates rollback on a successful service-stop result, retains the previous release backup if shutdown cannot be verified, and uses the original `Process` handles to stop only API/web processes started by the current launcher attempt. It does not kill processes discovered only by an untrusted or corrupt PID journal.

Fast Validation #860 exposed one test-only assertion error: the uninstall source test searched for the shutdown-helper error text inside the event-procedure slice even though the text correctly lives in the shared helper. The assertion now inspects the helper separately. This was a source-contract test failure, not an Inno compile or Windows runtime result. The corrected assertion and the new rollback-gating regression are included in the next validation batch.

The installed lifecycle smoke also now treats an incomplete TCP connection probe as inconclusive and retries rather than reporting the port closed prematurely. Its process-path fixture was normalized to a single Windows path separator.

**Current validation status:** the preceding Fast Validation #860 failed at the source-contract assertion described above; Dependency Review #623 passed. The corrected tests and rollback-gating change are committed in the following batch. The actual Inno Setup uninstall-while-running lifecycle remains unexecuted on this PR branch and must not be described as integration-tested.

### Follow-up test correction — anchor the rollback assertion to the outer startup handler

Fast Validation #861 reached the release/storage contract suite and failed one newly added source-contract assertion. The assertion used `lastIndexOf("} catch {")`, which selected the nested `Stop-Services` catch rather than the outer startup failure handler. The test now anchors on the outer handler assignment `$startupError = $_` and verifies the stop attempt, rollback gate, and restore call in that scope. This is a test-selection correction; the runtime rollback-gating code remains unchanged.

The corrupt-process-state error now also gives an explicit recovery path: preserve a copy for diagnosis, manually confirm all Willard processes are stopped, then rename or delete the invalid state file and retry. This avoids leaving a user with an error that says to retry while the same unreadable file remains in place.

**Validation status:** Fast Validation #861 failed only at the rollback source-contract assertion; the Windows job was skipped because Linux validation failed. Dependency Review #624 passed. The corrected assertion and explicit recovery instructions are in the next branch-head validation batch.

## 2026-11-05 follow-up — extend fail-closed service ownership to the developer launcher

Source inspection found the same process-state weakness in the developer launcher (`scripts/launcher/common.ps1`): `Read-TrackedPids` treated malformed JSON as an absent process list, and `Get-ProcessIdentity` treated every CIM failure as a process that no longer existed. The startup function also attempted journal-based cleanup after a tracking failure but did not retain a direct cleanup path for the API/web `Process` handles it had just created.

**Fix in this batch:** the developer launcher now validates the versioned process journal and executable identity fields, preserves invalid state for manual recovery, and distinguishes a missing process from a failed CIM query. The developer startup failure handler attempts the existing tracked-process shutdown and then stops only the exact process handles created by that startup attempt. The Windows updater journal smoke now parses the production developer process-state reader, tests valid and corrupt records, and injects a synthetic CIM failure into the production identity helper. Linux source-contract tests cover the developer shutdown fallback.

Fast Validation #862 failed at the rollback-gating source assertion because the test file still contained the prior `lastIndexOf` selector. The assertion is now explicitly anchored to the outer handler marker `$startupError = $_`; this is a test-selection correction, not a change to the already committed runtime gate. Dependency Review #625 passed. The current batch includes the corrected assertion and the developer-launcher regression coverage; validation is pending.

### Prioritized findings ledger — developer launcher follow-up

| Severity | Workflow / finding | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Developer launcher treats corrupt process journal or WMI query failure as no running services | fixed / target-tested pending CI | this batch | Windows process-state smoke and real developer launch/stop integration pending |
| Medium | Developer launcher may leave a just-started API/web process untracked if PID persistence fails | fixed / target-tested pending CI | this batch | Direct `Process` handle cleanup is covered by source-contract tests; full failure injection on Windows remains pending |

**Validation classification:** source inspection and focused regression tests added. The Windows updater smoke now exercises both packaged and developer process-state readers, but the full installed Inno uninstall-while-running lifecycle and a real developer launcher fault-injection run remain unexecuted on this PR branch.

### Follow-up test correction — explicit CIM class argument

Fast Validation #863 ran 73 installer/source-contract tests: 72 passed and one existing developer-startup assertion failed because it expected the older positional `Get-CimInstance Win32_Process` syntax. The production helper now uses the explicit `Get-CimInstance -ClassName Win32_Process` form so its target class is unambiguous; the source assertion now matches that intentional form. The Windows job was skipped after the Linux validation failure. Dependency Review #626 passed. The synthetic WMI-failure fixture was also tightened to declare the cmdlet-style parameters and common parameters so it exercises the intended exception path rather than a parameter-binding error.

**Validation status:** the code changes remain source-reviewed; the corrected Linux source-contract test and Windows process-state smoke are pending the next matching branch-head run.

### Follow-up Windows parser correction and remaining missing-journal risk

Fast Validation #864 passed Linux validation, including 73 installer/source-contract tests, but the Windows job caught a real PowerShell parse error in the new WMI error message: PowerShell interpreted `$processId:` as a scoped variable reference. Both packaged and developer launchers now delimit the variable as `${processId}:`. The Windows job stopped at the launcher parse step, so the updater journal smoke did not run in #864. Dependency Review #627 passed. The next branch-head Windows run must confirm the corrected scripts parse and the new process-state smoke executes.

**Additional high-priority finding — a missing PID journal is still treated as no running services.** The new readers fail closed when the journal exists but is malformed or incomplete. However, `Read-Pids` and `Read-TrackedPids` still return `$null` when the file is absent, and the stop routines then assume there are no tracked services. A crash between process creation and the first durable PID write, manual deletion, or filesystem loss can therefore leave a live service untracked; a later start or uninstall may proceed without stopping it.

**Safe implementation plan (not patched in this batch):** add a read-only orphan-service discovery step for the missing-journal case. It must identify only processes whose executable path exactly matches the packaged/developer Node runtime and whose command line contains the expected API or web entrypoint under the active install root. If any such process is found, fail closed and require explicit stop/recovery; do not kill by process name or port alone. Add Windows tests for missing journal + matching process, missing journal + unrelated Node process, and PID reuse. Longer term, use a Windows Job Object with kill-on-close semantics so a launcher crash cannot leave child services running before their process identities are journaled.

This means the new corrupt-journal and WMI-error protections are useful but do not make installer shutdown fully safe when the journal is missing. The Inno uninstall hook remains source-reviewed; its full installed lifecycle has not been executed on this PR branch.

## 2026-11-06 follow-up — detect untracked packaged Windows services

### Finding: missing or partial service journals could hide a live packaged process

**Severity:** High (installer reliability, update safety, and service lifecycle integrity).
**Affected workflows:** Packaged Windows launcher startup and stop; installer upgrade and uninstall.

**Source inspection:** `desktop/WillardMediaCenter.ps1` writes the API process record immediately after starting the API, then starts the web process and writes the complete pair. A crash between those steps leaves a valid journal with `web = null`. A crash before the first journal write, or deletion/loss of `services.json`, leaves no journal at all. Previously, `Read-Pids` returned `$null` for a missing file and `Stop-Services` stopped only processes named in the journal. An orphaned packaged API or web service could therefore survive while a later launcher, update, or Inno uninstall proceeded as if nothing were running.

**Fix in this batch:**
- Added read-only process discovery using the existing Windows CIM process provider. A candidate must use the exact packaged Node executable and its command line must contain the exact absolute API or desktop web-server entrypoint path with argument boundaries.
- Compared discovered processes against the journal using PID, executable path, command line, and creation date. A reused PID is not treated as ownership.
- Startup and stop now refuse to proceed when an untracked packaged service is found. They also fail closed when CIM cannot enumerate processes or when a matching process identity is incomplete.
- Discovery does not kill processes, clear the journal, move installation directories, or modify user data. The diagnostic lists role and PID and instructs the user to verify and close only the confirmed Willard process.
- Stop repeats discovery immediately before acting, rather than relying solely on an earlier startup check.

**Regression coverage added:**
- Missing journal with a matching API process.
- Partial API-only journal with a live web process.
- PID reuse with a different executable identity.
- Unrelated Node process and a path-prefix lookalike.
- CIM query failure, missing command line for the packaged Node runtime, missing executable path for a matching entrypoint, and missing process creation time. Legacy journal records without creation time are not trusted to prove ownership against PID reuse.
- Source-contract checks that discovery is read-only and runs before startup decisions and before journal-based shutdown.

**Implementation commits:** `78902ad4c15f520886d26ad90cc5066a8dfdd8ee`, `ddcb2c726b0a5e11bab71422323897289e668237`, `cf538676f511e40b54a56c8fa5e9d2c7d9e45a4b`, `9a1abb920654d9b4fd160208cf894134fe5ae803`.
**Test commits:** `18cd7ac09159458b7c99edab6d48faf5e7f02c0a`, `fd9df23d33e921b2cf9bf8946eb7ebb01cbec15b`, `7ef1095e054636a225e08de0886c540a8ece9a5d`, `13f97b0678d2196017cc6fd2689c3b3d9243dfea`, `eb5742ee5b15e365491c3f10d866438f91c2d8f5`, `29e9cd0b5f2779a57a05ba118e71cb154d35c721`.

**Status:** implementation and focused regression cases committed; target validation pending the matching branch-head CI run. The Windows smoke exercises the production PowerShell functions with synthetic process records; it does not launch or terminate a real orphan process.

**Remaining risk:** This batch covers the packaged Windows launcher only. The developer launcher has the analogous missing/partial journal gap and remains open for a separate follow-up. CIM process visibility can also vary by Windows security context; the implementation fails closed when a candidate entrypoint is visible but its executable identity is not. A Windows Job Object remains a stronger future design for eliminating the process-start-to-journal crash window rather than detecting it on the next launch.

### Prioritized findings ledger — packaged service ownership

| Severity | Workflow / finding | Status | Commit | Remaining risk |
|---|---|---|---|---|
| High | Packaged launcher may miss API/web processes when `services.json` is missing or only partially written | fixed; target validation pending | implementation: `cf538676`; regression tests: `fd9df23d` | Matching Fast Validation and Windows smoke pending; full installed installer lifecycle remains separate |
| High | Developer launcher may miss an orphan when its process journal is missing or partial | found / blocked for next batch | not fixed | Needs exact process-tree ownership for Node API and pnpm/Vite web process; do not kill by port or process name |


## 2026-11-06 follow-up — do not uninstall or upgrade past a missing shutdown helper

### Finding: Inno Setup silently skipped service shutdown when the launcher file was missing

**Severity:** High (installer lifecycle and orphaned service risk).
**Affected workflows:** In-place installer upgrade and uninstall.

**Source inspection:** `installer/WillardMediaCenter.iss` previously called `StopWillardServices` only when `{app}\desktop\WillardMediaCenter.ps1` existed. If the installed launcher had been deleted or a prior installation was partially damaged while the Node services remained active, the helper returned success without attempting shutdown. Inno Setup could then replace or remove the payload while the old service processes continued running.

**Fix in this batch:**
- `StopWillardServices` now accepts an explicit `RequireLauncher` flag and returns an actionable error if the shutdown helper is missing when it is required.
- A fresh install is still allowed when no previous packaged Node runtime exists.
- An in-place upgrade requires the launcher whenever the existing packaged Node runtime is present; it stops before payload deletion if the helper is missing.
- Uninstall always requires the launcher and aborts before removing the installation if shutdown cannot be attempted or verified.
- The recovery message directs the user to reinstall/repair the same installation to restore the helper before retrying.

**Regression coverage:** Added source-contract tests for the fresh-install exception, existing-runtime upgrade guard, and unconditional uninstall requirement.

**Implementation commit:** `36c715dd2e9ea72c95e317534558b9fd15aa0e92`.
**Test commits:** `08759c294e886ab686ccda71b31543859290fd72`, `acd8d8822feb60fcf256d5b27e5d323bd46495e9`.

**Status:** source-reviewed and regression assertions committed; matching Fast Validation pending. The Inno Setup script has not yet been compiled or exercised by the real standard-user installer lifecycle on this branch.

**Remaining risk:** This guard intentionally blocks upgrade/uninstall when the shutdown helper is missing, even if no services are currently running. That is safer than silently proceeding, but the user must repair the launcher first. Full installer compile, fresh install, upgrade, running-service uninstall, and external-data preservation remain required integration validation.

### Prioritized findings ledger — installer shutdown helper

| Severity | Workflow / finding | Status | Commit | Remaining risk |
|---|---|---|---|---|
| High | Inno Setup previously proceeded when the packaged shutdown helper was missing | fixed; source-contract tested | `36c715dd`; tests: `acd8d882` | Inno compilation and real standard-user lifecycle integration pending |


### Upgrade compatibility boundary — prior installed launchers

The new orphan-process discovery lives in the packaged launcher payload. During an in-place upgrade, Inno Setup's `PrepareToInstall` runs the **previously installed** launcher before the new payload is copied. Therefore, when upgrading from a release that predates this discovery, its `-Stop` implementation can still miss a missing or partial `services.json`. The new launcher protects subsequent starts, stops, and uninstall operations after the upgrade, but this batch does **not** yet prove that an upgrade from every older release is safe when its process journal is missing.

**Status:** found / blocked; no partial workaround applied.

**Safe implementation plan:**
1. Add one small process-verification helper to the release payload and embed a temporary copy in the Inno Setup package.
2. During `PrepareToInstall`, run the previous launcher shutdown first, then run the embedded helper against the exact old `{app}\runtime\node.exe` path. Refuse the upgrade if any process still uses that runtime or if Windows cannot inspect process identity.
3. Install the same helper beside the new launcher so future uninstalls can verify that no process remains even if the launcher journal is missing or the launcher itself cannot be started.
4. Keep this check read-only: never kill by process name or port; show process IDs and abort so the user can close only the confirmed processes.
5. Add Windows integration coverage using a disposable install tree and real child processes for missing journal, API-only journal, normal complete journal, PID reuse, and WMI failure. Run the standard-user installer upgrade and uninstall lifecycle before declaring this path validated.

This requires coordinated release-stager, Inno Setup, and Windows integration changes; it is intentionally not represented as fixed by the current launcher-only detection.

| Severity | Workflow / finding | Status | Commit | Remaining risk |
|---|---|---|---|---|
| High | Upgrade from an older installed launcher may still leave an orphan service because Inno invokes the old `-Stop` before copying the new detector | found / blocked | none | Needs an installer-embedded verifier and real Windows upgrade lifecycle test |


## 2026-11-06 follow-up — developer launcher must not update over orphaned service listeners

### Finding: missing or partial developer process journal could let setup, repair, or update proceed while an old service remained active

**Severity:** High (installer/developer lifecycle, file consistency, and update reliability).
**Affected workflows:** Developer Start, Setup, Repair, Update, and tracked-service shutdown.

**Source inspection:** `scripts/launcher/common.ps1` returned success from `Stop-TrackedProcesses` when `willard.pids.json` was missing, and the repair path could clear a stale process journal without checking whether a descendant service still owned either application port. The previous `Test-PortFree` and `Get-PortOwnerPid` helpers used `-ErrorAction SilentlyContinue`; a Windows TCP-query failure could therefore look like an unused port.

**Fix in this batch:**
- Added one shared strict listener query for the developer API (8080) and web app (5000) ports. Query failures or invalid owner PIDs now fail closed rather than looking like an empty result.
- Start, Setup, Repair, and Update inspect the process journal and refuse to proceed when a listener exists but the journal is missing or incomplete.
- Setup now routes any existing journal through the shared stop path before changing dependencies or database state.
- Repair no longer clears a stale journal directly. It uses the shared stop path, which verifies both application ports are no longer listening before clearing ownership state.
- The shared stop path retains its journal if a listener remains after tracked processes have been stopped.
- Added a Windows smoke test for missing journal, partial journal, TCP-query failure, and a listener that remains after tracked processes exit. Added source-contract coverage and wired the smoke test into Fast Validation's Windows job.

**Implementation commits:** `89ff7db50dd63d6c4abe27dc998e995704214793` (shared strict listener inspection), `a609d14f5fda684794cc28679e49d4ffee2d2746` (Start guard), `82ab2bba58781a6c80e6bed78b59436c84e4f458` and `31e57268a455df450e2cbce8438a749fcf262534` (Setup guard and tracked stop), `be03828c6ab41873bd8f630a58653e48d2f8c72e` and `bb4f695ca805f827146c0f8aeb8620345143b830` (Repair guard and no blind journal clearing), `fd216718fa1f665835b6720b024f2f05b4d08f12` (Update guard).

**Regression and CI commits:** `e70039663400b160efb19cd875b64ffd940066df`, `671939f174b3bc2f64db613dac1b47b9462cf36d`, `16e5138be6e53816cb1ccc841de20fa7ce681771`, and `318cb2c8dc945520ed042b956da128c425519d9d`; source-assertion correction `ca070d4bc0b1bafecc3a25d839050e9f9697f1c6`.

**Status:** implementation committed; targeted PowerShell smoke and source-contract tests added; matching Fast Validation run is pending. No Windows test result is claimed yet.

**Remaining risk:** This is a conservative listener-based guard, not complete process-tree fencing. It detects services that have already bound ports 8080 or 5000. It does not close the process-start-before-listen race, prove ownership of every background child, or serialize a second independent developer launcher that starts between the check and filesystem swap. A durable process-tree ownership design (for example, a Windows Job Object plus a shared lifecycle lock) remains a separate architectural follow-up. If Windows cannot inspect the TCP listener state, the operation stops rather than proceeding.

### Prioritized findings ledger — developer service ownership

| Severity | Workflow / finding | Status | Commit | Remaining risk |
|---|---|---|---|---|
| High | Start, Setup, Repair, or Update could miss a live service when the developer PID journal was missing/partial; TCP-query errors could look like free ports | fixed; target validation pending | implementation: `89ff7db5`, `a609d14f`, `82ab2bba`, `31e57268`, `be03828c`, `bb4f695c`, `fd216718`; tests/CI: `671939f1`, `16e5138b`, `318cb2c8`, `ca070d4b` | Await Windows smoke and Fast Validation; process-start-before-listen race and concurrent launcher fencing remain open |


## 2026-11-06 architecture review — durable organization Replace recovery

### Confirmed critical finding

Both normal organization execution and resume still call `fs.unlinkSync(destFile)` when `conflictPolicy === "replace"`, before a journal entry describes the existing destination. A failure or process crash after that unlink can permanently lose the pre-existing destination file. This is distinct from the already-fixed no-replace race in `verifiedMove`: exclusive publication protects a destination that appears concurrently, but it does not preserve the file intentionally removed by the Replace policy.

**Affected workflows:** Organize → Execute, Organize → Resume, Recovery Center rollback, and completed-job verification.
**Severity:** Critical (user media/data loss).
**Status:** found / blocked for an architectural change; no partial filesystem workaround applied.

### Existing architecture that can be reused

Conversion finalization already provides a useful pattern:
- `finalizeConversionFiles` persists each move intent before mutation through `onMoveIntent`.
- It stores the original in a recoverable backup location before publishing converted output.
- It verifies both moves and records the result through `onMoveComplete`.
- `recoverConversionFinalizationMoves` replays the shared checksum-verified rollback helper after restart.

Organization already uses the same `FileMoveRecord`, `verifiedMove`, `moveFileNoReplace`, and `rollbackMoves` primitives. This is preferable to creating another journal system, but organization has different resume and plan-count invariants that must be updated deliberately.

### Safe implementation plan

1. Add an explicit move kind (ordinary source move versus replacement backup) and a stable association to the source relative path. Preserve compatibility with existing journal records that do not have the new field; treat those as ordinary moves.
2. For each Replace collision, compute the existing destination's SHA-256 and reserve a unique backup path in the same destination directory/filesystem. Persist the backup intent before changing the destination. Do not use `unlinkSync` to discard the old file.
3. Prefer a no-overwrite same-filesystem backup operation that preserves the original file's inode metadata. If the filesystem/NAS does not support the required operation, fail closed for that file rather than silently falling back to a metadata-losing copy. Test the actual supported Windows/NTFS and SMB/NAS behavior before enabling the path.
4. Verify the backup hash, then persist and perform the incoming source move using the existing no-replace verified move. Persist both records in order so reverse-order rollback first restores the incoming source, then restores the displaced destination.
5. Make resume inspect the move kind and both paths/hashes. If the backup was completed but the incoming move was not, resume may continue from the preserved backup. If either side is ambiguous or changed, preserve all copies and stop for manual recovery.
6. Update plan coverage, moved-file counts, progress, and destination recounts to count ordinary source moves, not backup journal entries. Keep checksum verification over both ordinary moves and backups.
7. Only remove temporary replacement backups after the completed job status and full final hash verification are durably persisted. If cleanup fails or the process crashes before cleanup, retain the backup path in the job journal so recovery/cleanup can retry safely.
8. Add fault-injection tests for crash before backup, after backup intent, after backup creation, after incoming intent, after incoming move, and during rollback; include destination replacement races, changed files, same-inode hard-link interruption, backup-path collision, and SMB/Windows behavior. Verify the old destination is never silently discarded.

**Important compatibility note:** Resume currently builds `alreadyMovedRelPaths` from every journal entry with a `sourceRelPath`, and its plan coverage assumes one move record per planned source. The new backup record must not be mistaken for a completed source move or inflate user-facing moved counts. Existing unverified intents also need a deliberate source/destination hash reconciliation rule before resume is considered complete.

**User-visible behavior:** Keep the current Replace meaning (the incoming file becomes the destination) and retain the displaced original only as a temporary recovery copy until the job is durably complete. Long-term post-completion version history would be a separate product decision and is not assumed here.

| Severity | Workflow / finding | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Critical | Replace deletes an existing organization destination before journaling or preserving it | found / blocked | design review only; no code change | Requires move-kind journal extension, same-filesystem no-overwrite backup, resume/count compatibility, crash tests, and Windows/SMB integration |


## 2026-11-06 follow-up — archive publication and Trash read-side effects

### Finding: ZIP extraction could replace a destination created after preflight
**Severity:** High (data integrity). **Workflow:** ZIP extraction during archive organization.
**Status:** Fixed; focused regression added; CI validation pending.
`writeArchiveFileAtomically` previously checked the destination and then called `renameSync`. On POSIX, rename can replace a regular file created after the check. The temporary file now publishes through the existing `moveFileNoReplace` helper, which uses exclusive creation semantics and refuses an existing destination. The helper is reused rather than duplicating platform-specific no-replace logic. A regression verifies that an existing regular file is preserved and the temporary extraction file is cleaned up.
**Implementation:** `c9c85a52255624fca8ffb17108ea45d12f8c25aa` (exclusive publication) and `644b3e0c75a57d5b0a519104d75fecf8092e266b` (shared helper import).
**Test:** `12c3c601cdb7ff997feb1ca15ecb521d806ead8d`.
**Remaining risk:** This focused regression covers an already-present regular destination; an orchestrated concurrent-writer test and full malicious-archive Windows integration remain outstanding.

### Finding: reading the Trash page triggered permanent deletion
**Severity:** High (unexpected destructive side effect). **Workflow:** Cleanup → Trash listing.
**Status:** Fixed; route contract regression added; CI validation pending.
The GET /cleanup/trash handler called `purgeExpiredTrashEntries`, so simply opening or refreshing the page could permanently remove files. The GET handler is now read-only and only reads the manifest. Existing startup recovery remains the retention-cleanup trigger; no new scheduler or dependency was introduced. A route-level source-contract test asserts that the GET handler does not invoke permanent-retention cleanup.
**Implementation:** `d958b5b7c976c7b184618f755e2e060fc0a53175`.
**Test:** `1ddfd33e8aac1cb024ddd336af15bf6f79e5129d`.
**Remaining risk:** Expiration cleanup still lacks content-hash verification before permanent removal. The next retention batch must verify the trash object is a regular file, matches recorded size and a valid SHA-256, and remains inside the canonical trash root before deleting it. Missing or mismatched integrity metadata must be preserved for manual review. Startup-only execution also means expiration cleanup is not guaranteed to run until the next restart.

### Validation record
The two changes above are committed to `audit/full-repository-review-2026-11`. Focused regression tests were added but have not yet been executed in a local checkout or confirmed by the matching latest CI run. Do not mark this batch integration-tested or fully validated until the corresponding workflow results are available.


## 2026-11-06 follow-up — verified Trash retention

### Finding: expired Trash entries could permanently delete modified or unverifiable content
**Severity:** High (data loss). **Workflow:** Cleanup → local Trash retention.
**Status:** Fixed; focused filesystem regressions added; CI validation pending.
Before permanent deletion, retention now requires a regular non-symlink file, an exact manifest size match, and a syntactically valid SHA-256 that matches the file's bytes. Entries with missing/invalid hashes, changed content, size mismatch, symlinks, or special filesystem objects are preserved and reported for review. This intentionally leaves legacy manifest records without hashes untouched rather than guessing that they are safe to delete.
**Implementation:** `20f19bde27af5e3c0515b2c295ca7e5e1a54ba94`.
**Tests:** `72cc15b5d52737b413cc8e2a4e78771dbe2eda5d` covers valid files, changed content, missing hashes, and symlink preservation.
**Remaining risk:** Filesystem deletion and database/manifest reconciliation still span separate durability domains. A crash after unlink but before database and tombstone updates requires additional recovery handling. Startup currently triggers retention cleanup once after launch; no recurring scheduler was added.


## 2026-11-06 follow-up — fail-closed Trash retention identity checks

### Finding: retention could delete a file before confirming its canonical media row still represented that exact recycled item

**Severity:** High (data loss and stale-manifest handling). **Workflow:** Cleanup → local Trash retention.

**Fix:** Retention now refuses to proceed when the trash file is already missing, the manifest has no canonical media ID, or the matching canonical row is absent/not in the recycled state/does not resolve to the manifest's original path. It validates the file's size and SHA-256 only after the canonical identity check, then unlinks it and requires exactly one canonical row deletion before writing the manifest tombstone. This prevents an ambiguous missing file or stale manifest from silently deleting unrelated/restored database state.

**Implementation:** `61b0923b38a87ad5ed6d9b618a306b31d7a29a74`.
**Regression:** `33c2960910506b6b54e5b75aa7e713b947ed25e9` adds a source-order contract test for the fail-closed guards.

**Validation:** Regression added; no local test execution or matching branch-head CI result confirmed.

**Remaining critical risk:** This does not close the cross-resource crash window. A process can still stop after the verified file unlink and before canonical-row deletion/tombstone append. The next safe step is a durable permanent-delete intent and restart reconciliation, likely requiring a new operation type/status and coordinated schema migration. Until that is implemented, any resulting missing-file entry is now preserved for manual review rather than silently finalized.


## 2026-11-06 follow-up — literal wildcard handling in legacy file search

### Finding: filename searches treated wildcard characters as pattern syntax
**Severity:** Medium (search correctness). **Workflow:** canonical media search through `GET /files/search`.

**Source inspection:** `routes/files.ts` passed the user's query directly to Drizzle's `ilike` operator. PostgreSQL therefore interpreted `%` and `_` as wildcards rather than literal filename characters. It also trusted a TypeScript cast for scalar query parameters, so repeated `q`, `fileType`, `source`, `after`, or `before` parameters were not rejected at runtime. The media-list route already had the intended pattern behavior: it reuses `escapeLikePattern` and supplies an explicit PostgreSQL `ESCAPE` clause.

**Fix in this batch:** Reused the existing `sql-like.ts` helper in the legacy-compatible file search route, applying the same escaped, case-insensitive substring semantics as media listing. Replaced the unchecked query cast with the existing `parseOptionalQueryString` validator for all scalar text filters so repeated parameters fail with a clear 400 response. No dependency or new abstraction was added.

**Regression coverage:**
- Added route contract assertions that `/files/search` validates scalar text filters, escapes the user query, and uses an explicit `ILIKE ... ESCAPE` clause.
- Extended the PostgreSQL-backed query regression to prove escaped `ILIKE` matches case-insensitively while literal wildcard lookalikes do not match.

**Validation:** implementation and tests committed together. The Fast Validation workflow is the matching validation path; its result must be checked against the exact resulting branch head before this batch is marked target-tested.

**Implementation commits:** `eb7874a085776b2cd58ac0f53b3931ce18622706` (literal wildcard escaping); `8092dfeeb57f03a8d44b9478e11b4c1bd4c7e79e` (scalar query validation).
**Regression-test commits:** `6d5ccbed42aac7886e9bb56f370624247b19494a` (wildcard semantics); `5820377ea0efe09cc6447acc02d1db21dc4563e2` (scalar query validation).

| Severity | Workflow / finding | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | `GET /files/search` treated `%` and `_` as filename wildcards | fixed; target validation pending | this batch | PostgreSQL-backed regression and full Fast Validation result pending |


## 2026-11-06 safety mitigation — organization Replace now fails closed

### Confirmed critical finding: Replace could permanently discard an existing destination

The full recovery design for Replace requires durable backup intents, checksums, resume compatibility, rollback ordering, and crash-injection coverage. Until that coordinated change is ready, leaving the destructive unlink enabled is not acceptable.

**Mitigation committed:** Both normal organization execution and resume now stop with an actionable error when a Replace collision is encountered. They do not unlink, overwrite, or rename the existing destination. Users can select Rename or Keep Existing to proceed. If earlier files in the same operation were already moved, the existing operation error/rollback path is invoked; this mitigation does not claim to replace or validate that broader rollback architecture.

**Implementation:** `d0a5062e41eb5f6432f03ace315f1abdbec61d23`.
**Regression:** `413e98d6c98de4af72fe97a49d5bd297c02e6eb4` asserts both execute and resume branches fail closed and contain no destructive filesystem operation.

**Status:** Safety mitigation and source-contract regression committed. Test execution and matching CI are pending.

**Product impact:** Replace is temporarily unavailable for collisions. This is an intentional safety restriction, not a completed Replace implementation. Restore Replace only after the durable backup/journal/resume/rollback design above is implemented and Windows/SMB crash tests pass.


## 2026-11-06 follow-up — duplicate storage estimates overstate reclaimable space

**Finding — Medium (product correctness):** Cleanup and the library scan summary estimated reclaimable duplicate storage as `(count - 1) × largest file size` for the summary, and as `(count - 1) × average file size` for detailed groups. These formulas are wrong when perceptually similar files have different sizes. The first overstates savings whenever the retained copy is the largest; the second can overstate or understate savings. The correct theoretical amount when keeping one copy is `SUM(size_bytes) - MAX(size_bytes)`.

**Fix:** Updated both confirmed and unconfirmed duplicate summary queries to sum all candidate bytes and subtract the largest retained copy. Updated the detailed Cleanup endpoint to fetch each group's largest file size, calculate reclaimable bytes consistently, and sort groups using the corrected estimate. This keeps the existing API shape and database architecture.

**Regression:** Added a focused source-contract test to the existing library consistency suite, asserting the SQL formula and the detailed endpoint calculation use the same definition. This is a targeted source-contract regression, not a PostgreSQL integration test.

**Implementation commits:** helper `480fc48553a54d87a22a6bd943066728531e5a13`; route `0982bc6b1a0a90e9d37bea8998bd44010fd903f0`.
**Test commit:** `afd1a41897cf6e83141272074eb703cd665a2b38`.
**Validation:** Source inspection and regression addition complete. Test execution, typecheck, PostgreSQL-backed verification, and matching Fast Validation are pending on the resulting branch head.

| Severity | Workflow / finding | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Cleanup / library duplicate summary overstates reclaimable bytes for unequal-sized perceptual matches | fixed; targeted test pending | `<HELPER>`, `<ROUTE>`, `<TEST>` | Confirm with PostgreSQL-backed fixture covering 100, 60, and 40 byte candidates; browser summary and staging behavior remain to be integration-tested |


**Implementation follow-up:** The detailed endpoint now carries `largest_file_size` through both exact-hash and perceptual group mappings; the focused regression checks both mappings and the aggregate/per-group calculations. Commits: `8b5bbcc79e6ee18107eb4db62b8bc2716b13da02` (mapping correction), `d6c5ca028ed74f209bcd7e4425f2753be7cede74` (assertion correction). These follow-ups were made after source review caught a missing perceptual mapping and overly escaped assertions before validation; they are included in the pending validation head.


## 2026-11-06 follow-up — cancelled conversions with successful staging remain actionable

**Finding — High (workflow correctness / stranded staged output):** The conversion execute handler preserved successfully converted staging files after cancellation, but persisted the job as `cancelled`. The finalization endpoint accepts only `awaiting_action`, so a user could not apply Recycle, Replace, Keep Both, or Archive to those already verified outputs. The UI/API exposed preserved files without a supported path to finish the operation.

**Fix:** A cancelled run with one or more successful staged conversions now transitions to `awaiting_action`, which is the state accepted by the existing finalization and recovery paths. The job retains `cancelledAt` and records `resultJson.cancelled` so cancellation is not lost. A cancelled run with no successful staged files remains `cancelled`. The SSE status message distinguishes the two cases.

**Regression:** Added `optimize-cancel-finalization.test.ts`, a source-contract test for the cancelled/successful and cancelled/no-success branches. This test is added but has not yet been executed.

**Implementation:** `00311e42e9adf6017ee48e8e7d2f3aa20a8de10e`.
**Test:** `c81fa89f6d76386c468fba5da1413af8ae627d56`.

**Validation status:** Test execution, API integration test, and matching Fast Validation are pending. The regression asserts the status contract; it does not yet exercise a live cancellation mid-conversion. A follow-up integration test should cancel after the first verified file and prove the action endpoint accepts the job and finalizes only the staged successes.

| Severity | Workflow / finding | Status | Commit | Remaining risk |
|---|---|---|---|---|
| High | Cancelled conversion with successful staged outputs could not be finalized | fixed in route; source-contract regression added; validation pending | implementation `00311e42`; test `c81fa89f` | Live mid-run cancellation/finalization integration coverage and matching CI pending |


## Cancelled conversion finalization UI follow-up (2026-11-06)
- Followed the server-side cancellation correction through the Optimize page and found two UI paths that still treated a cancelled summary as terminal even when successful files were staged: both live SSE summary handlers gated finalization on `!data.cancelled`.
- The reconnect/polling path also did not recognize the new `awaiting_action` server status as terminal/actionable, and mapped legacy cancelled jobs directly to the done screen.
- Updated both SSE summary handlers to expose finalization whenever at least one file succeeded, regardless of the cancellation flag. Reconnect polling now stops on `awaiting_action` and opens the finalization controls for that server state. The cancelled-state copy now explicitly tells the user to choose what to do with originals.
- Added `artifacts/api-server/src/__tests__/optimize-cancel-ui-finalization.test.ts` to guard both SSE paths and reconnect state mapping.
- UI commit: `d8f186b0a91d9b915c1f595c8e718caa1c5bf7aa`; regression commit: `2a3d48a9f997764356c8baae7aaaeedbad1c6f12`.
- Validation is pending on the current branch head. The new test is source-contract coverage; a browser-level cancellation/reconnect test remains desirable.


## 2026-11-06 high-severity follow-up — organization workers lacked durable ownership fencing

**Finding — High (data integrity / competing workers):** Organization execution, resume, and rollback previously relied on a shared status plus a heartbeat timestamp. A worker reclaimed after a stale heartbeat could use the same `executing` status as the old worker. The old worker's heartbeat and checkpoint writes were scoped by job ID/status rather than a unique ownership identity, so a resumed stale process could continue moving files or overwrite the replacement worker's recovery journal.

**Correction:** Added nullable `organization_jobs.lease_token` and schema version 3 migration. Each execute, resume, and rollback claim generates a cryptographically random token. Heartbeats, stage checkpoints, move-intent writes, verified-move writes, completion, and terminal failure transitions are now conditional on the current token and expected state. Lost-lease workers stop instead of rolling back files owned by another worker. Tokens are cleared on terminal or capacity-admission release transitions.

**Filesystem fencing:** `verifiedMove` accepts ownership checks after source hashing and immediately before moving, plus before its local restoration path. `rollbackMoves` accepts an ownership callback, checks before each file and before rollback filesystem mutations, and propagates lost-lease errors instead of treating them as ordinary file failures. Execute, resume, and Recovery Center rollback pass the active token guard.

**Regression coverage:** Updated the schema bootstrap test to require the existing-install migration and added a source-contract test covering the schema field, unique tokens for all three workflows, token-conditional updates, and filesystem guard hooks.

**Implementation commits:** schema `652cc6847b1da08e4be670cf3cabe77473921866`; bootstrap migration `0521dfb83be1c490b856671f19fc736f7f8884d6`; bootstrap test `0624e9bcec71aa5bfd22af2ddae4777ecc2b1b5c`; execution fencing `967639a456096a4b3e006a5944268f22af1f3b3a`; resume fencing `0d390fe2884d866a6f1b84a4ff0c5bcdcb1ded89`; rollback fencing `71747fd2c868bd4faf40c6ee4323cfd847ce72c2`; lease transition hardening `1094788dc6d64e7b9270113fd18420af881fb0a5`; rollback helper guard `244b96a688c64c45985489cf18fc66ea7f6c6dc7`; verified-move fencing `ce3de5ccc8a6cc6fc908921ac9fd6636b68662f6`; route guard integration `56edcbf9cc80d32e194b6b0bab42b477163c2b36`; regression contract `12ff609b4ba725757a07984492c946d5d4d374f7`; rollback mutation guard `46021c6d328e1f547570a4c5e65331723b7aab4b`; lost-lease propagation `e5c794969447383aa5b44820013b48541cb810d7`.

**Validation:** Source inspection and regression additions complete. Matching CI, TypeScript validation, PostgreSQL migration execution, multi-process takeover tests, Windows/SMB crash injection, and full end-to-end recovery are pending. A worker can still be interrupted during a multi-step filesystem primitive; the durable intent journal and subsequent recovery remain essential. Do not treat source-contract checks as proof of crash safety.

| Severity | Workflow / finding | Status | Commit | Remaining risk |
|---|---|---|---|---|
| High | Organization execute/resume/rollback did not fence stale workers with unique ownership | implementation and source regression committed; runtime validation pending | commits listed above | Exercise stale-worker takeover while paused before/after every filesystem mutation on Linux, Windows, and SMB; verify only the current token owner can mutate and that all journal states recover |


**Additional filesystem guard:** The follow-up review extended the ownership check to archive disposition moves into the processed folder and their attempted restoration, not just ordinary file routing. Commit `112b3b92be5fa0c86b27e793484f8f1dae405a91`. Rollback helper checks ownership again after potentially long hash operations and propagates lost-lease errors so the caller stops rather than continuing with later entries. Helper commits: `46021c6d328e1f547570a4c5e65331723b7aab4b`, `e5c794969447383aa5b44820013b48541cb810d7`.


**Filesystem regression tests added:** `organize-helpers.test.ts` now exercises a lost lease after source hashing (source remains untouched), a lost lease before failed-move restoration (destination evidence is preserved), and a lease loss after rollback checksum work (the rollback mutation is refused). Test commit: `c6fd37e97f6589f9ac750e81e7af963cf15e2fbc`. These are local filesystem unit tests; they do not simulate PostgreSQL multi-process takeover or power loss.


**Additional high-severity shutdown race fixed:** The API shutdown hook previously marked *all* `executing` organization jobs as failed. In a multi-instance deployment, shutting down one instance could therefore invalidate a different instance's live job and allow a premature resume/rollback. Shutdown now leaves organization job ownership unchanged and relies on the durable heartbeat becoming stale after the owning process exits. Added a source regression to ensure shutdown does not update organization job status. Commits: `f822e0bab98d196c4e24df8d6eb4ccb8dc532aea` and `800b2334287cf43fd2dceab46a871887fa825e08`. This preserves correct behavior across instances; recovery may wait up to the five-minute lease timeout after an ungraceful shutdown.


## Optimize start-failure and backup-timeout batch (2026-11-06)
- Confirmed Optimize entered `running` before starting the API request, but left that phase unchanged when `POST /optimize/run` returned a non-2xx response or the request/token setup threw. Since the dialog refuses to close while running, users could become trapped in a permanently busy dialog. Both failure paths now transition to `done` while retaining the actionable error message. Added coverage to `optimize-cancel-ui-finalization.test.ts`.
- Confirmed the database backup's 30-minute timeout sent SIGTERM only to the direct Node child. The backup helper already had a platform-aware process-tree terminator (Windows taskkill /T /F; POSIX TERM then KILL escalation), but the timeout did not use it. The timeout now invokes that helper so spawned backup descendants are terminated too. Added `backup-timeout-process-tree.test.ts` and wired it into Fast Validation.
- Commits: Optimize UI `475cac0ca57858abb2cfec80ca250dda9680940e`; Optimize regression `a555a7d597252042f73eb4c73def991cafc78e11`; backup timeout `d9f8391debcaf1f9e79e84901f51e714b9590dba`; backup regression `eaa916dfd56e7c95fb7ebf6ee7b6055a36d3e6a0`; workflow wiring `7ef83a671d7ab9a17eab0b1647ff80b18ad37f25`.
- Validation is pending on the current head. The new checks are source-contract regressions; process-tree timeout behavior still merits a controlled integration test with a child process that spawns a grandchild on Windows and POSIX.


## Library-job failure persistence correction (2026-11-06)
- Confirmed `failJob` swallowed every PostgreSQL update error, then removed the job from the in-memory active map and logged that the job had FAILED. If the database was unavailable, the durable row could remain `RUNNING` while the process falsely reported a terminal failure and allowed another job to start.
- The failure transition now requires exactly one updated row before removing the active entry or logging a durable FAILED state. A failed write propagates and leaves the job registered, preventing a duplicate in-process job while the database still reports it active. The user-facing force-discard/restart-recovery paths remain the explicit ways to clear an unresolved job after database connectivity is restored.
- Added `library-job-failure-persistence.test.ts` and wired it into Fast Validation.
- Commits: implementation `4285392ab9f5ac16cf7fba0f8c31988ef74fc98f`; regression `0a65572c00247235ca843e7220e7f58924067feb`; workflow `6aa52fa79dca52d78b6d73ea347d4e6dceb1d452`.
- Validation pending. This source-contract test does not replace a PostgreSQL fault-injection test that forces the terminal update to fail and verifies the active-job guard and recovery behavior end to end.


## Backup timeout process-tree hardening (2026-11-06)
- Revisited the backup timeout after the earlier fix and found that the existing helper was not truly tree-safe on POSIX: it signaled only the direct child. On Windows it returned after `taskkill` completed without waiting for the child close event. A timeout also did not record a timeout-specific failure, and stdout/stderr were accumulated without a memory bound.
- Backup children now start in a dedicated POSIX process group; timeout termination signals the whole group with TERM and escalates to KILL after two seconds. Windows termination uses `taskkill /T /F` and waits for the child close event. The timeout is reported as an explicit 30-minute failure.
- Child output and error diagnostics are bounded to the latest 8 KiB each, and spawn errors clear the timeout and active-child state.
- Updated `backup-timeout-process-tree.test.ts` to cover platform-specific process-group/tree termination, timeout reporting, bounded output, and error cleanup. The test is already wired into Fast Validation.
- Implementation commit `22f424795ef26f163d1a1cca65a30827da8b7258`; regression commit `84b34c0d70ff9fef76d8b5b520a6f87a14093cd8`.
- Validation pending. The current regression is source-contract coverage; controlled child-plus-grandchild execution tests on Windows and POSIX remain necessary to prove the operating-system behavior.


## Windows release permission isolation (latest)
- Confirmed the validation/build job inherited workflow-level `contents: write` even when a manual run selected `validate_only: true`. The release action was conditional, but the build job still had an unnecessary write-capable token.
- Changed the workflow default to `contents: read`, explicitly kept the Windows build job read-only, and moved GitHub Release creation into a separate Ubuntu publisher job with `contents: write` only.
- The build job now uploads the installer, update ZIP, source ZIP, and manifest only when publication is requested. The publisher downloads those exact artifacts and uses the version output from the validated build.
- Validation-only manual runs skip both artifact upload and the publisher. Push-to-main and manual publish runs still require the full Windows build/lifecycle checks to succeed before publication.
- Commits: workflow permission split `b19152c8be8427f00ac9dead2d1859e801f60a4d`; artifact path correction `0b3630849708350b6ff9e166efa746e4f4f0afdb`.
- This workflow is not triggered by the audit branch, so its GitHub Actions execution remains unverified here. YAML structure and artifact path behavior require CI validation before relying on the new publisher path. No release was dispatched or published.


## Windows backup termination failure fallback (latest)
- Found that the Windows timeout path awaited the taskkill.exe callback but ignored its error, then waited indefinitely for the backup child to close. If taskkill was unavailable or denied, the timeout handler could hang and leave the coordinator stuck.
- The handler now force-stops the direct child as a fallback, waits for its close event, and raises an explicit process-tree termination error so a possible surviving descendant is not silently treated as safely terminated.
- Added a regression assertion for the taskkill failure fallback and diagnostic.
- Commits: implementation 234fef2e2ac488a4498df870757e234558ea5983; regression fecd59d13c947a38244bfb55877bebc956dee0c6; matcher correction 51be838f32b86d8eaf91312250c0c21e4ccf524c.
- This is source-contract coverage only. Controlled Windows taskkill failure and descendant-process integration tests remain outstanding; the fallback cannot guarantee termination of grandchildren when Windows tree termination itself fails.

## 2026-11-06 follow-up — non-publishing Windows installer lifecycle validation

**Finding — High (Windows installation / upgrade reliability):** The repository already contained a comprehensive standard-user installer lifecycle smoke, but its only invocation was inside `.github/workflows/windows-release.yml`. That workflow requires production Authenticode and release-manifest signing material and has a separate publishing path. Running it for an audit would unnecessarily couple validation to production signing and release controls, so the clean-machine install, upgrade, interrupted-update recovery, diagnostics, and uninstall lifecycle remained blocked.

**Correction:** Added `.github/workflows/windows-installer-lifecycle-validation.yml`, a separate Windows PR/manual validation path. It builds the installer from the audited source using the existing unsigned local-build mode, stages the official pinned Node and 7-Zip payloads through existing scripts, provisions disposable portable PostgreSQL, and runs the existing standard-user lifecycle smoke. The workflow has only `contents: read`, is scoped to the audit branch for manual dispatch, and contains no production secrets, release action, artifact publication, or write permission.

**Coverage exercised by the existing lifecycle smoke:** standard-user first install and startup; upgrade to a newer compiled installer; preservation of external PostgreSQL, settings, and media; recovery from interrupted packaged update phases; database-failure diagnostics; and uninstall while services are running.

**Regression:** Extended `scripts/windows/installer-config.test.mjs` to require the isolated workflow and reject production signing secrets, write permissions, release publishing, and artifact upload.

**Validation status:** Workflow and regression are committed together. Fast Validation and the new Windows lifecycle workflow are pending; no Windows integration pass is claimed until the matching run completes. The workflow intentionally validates installer behavior without Authenticode trust or SmartScreen reputation, which remain separate release-readiness checks.

| Severity | Workflow / finding | Status | Commit | Remaining risk |
|---|---|---|---|---|
| High | Windows installer → clean standard-user install, upgrade, interrupted-update recovery, diagnostics, uninstall | fixed validation path; Windows integration pending | this batch | Matching Windows lifecycle workflow must pass; Authenticode trust, SmartScreen reputation, and crash-at-every-instruction coverage remain separate |

## 2026-11-06 follow-up — literal wildcard handling in AI search suggestions

**Finding — Medium (search correctness):** AI-search suggestions interpolated the raw user prefix into a PostgreSQL LIKE pattern. Unlike the main media-list search, which already escapes percent, underscore, and backslashes, this path treated those characters as SQL pattern syntax. A query containing wildcard characters could therefore return unrelated suggestions instead of literal matches.

**Fix:** Reused the existing escapeLikePattern helper, added a small buildSuggestionPattern boundary, and paired the escaped pattern with an explicit PostgreSQL ESCAPE clause. No dependency or schema change was needed.

**Regression:** Added a focused unit/source-contract regression covering percent, underscore, backslash, whitespace trimming, lowercase normalization, and the SQL escape clause.

**Validation status:** Implementation and regression are committed. Targeted AI-search test, workspace typecheck, and matching Fast Validation are pending; this is not yet PostgreSQL-backed route integration.

| Severity | Workflow / finding | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | AI search → suggestion prefix treats percent, underscore, and backslashes as SQL wildcards | fixed; targeted test pending | this batch | PostgreSQL-backed suggestion endpoint test and browser search workflow remain to be integration-tested |



## Organization analysis ownership fencing (latest)
- Confirmed that the analyze route read a job, then changed it to `analyzing` without a conditional claim. Two concurrent requests could both pass the initial status check, and a delayed analysis could overwrite a newer plan or failure state.
- Analysis now claims the job with a unique lease token using a compare-and-set transition scoped to the active NAS and the status read at request start. Concurrent or already-processing requests receive HTTP 409.
- Final plan persistence and failure updates are fenced by the claim token and `analyzing` status. The token is cleared on completion/failure. Rejected source/archive references also release the claim as failed instead of leaving the job stuck in `analyzing`.
- Added source-contract regression coverage for the claim, token-fenced success/failure writes, and rejected archive reference cleanup.
- Commits: route claim `5b92fa4834092b45d85bd89356af2651d15b27e8`, regression `da615b6663290e0781a0ebe00b7715b4a3d2cc92`, rejected-path cleanup `121dde95615d1257f17f55e5731e8eba2d533ca4`, and regression follow-up `a3e723b00b48c9f0099451c1038f67d84a85d993`.
- Fast Validation is pending for the latest branch head. A crash during analysis can still leave an `analyzing` row requiring recovery; automatic stale-analysis reclamation remains open and should be handled separately from concurrent-request fencing.


## Organization plan-edit concurrency fencing (latest)
- Confirmed the plan-exclusion route only rejected `executing` jobs and wrote the updated plan by job ID alone. A plan edit could race another plan edit or a worker claim, and could overwrite newer state.
- The route now rejects jobs in `executing`, `analyzing`, or `rolling_back`; atomically claims the row with a unique token only when no other lease exists; and persists the plan only while that token and the original status still match. The claim is cleared on success and best-effort cleared on errors without clearing a newer owner's token.
- Added source-contract regression coverage for busy-state rejection, exclusive claim, owner-fenced persistence, and error cleanup.
- Commits: implementation `b712ad812ddc183542165fa386d961b13ee6e210`, cleanup `5edb297f836ed3dfd8e038e4a9840426ecf59732`, type-safe claim state `9c53bddb35c9586e2df1a5003a5f827f651e2499`, regression `8484f62aee6ca005fa46e126438914b725c722f0`, and assertion correction `df35eddc11262468b55712394ccefb72c98d30fe`.
- Validation is pending. The regression is a source-contract test; a PostgreSQL-backed concurrent PATCH test is still desirable.

## 2026-11-06 follow-up — truthful backup timeout diagnostics

**Finding — Medium (backup reliability / operator diagnostics):** The Windows process-tree fallback deliberately reports when taskkill fails because force-stopping only the direct child cannot guarantee that descendants were stopped. However, the outer timeout error still said the process tree had been terminated. The API's persisted backup error could therefore overstate cleanup certainty even though the server log recorded the fallback failure.

**Fix:** Changed the persisted timeout diagnostic to say tree termination was attempted and direct operators to the server log if cleanup may remain incomplete. This does not change process signaling, retry policy, or backup contents.

**Regression:** Tightened the existing timeout process-tree source-contract test to require the honest message and reject the old success claim.

**Validation status:** Targeted backup timeout regression and Fast Validation are pending. This remains source-contract coverage; Windows taskkill failure and descendant-process behavior still need controlled OS integration tests.

| Severity | Workflow / finding | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Scheduled backup → timeout diagnostic overstated process-tree cleanup after Windows taskkill fallback | fixed; target test pending | this batch | OS-level descendant termination under forced taskkill failure remains unverified |



## Organization preflight ownership fencing (latest)
- Confirmed preflight checked only whether a job was already executing, then performed filesystem/capacity checks and finally wrote `verified` or `planned` by job ID alone. An execution worker could claim the job while preflight was running, then have its status overwritten by the late preflight result.
- Preflight now rejects executing/analyzing/rolling-back states, atomically claims the row only when its lease is empty, and writes the final status only while its token and original status still match. The token is cleared on success and best-effort released on errors.
- Added source-contract regression coverage for busy-state rejection, exclusive claim, token-fenced final persistence, and error cleanup.
- Commits: implementation `c7b2392bd87cd1d238bbf79f17a69b4eb2ee8aa8`, regression `3309b775fefb75b4f0b5a83db4d6478de4826bd7`.
- Validation pending. A PostgreSQL-backed concurrent preflight-versus-execute integration test remains desirable.


## Batch validation follow-up: lease typing and media rename hash import
- The first typecheck after the concurrency batch exposed nullable library-scope values in the new lease predicates and a missing `sha256File` import used by a concurrent media-rename integrity change.
- Analysis now keeps its claimed library path/token outside the try block, fences catch cleanup only when its claim is still owned, and uses the stable non-null path for all predicates. Plan-edit and preflight routes explicitly reject unscoped jobs and use stable path variables for their claim predicates. The media route imports the existing shared `sha256File` helper rather than duplicating hashing logic.
- Commits: analysis lease typing/cleanup `5a9823d93bd8887d201ca9eda22b31fb1b42d85c`, scoped path guards `3d08a3edea9542025a08ea282594a71757f5fbb4`, media import `5250b7729bb963de9f5e21077a6971e7920a6f5b`, stable plan/preflight scope `b947da299d44b9d9f99614ad1df2cb3367ab3d7f`, and analysis scope `d816f5d49ec60d4a0a2d95cf1fec6673510cb102`.
- A prior typecheck run reported these issues; the repaired head has not yet completed Fast Validation. The media hash check and the concurrency changes still require the next CI pass.


## Thumbnail lock ownership: aged-lock stealing removed
- Confirmed the thumbnail lock implementation unlinked any lock older than two minutes without proving that its owner had exited. Slow but valid generation could therefore overlap with a second process and race publication.
- Removed age-only lock reclamation. A worker now waits for the existing lock and fails with a timeout rather than stealing it. This deliberately prefers a recoverable stuck cache entry over concurrent writers/corrupt publication. An abandoned lock after a crashed process may need operator cleanup; automatic stale-owner recovery remains open until ownership can be verified safely across supported NAS/SMB hosts.
- Added a regression assertion that age-only lock stealing remains absent and the bounded timeout remains present.
- Commits: implementation `b0d469423cd5d010576f7a243b337045e9026868`; regression `ccaa8105b10fe7a996d0d974fbee92751151728f`.
- Validation is pending; this source-contract test does not replace a multi-process NAS/SMB lock integration test.

## 2026-11-06 follow-up — recovery drill foreign-library fixture

**Finding — Medium (CI reliability / backup recovery validation):** Fast Validation exposed a failure in the database recovery drill: it called ensureLibraryIdentity with a foreign-library path that had never been created. The production helper correctly requires an existing library root and failed at realpath with ENOENT before the test reached its foreign-library identity assertion. This was a test-fixture defect, not evidence of a recovery product failure.

**Fix:** Create the disposable foreign NAS root before asking the recovery helper to initialize its library identity. The existing test still verifies that recovery refuses a backup attached to a different library identity.

**Validation status:** The exact failing test is part of the release/storage-contract validation step. The fixture correction is committed; a matching successful run is pending.

| Severity | Workflow / finding | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Backup recovery drill → foreign-library identity fixture failed before reaching the intended assertion | fixed; target test pending | this batch | The recovery drill still needs a successful matching CI run; Windows installed-PostgreSQL path remains separately covered by the installer lifecycle workflow |



## Organization analysis lease cleanup and terminal-write handling
- Follow-up inspection found that some analysis failure branches changed the status to `failed` but retained the analysis lease token, which could block subsequent plan edits/preflight. Also, a lost final update returned an empty successful response rather than an explicit conflict.
- Failure branches now clear the owned lease token, catch cleanup runs only when the request still owns the claim, and final persistence returns HTTP 409 when ownership was lost rather than reporting success.
- Added regression assertions for lease cleanup and lost-final-write handling. Commits: implementation `d2220a71cdb3a51817f0dd7db4e3f3774973924a`; regression `ef26d581e53f2d4011a648a0dca8bc9828664bba`.
- Fast Validation is not yet confirmed on this change; latest runs are frequently cancelled by subsequent hourly commits. Crash recovery for an analysis request that dies without executing its catch remains a separate open item.

## 2026-11-06 follow-up — symlinked parent paths in verified media moves

**Severity: High — blocked for safe design**

**Finding:** The shared verified-move boundary rejects a symlink or special file only at the final source/destination component. Its no-replace move helper creates destination parents recursively, and conversion finalization uses lexical assertWithinRoot checks plus final-component lstat. Those checks do not prove that every parent directory remains inside the active library. A symlinked parent such as NAS/photos -> an external directory can therefore make a lexically in-root media path resolve to an outside file. The conversion finalizer and its startup rollback path both pass persisted paths through this boundary; organize moves also use the same verifiedMove helper. The organize scanner rejects symlinks during its initial walk, but the move and recovery paths do not revalidate the full parent chain immediately before mutation.

**Impact:** A parent symlink introduced after scan/conversion (or present in a persisted recovery journal) could redirect a hash/read, move, or rollback outside the configured library. This is a data-integrity and unintended-file-mutation risk, not merely a scan omission.

**Why no partial patch was applied:** Adding only another lstat loop before verifiedMove would reduce the static-symlink case but leave a check-to-mutation race: a parent can be replaced after validation and before link/copy/unlink/rename. The existing PostgreSQL lease checks do not fence filesystem path resolution. A superficial path check would overstate protection and could still move external user data.

**Safe implementation plan:**
1. Define one cross-platform no-follow move primitive in the existing filesystem helper boundary. It must anchor operations to already-open directory handles and reject symlink/reparse-point ancestors, not merely inspect the final file.
2. On POSIX, evaluate dirfd-relative open/stat and no-replace rename/link semantics (for Linux, openat2 with RESOLVE_BENEATH and RESOLVE_NO_SYMLINKS plus renameat2 where supported); on Windows, use handles opened with FILE_FLAG_OPEN_REPARSE_POINT and handle-based rename with no-replace semantics. NAS compatibility and unsupported filesystems must fail closed rather than silently fall back to path-based mutation.
3. Reuse that primitive for verifiedMove, rollbackMoves, conversion finalization/recovery, and organization moves so the safety boundary is not duplicated.
4. Add adversarial Linux and Windows tests for a symlink/junction at every ancestor, a parent swapped between validation and mutation, recovery from a persisted journal, and cross-volume/NAS fallback behavior. Assert that outside bytes are never read, moved, overwritten, or deleted.
5. Keep the current final-component and lexical checks as defense in depth, but do not mark the finding resolved until the handle-anchored primitive and both OS integration suites pass.

**Status:** Blocked pending the filesystem-operation design and supported-NAS compatibility decision. No source workaround was applied.

| Severity | Workflow / finding | Status | Commit | Remaining risk |
|---|---|---|---|---|
| High | Organize and Optimize conversion → verified move / rollback / startup recovery can follow a symlinked parent outside the active library | found; blocked for safe design | this documentation batch | Existing path checks are lexical plus final-component only; full parent-chain and race-safe filesystem confinement remain unresolved |

## 2026-11-06 follow-up — media viewer keyboard accessibility

**Finding — Medium (UI / accessibility):** The full-screen media viewer declared itself modal but did not contain keyboard focus or restore focus to the opening control. Its tag editor and delete confirmation overlays lacked complete dialog semantics and focus handling; the tag editor also allowed the viewer's global Escape handler to close the entire viewer. Several icon-only actions relied only on title text, the detail link nested a button inside an anchor, and ignored-folder/extension removal controls exposed only an X icon.

**Fix:** Added a reusable focus-trap/restore helper for the viewer and its nested delete/tag dialogs; suspended the parent trap and hid the parent dialog from assistive technology while a nested dialog is active; kept auto-hidden controls visible while keyboard-focused; routed Escape to the active nested dialog; added dialog labels, descriptions, accessible action names and expanded state; replaced the nested anchor/button with a single labelled link; and labelled settings removal actions.

**Regression:** Extended the UI accessibility source-contract suite for modal focus containment/restoration, nested dialog roles, Escape isolation, icon-only actions, valid navigation semantics, and settings removal labels.

**Validation status:** UI source-contract and workspace typecheck are pending. These are static accessibility contracts; browser-level keyboard/screen-reader testing remains outstanding.

| Severity | Workflow / finding | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Media viewer → modal focus escapes, nested dialog semantics and icon-only action names | fixed; target tests pending | this batch | Browser/assistive-technology integration and mobile touch/focus behavior remain unverified |



## Organization library identity fencing
- Confirmed analysis, preflight, dry-run, and execute each re-read active NAS settings after initially scoping the job to a library. A settings change between those reads could cause a job created for one library to validate or operate against another library's paths.
- Added explicit canonical path equality checks against the job's persisted `nasPath` before analysis filesystem inspection, preflight, dry-run, and execution. Mismatch now returns a conflict rather than proceeding against a different library.
- Added a route-level regression test covering all four paths. Commits: implementation `e64c95a58cedb8c9329b43adff7959dd2308ef51`; regression `90ab702fac81511a6699051d0dc21d159933ec60`.
- Validation pending; the existing recovery suite should still be run against a real configured NAS path. This guard compares normalized path strings and does not establish filesystem identity across symlink or mount aliases.

## 2026-11-06 follow-up — installer lifecycle validation must run on PR updates

**Finding — High (Windows installer validation coverage):** The isolated standard-user installer lifecycle workflow listened only for pull-request `opened` and `reopened` events. Pull request #2 was already open when this workflow was added, so later commits to the same PR could not trigger the clean-install, upgrade, interrupted-update, diagnostics, and uninstall smoke through the normal pull-request event. The existing source-contract test explicitly required `synchronize` to be absent. Although manual dispatch was available, the normal audit branch update path silently skipped this expensive but important Windows integration check.

**Fix:** Added the `synchronize` pull-request event while retaining the focused path filter for installer and packaging inputs. The workflow remains read-only, uses an unsigned local test installer, and has no production signing secrets, release publishing, artifact upload, or write permission. The workflow file itself remains in the path filter, so this correction triggers the lifecycle validation on the next PR synchronization without changing production or release configuration.

**Regression:** Updated the installer configuration contract to require `opened`, `reopened`, and `synchronize` together. Existing assertions still enforce read-only permissions and isolation from production signing and release publishing.

**Validation status:** Fast Validation run [#42154861605](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42154861605) passed the final push/PR trigger contract. The path-filtered push event started Windows lifecycle run [#42154854501](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42154854501) on the current audit head; standard-user install/upgrade/recovery/uninstall validation is still in progress. No installed-product integration pass is claimed yet.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| High | Windows installer → standard-user install, upgrade, interrupted-update recovery, diagnostics, uninstall validation skipped on later PR commits | target-tested; Windows lifecycle integration pending | eb15580d7770723bf36173e5799e228bfa5454e5 | Matching push-triggered Windows lifecycle workflow must pass; Authenticode trust, SmartScreen reputation, and crash-at-every-instruction coverage remain separate |

## 2026-11-06 follow-up — database recovery remapping must verify both roots and preserve empty JSON

**Finding — High (data recovery and catalog integrity):** The live PostgreSQL backup drill failed during restore to a reattached NAS. After `pg_restore`, catalog rows still correctly referenced the original NAS root, but `verifyRestoredLibraryInventory` queried using the new target root before the durable path-remap transaction ran. The recovery therefore reported zero rows against an authenticated backup count of one and refused a valid restore. The same ordering would also block a resume from the authenticated `RESTORED` or `REMAP_FAILED` journal state. Separately, the recursive JSONB path-remap function returned SQL NULL for empty objects and arrays because `jsonb_object_agg` and `jsonb_agg` return NULL on empty input; this silently changed durable metadata during otherwise successful remaps.

**Fix:** Inventory verification now checks the source-root catalog while reading the actual media from the attached target NAS, performs the transactional remap, then verifies the target-root catalog again. A recovery journal already marked `COMPLETE` is verified against the target root when resumed, while interrupted pre-remap states continue to use the source root. Recursive JSONB remapping now preserves empty objects as `{}` and empty arrays as `[]` at every nesting level. The durable path allowlist also now remaps face crop paths and the legacy media-scan job root, which were omitted despite being NAS-rooted database fields.

**Regression:** Extended the PostgreSQL-backed recovery drill to restore a library at a different root, resume an authenticated completed recovery, assert that nested empty JSON objects/arrays survive path remapping, and verify both face-crop and media-scan-history paths are remapped. This is the exact integration test that failed in Fast Validation; it has not yet been rerun against the complete fix.

**Validation status:** Fast Validation run [#42154861605](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42154861605) completed successfully, including the PostgreSQL-backed restore drill: restore to a reattached NAS root, source-to-target catalog remap, authenticated completed-resume, nested empty-JSON preservation, face-crop and media-scan-history path remapping, and Windows/UNC remap probes. The same run also passed Windows archive/updater smoke. This is integration-tested against PostgreSQL and a local filesystem; the separate installed-product Windows lifecycle run and real NAS/SMB remount validation remain pending.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| High | Encrypted PostgreSQL backup → restore to reattached NAS → durable path remap → resume recovery | integration-tested (Linux PostgreSQL + local filesystem); Windows pending | 0d35ff08127d0e5975e3db4fc3ea03866950b1c5; d4e5ff0851d3091d7d86e016cdeb6d3807f0b61a; a4389f374e5127cbbe5f023c640f2ec7b3e55c97 | Real NAS/SMB remount, filesystem aliases, Windows installed recovery, and crash-at-each-remap-boundary validation remain |
| High | NAS recovery path remap → JSONB durable metadata preservation | integration-tested (Linux PostgreSQL + local filesystem) | 0d35ff08127d0e5975e3db4fc3ea03866950b1c5; a4389f374e5127cbbe5f023c640f2ec7b3e55c97 | Windows/SMB recovery and broader durable JSON-column coverage remain |
| High | NAS reattachment → face crop paths and media scan history remain bound to the old root | integration-tested (Linux PostgreSQL + local filesystem); Windows pending | d4e5ff0851d3091d7d86e016cdeb6d3807f0b61a; a4389f374e5127cbbe5f023c640f2ec7b3e55c97 | Windows/SMB recovery and installed-product face-view validation remain |

## 2026-11-06 follow-up — targeted backend regression environment and source matcher

**Finding — Medium (validation pipeline reliability):** Fast Validation reached the targeted backend regression batch after the recovery and release/storage-contract checks passed. Two unrelated harness failures blocked the rest of that run: `ai-search.test.ts` imports the shared PostgreSQL pool, but the targeted-regression step did not set `DATABASE_URL` even though the PostgreSQL service was available; and the organization-analysis lease source test still expected a `const analysisLeaseToken` declaration after the route had moved to an outer `let` so the catch path could fence cleanup.

**Fix:** The targeted-regression step now receives the isolated PostgreSQL service URL used by the preceding DB tests. The organization-analysis source contract now checks the outer mutable token declaration and the subsequent `crypto.randomUUID()` assignment before the conditional claim.

**Validation status:** Fast Validation run [#42154861605](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42154861605) passed the targeted backend regression batch after these changes, including the AI-search module import and organization-analysis lease source contract. This is target-tested; it does not substitute for route-level concurrency or production database integration tests.

| Severity | Workflow / finding | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Fast Validation targeted regressions → missing DATABASE_URL for AI-search module import and stale organization lease source assertion | target-tested | eb15580d7770723bf36173e5799e228bfa5454e5 | Source-contract tests remain distinct from PostgreSQL route-level concurrency tests |

## 2026-11-06 follow-up — targeted backend regression environment and source matcher

**Finding — Medium (validation pipeline reliability):** Fast Validation reached the targeted backend regression batch after the recovery and release/storage-contract checks passed. Two unrelated harness failures blocked the rest of that run: `ai-search.test.ts` imports the shared PostgreSQL pool, but the targeted-regression step did not set `DATABASE_URL` even though the PostgreSQL service was available; and the organization-analysis lease source test still expected a `const analysisLeaseToken` declaration after the route had moved to an outer `let` so the catch path could fence cleanup.

**Fix:** The targeted-regression step now receives the isolated PostgreSQL service URL used by the preceding DB tests. The organization-analysis source contract now checks the outer mutable token declaration and the subsequent `crypto.randomUUID()` assignment before the conditional claim.

**Validation status:** Fast Validation run [#42154861605](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42154861605) passed the targeted backend regression batch after these changes, including the AI-search module import and organization-analysis lease source contract. This is target-tested; it does not substitute for route-level concurrency or production database integration tests.

| Severity | Workflow / finding | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Fast Validation targeted regressions → missing DATABASE_URL for AI-search module import and stale organization lease source assertion | target-tested | eb15580d7770723bf36173e5799e228bfa5454e5 | Source-contract tests remain distinct from PostgreSQL route-level concurrency tests |

## 2026-11-06 follow-up — library job progress stream reconnect and cursor safety

**Finding — Medium (user-facing job progress reliability):** The EventSource error handler closed the shared `source` variable and scheduled a delayed retry. If the browser fired `online` or `visibilitychange` before that timer elapsed, the reconnect handler opened another EventSource without cancelling the timer. The timer could then open a second connection, and a delayed error callback from the older connection could close the newer one. The cursor helper also accepted every cursorless snapshot, allowing an unversioned event to overwrite progress after a sequenced stream had already been established.

**Fix:** Reconnect now keeps one live EventSource, cancels a pending retry when reconnecting manually, binds event/open/error handlers to the exact source instance, and ignores callbacks from superseded sources. Cursorless snapshots are accepted only before the first valid cursor; stream IDs and non-negative safe-integer sequences are validated before advancing the cursor.

**Regression:** Added unit coverage for cursorless and malformed cursors, and included the library job recovery unit suite in Fast Validation. Added a UI source-contract regression for single-source ownership, retry cancellation, and source-instance guards.

**Validation status:** The first Fast Validation attempt was rejected before jobs started because the newly added TypeScript unit-test command was indented outside the shell block. The YAML indentation is corrected; the rerun must pass before target-tested is claimed. Browser-level offline/online and tab-visibility stress testing remains outstanding.

| Severity | Workflow / finding | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Library job progress → duplicate EventSource connections and cursorless snapshot rollback after reconnect | fixed; targeted tests pending | this batch | Browser-level network interruption, visibility race, and long-running job stress tests remain |


## 2026-11-06 follow-up — trash manifest descriptor I/O must not follow a swapped symlink

**Finding — Medium (cleanup recovery integrity / local filesystem boundary):** The trash-manifest helper checked the final path with `lstat`, then separately used path-based `openSync(filePath, "a")` and `readFileSync(filePath)`. A concurrent process with write access to the NAS log directory could replace the manifest between validation and open/read. The append and tombstone paths could then follow a final-component symlink and write outside the configured library; the read path could consume an attacker-substituted file. The existing symlink and hard-link checks did not close this time-of-check/time-of-use window.

**Fix:** Manifest access now opens one descriptor and performs the operation through that descriptor. It uses `O_NOFOLLOW` where Node/platform support is available, creates a missing manifest with exclusive `O_CREAT | O_EXCL`, and validates the opened descriptor against a fresh `lstat` (regular-file type, link count, device, and inode) before reading or writing. Appends and tombstones use descriptor writes plus `fsync`; reads use descriptor-based `readFileSync(fd)`; permission hardening uses `fchmod` on the opened descriptor rather than following the path again. Tombstone append does not recreate a manifest that disappeared after the read/check phase.

**Regression:** Added direct descriptor tests that reject final-component symlinks for both read and append, reject hard-linked manifest files before append, and assert production manifest read/write paths use validated descriptors rather than path-based file I/O.

**Validation status:** Fast Validation [#42155568974](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42155568974) and Dependency Review [#42155569007](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42155569007) passed on the preceding head `4d7c181d542d78b74cfe206bc679f10ee03eb293`; those runs include the library job-progress regression batch but predate this manifest change. The new manifest regressions are included in the Fast Validation targeted backend command and are awaiting a matching run on this batch. No full CI or Windows installed-product validation is inferred from those earlier runs.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Cleanup → trash manifest listing, recycle journal append, and removal tombstones | fixed; targeted tests pending | `8a3336f88595aa424ba6d42904fbd9cb1263bb27` (implementation); `90dbb868fd7a5ec3d6067a3c6e75e40b5d033f43` (regressions); `46e82eb09f422d9516842bf843f282c2dc335bce` (corrected source-contract matchers) | Ancestor-directory replacement remains a separate descriptor-relative traversal design issue; Windows/SMB filesystem behavior and the matching Fast Validation run remain to be verified |


## 2026-11-06 follow-up — Windows installer omitted a required PostgreSQL backup helper

**Finding — High (Windows first install / startup / backup readiness):** The isolated standard-user installer lifecycle run [#42154854501](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42154854501) failed on commit `eb15580d7770723bf36173e5799e228bfa5454e5`. Inno Setup successfully compiled and installed the application, but the first installed launcher could not import `desktop/postgres-snapshot-process.mjs` from `desktop/database-backup.mjs`. Node reported `ERR_MODULE_NOT_FOUND`; startup then reported that the required portable recovery export could not be created. Source inspection confirmed the helper existed in the repository, but `scripts/windows/build-release.mjs` copied the backup entry point and its other helpers without copying this imported module into the installer payload.

**Fix:** The Windows release staging script now copies `desktop/postgres-snapshot-process.mjs` beside `desktop/database-backup.mjs`. The release-payload regression derives the local `.mjs` imports from the backup entry point and asserts every helper is included in the staged desktop file set. The Windows lifecycle workflow's PR and audit-branch push path filters now include the helper itself, so changes to it trigger the installed-product test; its workflow contract test requires both path-filter entries.

**Regression:** Added the backup-import/payload consistency test to `scripts/windows/release-payload.test.mjs`, and a workflow contract assertion for both path filters in `scripts/windows/installer-config.test.mjs`. The first matcher draft had over-escaped regex literals; a subsequent source inspection also caught an escaped-template delimiter in the assertion message. Both are corrected in commits `57a7252406df08cd01b9a5dae890b5483247381f` and `e330a73b2baa2f64cfd4599b5209caa9bd5aebba`.

**Validation status:** The failure is confirmed from the completed Windows job log, not inferred from source alone. The implementation and regression commits are `2b7da325739accb3f74568b0f2eef0538c1c1d83`, `a718ad68c127b9c528decb88d1a4a6c94cc03f16`, `57a7252406df08cd01b9a5dae890b5483247381f`, and `e330a73b2baa2f64cfd4599b5209caa9bd5aebba`; workflow trigger coverage is `eb269c30423b1302e5212bdb64540af707c85339` and `6ede04dcf8c3ec146e84d2fbe6cc0dae6f09ceee`. A new Windows lifecycle run on the corrected head and matching Fast Validation are required before this is marked integration-tested. The failed run remains a valid record of the pre-fix defect.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| High | Windows clean install → first launcher startup → portable PostgreSQL recovery export | fixed; target validation pending | `2b7da325739accb3f74568b0f2eef0538c1c1d83` (payload); `a718ad68c127b9c528decb88d1a4a6c94cc03f16` and `57a7252406df08cd01b9a5dae890b5483247381f` (regression); `eb269c30423b1302e5212bdb64540af707c85339` and `6ede04dcf8c3ec146e84d2fbe6cc0dae6f09ceee` (trigger contract) | Corrected installed-product lifecycle must complete through startup, upgrade, recovery, diagnostics, and uninstall; this does not validate Authenticode trust or SmartScreen reputation |


## 2026-11-06 architecture finding — conversion workers are not fenced after advisory-lock connection loss

**Finding — High (conversion reliability / staged-media and job-state integrity):** Source inspection of `conversion-job-lock.ts`, `routes/optimize.ts`, and `conversion-recovery.ts` confirms that conversion ownership depends on a PostgreSQL session advisory lock. The execution and finalization routes acquire a dedicated client and release it in `finally`, but the worker does not subscribe to that client's `error`/`end` lifecycle or otherwise verify that the session lock remains alive during long-running work. PostgreSQL releases a session advisory lock when its connection is lost. Startup recovery can then acquire the lock and mark the row failed while the original process may still be executing.

**Impact path confirmed in source:** A retry reuses the deterministic staging directory `WillardAI/conversions/<jobId>`; progress and per-file counters are updated using the job ID without an attempt/lease discriminator; and finalization journal checkpoints are conditional on job ID and status, not a unique owner generation. If the old worker survives a transient database disconnect long enough for recovery/retry to begin, the old and new attempts can write to the same staging tree and both can update the same job state. Finalization has durable per-move intent callbacks, but those callbacks are not a substitute for fencing the worker that owns the operation.

**Status:** Blocked for implementation pending an architectural batch. This is not being "fixed" by adding a heartbeat alone: a heartbeat or a last-moment ownership query still leaves a race between the query and filesystem mutation, and killing one child process does not prove the entire process tree or stale worker has stopped.

**Safe implementation plan:**
1. Add a monotonically increasing attempt/lease generation (or equivalent durable owner token) to conversion jobs, with an atomic claim that returns the generation. Backfill existing rows without changing their status or result data.
2. Give every execution attempt a unique staging directory, such as `conversions/<jobId>/<attemptId>`; never let retries share a writable staging tree.
3. Include the generation in every progress, result, cancellation, retry, finalization-journal, and terminal-state update. Every update must be conditional on both the expected status and current generation; a zero-row update means the worker is stale and must stop.
4. Monitor the dedicated lock client's `error` and `end` events. On loss, mark the attempt locally fenced, abort active FFmpeg/ffprobe and all owned subprocess trees, stop scheduling files, and prohibit further writes. Treat a failed liveness query as loss, not as permission to continue.
5. Keep finalization attempt-specific and journal each move with its generation. Use no-replace publication and a recovery state machine that reconciles the filesystem against the durable intent before a new generation can publish. Do not assume a database check immediately before a filesystem call is atomic with that call.
6. Add fault-injection integration tests that sever the lock connection during scanning, active conversion, between move intent and rename, after rename but before completion checkpoint, and during finalization; prove stale attempts cannot alter the new attempt's staging files, job counters, result JSON, or published media.
7. Roll out behind a schema migration and compatibility review for existing running/awaiting-action jobs; do not automatically delete orphaned attempt directories until recovery proves they are unreferenced.

**Validation:** Source inspection only. No implementation or targeted test is claimed. The existing PostgreSQL advisory-lock test proves mutual exclusion and automatic lock release after connection destruction; it does not prove that a still-running worker stops after losing that lock.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| High | Optimize → conversion execution/retry → staged output; finalize/replace/recycle/archive | blocked | documentation and investigation only | Stale workers may continue after advisory-lock loss and race a retry/finalizer; requires generation fencing, isolated staging, subprocess cancellation, migration, and fault-injection integration tests |


## 2026-11-06 follow-up — Windows installer omitted the desktop web-server safety module

**Finding — High (Windows first install / desktop service startup):** The standard-user Windows lifecycle run [#31](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42163707879) completed installer compilation and installation but failed during first startup. The installed `desktop/desktop-web-server.mjs` imports `./web-server-safety.mjs`; the release staging script copied the entry point but omitted that helper. The installed launcher consequently exited with `ERR_MODULE_NOT_FOUND` for `desktop/web-server-safety.mjs`, and the lifecycle smoke timed out waiting for the desktop service. The portable PostgreSQL recovery export was created successfully, so this failure occurred after the backup-helper omission had been corrected.

**Fix:** The Windows release builder now stages `desktop/web-server-safety.mjs` beside `desktop/desktop-web-server.mjs`. The payload regression was broadened from the backup entry point alone to verify every direct relative `.mjs` import of both staged desktop runtime entry points (`desktop-web-server.mjs` and `database-backup.mjs`). The installer lifecycle workflow's PR and audit-branch push path filters now include the helper, and the workflow contract test requires both entries.

**Validation status:** The defect is confirmed by the completed Windows job log, not inferred from source. Fast Validation #1156 and Dependency Review #919 passed on the previous head `e576488cb32e1c361ee45dbd2ab0b99d3dbc0a14`, before this correction; they do not validate these new changes. A new Fast Validation run and a full Windows installed-product lifecycle run must complete on the correction commit before this finding is marked target-tested or integration-tested. No full CI or release-readiness claim is made.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| High | Windows clean install → desktop web service startup → local UI/API availability | fixed; targeted validation pending | this batch | The next lifecycle run must prove first startup, upgrade, recovery, diagnostics, and uninstall; Authenticode trust and SmartScreen reputation remain unverified |

## 2026-11-06 follow-up — compressed TAR previews and partial-listing false success

**Finding — Medium (Archive Library → preview `.tar.bz2` / `.tar.xz` / `.tbz2` / `.txz` and standalone compressed files):** Source inspection found that the archive preview route called `tar.list` directly on the compressed source. It enabled tar's built-in gzip handling only for `.gz` and `.tgz`; the same branch accepted bzip2 and xz suffixes but did not decompress them. The organization route already had a bounded decompression implementation for gzip, bzip2, and xz, so archive preview and organization disagreed about supported formats. The preview handler also ignored a TAR parse error when the listing had already emitted one or more entries, then persisted the partial list with `peekStatus = "peeked"`. For `.tar.bz2` and `.tar.xz`, an empty/error result could also be persisted as a successful empty preview.

**Fix:** Moved the existing bounded TAR-input implementation into `lib/archive-tar-input.ts` and reused it from both the organization and archive-preview routes. The helper keeps the existing 66 GiB decompressed-input cap, uses the already-staged official 7-Zip binary for bzip2/xz (no new runtime dependency or shell interpolation), creates unique exclusive scratch files with private permissions, and removes the temporary TAR in a `finally` block. Archive preview allocates a unique private directory under the existing NAS `WillardAI/temp` root and removes it through the existing safe `cleanTempDir` path in `finally`, rather than placing transient TAR files in the library root. Archive preview now selects compression from the full filename, including compound suffixes, and only treats a bare `.gz`, `.bz2`, or `.xz` as a standalone compressed payload when decompression succeeded, TAR parsing failed, and no entries were emitted. Named TAR wrappers, decompressor failures, safety violations, and partial listings now fail the preview instead of being stored as a successful result. The standalone response reports the actual suffix format rather than always returning `gz`.

**Regression coverage:** Added `archive-tar-input.test.ts` with suffix mapping and standalone-fallback cases; real gzip, bzip2, and xz compressed-TAR fixtures (bzip2/xz created and read with official 7-Zip); temporary-file and private scratch-directory cleanup assertions; invalid compressed-input cleanup; and a route contract asserting that partial parse results cannot be persisted. The bzip2/xz fixture tests skip only when official 7-Zip is unavailable. Fast Validation now runs this suite alongside the existing archive-safety regressions.

**Validation status:** Source changes and regression tests are committed. Fast Validation #1166 failed at API typecheck because an initial draft of the fixture test accessed Error.code; the fixture was rewritten to use the official 7-Zip binary. Fast Validation #1170 was cancelled during subsequent branch updates. The current focused suite and API typecheck have not yet completed on the current head; no target-tested, integration-tested, Windows, or full-CI claim is made for this batch. The Linux Fast Validation job is the next validation gate. The Fast Validation Windows smoke now runs the compressed-TAR suite against the packaged official 7-Zip binary. A clean installed-product archive-preview check remains outstanding.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Archive Library → preview compressed TARs; catalog persistence after malformed/partial TAR parsing | fixed; targeted validation pending | `da9d0f9d10cad8b0479cceff4278e137f057ae8c` (shared helper); `643549c7feeda349cf74efd34d5e914dc2bcacf1` (organization route reuse); `3fe8cf10d21ac2d301452b68fdccf47328abbc3f` and `7aa68809260e78748b1243f10bc01aed86de1036` (archive preview); `ce14d7e70381daf90b705af252856963f52eb105` and `31d1d056f22f45f2eb4c53eea04ab13e4ee8f986` (regressions); `c5f4ed46b7e3093acfde64231040f558e936cb51` (Fast Validation coverage); `154d0131eb0afe4a738b3c160acfeb971d721999` (official 7-Zip decompression); `6a75f9f2c03dac25945297f0fd1af949ae739136` (cross-platform fixtures); `afdd4cb485c879f6af0994a11f5f527725b4fb5f` (Linux/Windows CI wiring); `1c6980b2521b53cf9208a8cfdc902cc7400798f1` and `1b334e152871bda1a7770308887913816127cb76` (private scratch cleanup) | Clean installed-product archive-preview behavior, NAS scratch-space capacity, and route-level database persistence behavior remain to be verified by integration tests |
## 2026-11-06 follow-up — Windows launcher PID-reuse handling

**Finding — Medium (Windows installed launcher → stop after upgrade/recovery):** The Windows installed-product lifecycle run #32 successfully built the unsigned installer, completed first install/startup, and stopped the first service instance. The subsequent stop after the in-place upgrade failed with `Windows did not return enough identity information to safely manage Willard process 1736`. Source inspection showed that version-2 service records already persist each process `CreationDate`, but `Get-ProcessIdentity` required `ExecutablePath` and `CommandLine` before `Test-ProcessIdentity` compared that creation time. If Windows has recycled a recorded PID for a different process whose path/command-line fields are unavailable, the launcher could fail instead of safely recognizing that the recorded service has exited.

**Fix:** `Get-ProcessIdentity` now accepts the recorded creation time and compares it with the current process creation time before requiring path/command-line metadata. A known mismatch returns `null` (the PID now belongs to another process); a matching or unavailable creation time still requires full executable and command-line identity and fails closed when those fields are missing. `Test-ProcessIdentity` supplies the persisted creation time. This does not weaken process ownership checks or permit killing an unverified process.

**Regression coverage:** Extended `scripts/windows/installer-config.test.mjs` to assert that creation-time mismatch handling occurs before executable/command-line validation and that the tracked creation time is passed into the identity lookup. The existing Windows lifecycle smoke naturally exercises repeated stops across first install, upgrade, and recovery. A rerun of lifecycle run #32 was cancelled during subsequent branch updates; the original failure remains evidence, not a passing validation.

**Validation status:** Source fix and focused source-contract regression are committed; the latest Fast Validation and Windows lifecycle checks have not yet confirmed this fix. The prior Windows lifecycle run #32 failed at the second stop, after the first stop passed. Do not treat the installer lifecycle as fully validated until the updated branch completes the full standard-user install/upgrade/recovery/uninstall workflow.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Windows installed launcher → PID ownership and stop after upgrade/recovery | fixed; target test pending; integration validation pending | `31da37ad11c8f9414948b8622c084fe093a58407` (safe creation-time discriminator); `d83babe788ae4592da926a44b66b75a1de3e1336` and `e4542577bb81e01086bd03c2b88df56a34a81e99` (regression assertions) | If Windows cannot provide creation time or it matches but executable/command-line metadata remains unavailable, the launcher intentionally continues to fail closed. The updated full lifecycle run is required to determine whether the observed failure was PID reuse or a persistent WMI metadata issue. |
## 2026-11-06 follow-up — AI Search clear-filter suggestions

**Finding — Medium (AI Search → refine/no-results suggestions):** The UI submits the built-in no-result suggestions as refinements. Source inspection showed that mergeRefinedIntent could only add/union constraints or preserve old values with nullish coalescing/boolean OR. Consequently, suggestions such as “Remove the date filter,” “Search all media,” “Include non-favorites,” “Stop excluding screenshots,” and “Try just truck on its own” could not clear the inherited date/media/favorite/exclusion/object constraints. The UI offered actions that the merge layer could not represent; local-only mode had the same limitation.

**Fix:** Added an explicit SearchIntentClear contract and clearFilters output to the intent prompt/parser. Refinement now clears or replaces the requested fields while retaining all other prior constraints. Specific exclusions can be removed without discarding unrelated exclusions. The exact built-in suggestion phrases are also applied deterministically after AI parsing, so a model response cannot accidentally re-add the filter being removed. The local-only parser recognizes the same phrases without sending the suggestion text back as search keywords; “try just X on its own” replaces the prior semantic query, keywords, and object list with X. The route uses this deterministic path when external AI processing is disabled or unavailable.

**Regression coverage:** Added merge tests for clearing date range, media type, favorite-only, location, object, keyword, and individual exclusion constraints; local-only parser tests for each built-in suggestion; and route/prompt source contracts confirming both AI and local-only flows apply clear-filter semantics.

**Validation status:** Implementation and focused tests are committed. The current Fast Validation run has not yet completed for this head; no target-tested or integration-tested claim is made. The model-generated clearFilters response remains probabilistic for arbitrary phrasing, while the built-in no-result suggestions are deterministic in both AI and local-only modes.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | AI Search → no-result suggestions and local-only refinements | fixed; targeted validation pending | 8dea50868fb92c0d4fed2e06028247e65c466044 (clear contract/parser); cd97c6c23a1067c0a02945528df10bbd1e69feb2 (local-only route); 3e7e66debc16bb760c3a6a096a7d4fd6e06555bb and c62d98f0570c5d9f129b50801dd9cee6e4bdbaaa (regressions); e3e26d5bcc254a27fa59496ec3e55b8665327a32 and dea3682a0dd045dd742c4347e0eb00c806de6a85 (deterministic AI-mode clear actions); 61cc3a44f9010f395686010aed66ed1256647108 and b609340ee493ac7997ee0babcea5b00112eed1a2 (explicit type contracts) | Arbitrary natural-language removal requests depend on the model setting the correct clear flag; exact built-in suggestions are handled locally. |
## 2026-11-06 validation follow-up — Fast Validation #1188

Fast Validation #1188 ran against head `d0873319afc617c7a5d64e140598b231e251f820`. The following steps completed successfully: TypeScript/generated-contract validation; Expo configuration; desktop web-server safety; release/storage contracts; official Windows 7-Zip download retry policy; official static 7-Zip 26.05 verification; node-7z compatibility; PostgreSQL media LIKE filters; conversion advisory-lock integration; and conversion finalization restart recovery.

The targeted backend regression command failed on two stale source-contract assertions, not on an observed runtime regression: `ai-search.test.ts` expected the pre-annotation `localClear` declaration, and `archive-safety.test.ts` still expected the old gzip-only preview branch. Updated assertions are committed in `96bd13588c69e8fec7fad7fdd7cb78d013f4e2b2` and `4d53d84e9c3bd147ca800e574832bca6e41ed090`. The current branch contains those test corrections, but no new run has yet confirmed them. Fast Validation #1188 therefore remains failed overall; its successful earlier steps do not make the targeted suite or current head fully validated.
## 2026-11-06 follow-up — Windows lifecycle CI trigger coverage

**Finding — Medium (Windows installer validation → PR update coverage):** The lifecycle workflow listened for pull-request `opened` and `reopened` events, but not `synchronize`. The audit PR was already open, so later installer/launcher commits could update the branch without scheduling the full Windows lifecycle. The push trigger remains useful for direct branch pushes, but GitHub App/API-based branch updates are not a dependable substitute for the PR synchronization event.

**Fix:** Added `synchronize` to the pull-request activity types and added `scripts/windows/installer-config.test.mjs` to both PR and audit-branch push path filters. This ensures installer process-identity and release-contract changes are eligible to trigger the standard-user install/upgrade/recovery/uninstall lifecycle after PR updates.

**Validation status:** Workflow configuration change is committed in `7f27403fdcc859929580438764fa931bf63267d4` and `ef792b956f4d9caa2618ee47ca8616394abf748e`. The current Windows lifecycle has not been observed running on the updated head; the existing run #32 failure remains unresolved until a fresh run completes. Fast Validation #1191 is running on the prior test-corrected head `7d22f204b718e7eb01c342b4171603b9a886a7cb`; it does not include the later workflow-trigger commits. No full Windows or full-CI validation claim is made.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Windows installer lifecycle → PR synchronization and installer contract test changes | fixed; workflow validation pending | `7f27403fdcc859929580438764fa931bf63267d4` and `ef792b956f4d9caa2618ee47ca8616394abf748e` | The updated trigger must still be observed scheduling a current-head Windows lifecycle run; run #32's post-upgrade stop failure is not yet cleared. |

## 2026-11-06 follow-up — malformed compressed archive caused an unhandled decompressor-exit rejection

**Finding — High (Archive Library → preview malformed `.bz2`/`.xz` input → API process availability):** Fast Validation #1195 ran against `e22350d536b2ee8c86dc4ae0b6a4623b78e896b6`. TypeScript/generated-contract validation, desktop safety, release/storage contracts, official 7-Zip verification, PostgreSQL filter checks, and conversion-lock/finalization integration steps passed. The targeted backend regression command reported 325 passed, 1 failed, and 2 skipped. The only failing test was the existing invalid-compressed-input regression in `archive-tar-input.test.ts`.

Source inspection and the failing test identified a timing defect in `withTarInput`: the function created a promise for the 7-Zip child process exit, but did not attach a rejection handler until after the stdout pipeline completed. For malformed xz input, 7-Zip can exit with an error before the pipeline reaches `await exit`. The rejection was therefore temporarily unhandled. In Node's default unhandled-rejection mode, that can be escalated to an uncaught exception and terminate the API process while a malformed archive is being previewed. This is an availability risk, not merely a test-harness issue.

**Fix:** Immediately attach a rejection observer to the child-exit promise when it is created. The original promise is still awaited after the stdout pipeline, so the decompressor error continues to propagate through the existing catch/finally path and the partial scratch TAR is removed. The observer prevents the early rejection from being unhandled; it does not swallow the error returned to the caller.

**Regression coverage:** Extended the corrupted `.tar.xz` fixture test to capture `unhandledRejection`, wait one event-loop turn after the expected rejection, assert that no unhandled rejection occurred, and verify the scratch directory remains empty. This directly exercises the timing window seen in Fast Validation #1195.

**Commits:** helper fix `8fb0ea7b277e354fb64c056e7e4407c90c5bfa0f`; regression `2d7ab28756a343674acb41f49044d9b621c61da1`.

**Validation status:** The fix and regression are committed. Fast Validation #1195 is a failed run on the pre-fix head and does not validate these commits. A new Fast Validation run must pass the API typecheck and targeted backend regression command. Windows archive smoke must also run on the updated head. Dependency Review #958 passed on the pre-fix head; it is not evidence for the new commits. Windows installer lifecycle #40 was still compiling the unsigned installer at the last observation; its installed-product install/upgrade/recovery/uninstall steps had not started. No full-CI or release-readiness claim is made.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| High | Archive preview of malformed bzip2/xz input; API process availability | fixed; target validation pending | `8fb0ea7b277e354fb64c056e7e4407c90c5bfa0f` (helper); `2d7ab28756a343674acb41f49044d9b621c61da1` (regression) | New Linux targeted validation and Windows archive smoke are required. Other decompressor cancellation, scratch-capacity, and installed-product preview behavior remain separate risks. |


## 2026-11-06 follow-up — archive classification parity and Windows installed-stop failure

### Archive preview classification parity

**Finding — Medium (Archive Library → preview contents and category summaries):** Source inspection confirmed that `routes/archives.ts` maintained a second, incomplete media-extension list instead of using the canonical media scanner classification. Files already supported by the library scanner were displayed as `other` in archive previews: AVIF/CR3/PSD images; 3GP/TS/MTS/M2TS/MXF/VOB video; audio formats including MP3/FLAC/OPUS/AIFF; and documents including CSV/Markdown/ODS/ODP/Pages/Numbers/Keynote. The archive preview list also omitted supported archive/container extensions such as `.tgz`, `.tbz2`, `.txz`, `.cab`, and `.iso`. The category aggregator had no audio bucket, so audio-heavy archives could not be categorized correctly.

**Fix:** Extracted the canonical media extension sets and `classifyMediaType` into the pure `lib/media-classification.ts` module. The media scanner imports and re-exports that function to preserve existing imports. Archive previews now use `lib/archive-classification.ts`, which maps canonical photo/video/audio/document types into archive entry types, recognizes the archive/container extensions already supported by the preview routes, retains software classification, and adds an Audio Archive category. No dependency was added and no second copy of the media extension lists remains.

**Regression coverage:** Added `archive-classification.test.ts` for AVIF/CR3/PSD, camera/video formats, audio formats, document formats, compound TAR wrappers, CAB/ISO, software files, audio category counts, directory exclusion, password/empty states, both path separator styles, and dot-prefixed extension normalization. Added the suite to the Fast Validation targeted backend command.

**Commits:** `465a85dcb0d1703c244ef013584f42365819269b` (canonical media classifier); `fc27c2971ce4f6baf04f6d3aaacc93caded1d0e0` (archive classifier); `7ca0a68488a5e18a0dbd280696489bd02b3f05df` (scanner reuse); `e565f72f9f69ae26c6fd62694cf9d570d821a26d` (archive route reuse); `ecc92c0d4097545d82913dfdacd7fbdb49939190` (regression suite); `d20e41c749a015eb713739592f69ee3a504bf190` (Fast Validation wiring); `66932a0896c96dcdf36d02fd67b05bdd585c51b9` and `a4ff4f22f332eba717fadb0817750eb15d3e5bc2` (leading-dot normalization and regression).

**Validation status:** Source changes and focused regression tests are committed. Fast Validation #1202 and Windows installer lifecycle #47 were queued on the updated branch at the time this entry was written; neither result is claimed here. The preceding Fast Validation #1198 passed its Linux validation and Windows archive/updater smoke jobs, but it predates this classification batch and does not validate it.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Archive Library → preview entry type and category | fixed; target validation pending | classifier/route/test/workflow commits listed above | A clean installed-product archive preview and full Windows lifecycle remain outstanding. |

### Windows installed-product lifecycle — stop after upgrade

**Finding — High (Windows installer → stop after in-place upgrade):** Windows lifecycle run #40 successfully built the unsigned installer, completed standard-user installation and startup, and completed two stop operations. The third stop, after the in-place upgrade, did not finish within the lifecycle harness's 180-second timeout. Its captured output reported: `Windows did not return enough identity information to safely manage Willard process 8416.` The current PID-reuse guard had already compared the persisted creation time; the same process identity could not be confirmed because Windows did not return the executable path and command line. The install/upgrade itself completed; the full lifecycle failed at stop and did not reach the remaining recovery/diagnostics/uninstall assertions.

**Safety decision:** Do not weaken process ownership checks or force-kill an unverified PID. The existing fail-closed behavior is retained. A safe follow-up should add bounded WMI/CIM retry and an independent process-handle identity check, then prove that the tracked process is the exact installed API/web child before allowing termination. If identity remains incomplete, stop should return a bounded actionable error rather than hang. The updated lifecycle run #47 is queued; no pass is claimed.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| High | Windows installed launcher → stop after upgrade | found; blocked pending safe process-identity design | current launcher identity implementation remains unchanged in this batch | A standard-user upgrade/stop/recovery/uninstall run must pass. Never terminate a PID using only a reused PID value. |

### Conversion responsiveness and worker ownership — source inspection

**Finding — High (Optimize Center → video/RAW conversion, cancellation, and API responsiveness):** The current `routes/optimize.ts` still calls `spawnSync` for FFmpeg video encoding (up to a one-hour timeout), RAW image decoding, and the generic image fallback. The conversion execute route is async, but these synchronous child-process calls block the Node event loop. The cancel endpoint only writes `cancelledAt`; the worker checks that flag between files, so an active FFmpeg process cannot be interrupted and unrelated API requests can be delayed for the duration of an encode. The route acquires a session-scoped PostgreSQL advisory lock, but does not attach a process-termination strategy to the lock connection's error/end lifecycle. The lock helper explicitly documents that losing the connection releases ownership; that event does not itself stop the running FFmpeg child.

**Status:** Found by source inspection; no partial workaround applied. This requires a coherent asynchronous worker batch: spawn/stream FFmpeg asynchronously, track each child per job, cancel the child and owned subprocess tree, detect lost lock connections, prevent stale workers from publishing results, and use attempt-specific staging plus conditional finalization. Add fault-injection tests for cancellation, process exit, database connection loss, retry overlap, and Windows process-tree termination before claiming the conversion workflow reliable.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| High | Optimize Center → active conversion and cancel | found; architecture required | no code change in this batch | Current synchronous FFmpeg calls still block the event loop; advisory-lock loss can leave a stale child running. |


**Archive category UI follow-through:** The new `Audio Archive` category is now available in the Archive Library category filter. Added a UI contract regression in `scripts/ui-accessibility.test.mjs` so computed categories cannot silently become unfilterable. Commits: `b009f43cf026ac793ad489eb017cc5965a43545c` (filter option) and `598cf64b6480682f3b1e6e3a0cb67b527e2d7deb` (UI regression). The Fast Validation run #1202 predates these two commits; the next PR-triggered run must include the UI contract test. Validation remains pending.
## Conversion cancellation compare-and-set guard — November 6

- **Finding — Medium (Optimize Center → cancel a running conversion):** The cancel route first loaded a job scoped to the active library and verified status === running, but its subsequent UPDATE filtered only by job ID. If the job changed state between the read and UPDATE, the route could still write cancelledAt to a completed/failed job and return cancellationRequested: true. The update also did not repeat the library scope predicate used by the read.
- **Fix:** The cancellation UPDATE now uses a single conditional predicate over job ID, the exact nasPath from the scoped read, and status = running. If the row no longer matches, the endpoint returns HTTP 409 with a refresh/retry message rather than reporting a cancellation request that was not applied.
- **Regression:** Added a source-contract test to optimize-job-claim.test.ts asserting all three predicates, the 409 stale-state path, and the absence of the previous ID-only update. This suite is included in Fast Validation's targeted backend regression command.
- **Implementation/test commits:** f3ba596fbcaec37ee72f8d72a0796d11034c6c21 (conditional update) and 93699683f748640580a09a4340bf6bda6292012b (corrected regression test).
- **Validation:** Pending for the final test commit. Fast Validation #1205 passed on the preceding head 535a5f6b083eba3090d18088d67782f1202bb530, including typecheck/generated contracts, targeted backend regressions, PostgreSQL advisory-lock and finalization-recovery integration, and the Windows archive/updater smoke job. That result does not cover this cancellation guard. Dependency Review #968 passed on that same preceding head. Windows installer lifecycle #50 failed after installer build/install/upgrade when the post-upgrade stop command could not obtain sufficient process identity metadata for PID 5576; the harness timed out after 180 seconds. The Windows archive/updater smoke job passed, but the installed-product lifecycle remains blocked.
- **Remaining risk:** This compare-and-set guard prevents stale-state false success; it does not make FFmpeg cancellation immediate. The active conversion still uses synchronous FFmpeg execution and cancellation is observed between files. The asynchronous process-ownership/fencing design remains a separate high-priority architectural finding.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Optimize Center → cancel a conversion | fixed; targeted-test pending | f3ba596fbcaec37ee72f8d72a0796d11034c6c21, 93699683f748640580a09a4340bf6bda6292012b | Fast Validation must execute the regression on the final branch head. Active FFmpeg cancellation remains a separate high-priority issue. |
## Windows installer lifecycle noninteractive failure handling — November 6

- **Finding — Medium (Windows installer lifecycle validation → stop failure reporting):** The generated child runner in installer-lifecycle-smoke.ps1 set update/recovery variables but did not set WILLARD_NO_PAUSE. When the installed launcher correctly failed closed on incomplete WMI process identity, its error handler reached Pause-BeforeClose and waited on Read-Host. The lifecycle harness waits for the child process for up to 180 seconds, so a known identity failure was reported as a timeout and obscured the actionable cause. This was confirmed by the #50 captured output and the runner/common.ps1 source.
- **Fix:** The generated lifecycle child runner now sets WILLARD_NO_PAUSE=1 before invoking start/stop/failure modes. The automated test installer-config.test.mjs now asserts that the generated runner disables interactive pauses. This affects only the isolated test process; normal interactive launcher behavior is unchanged.
- **Commit:** f49c19decb3f306609df8f2b6da96161c54a83b1.
- **Validation:** Source inspection confirms the generated runner includes the flag and the regression assertion is present. The test is part of the Windows lifecycle workflow's installer-config test step. The next lifecycle run on the final head must execute it. Run #50 failed at the post-upgrade stop: WMI returned incomplete identity metadata for PID 5576, and the harness timed out after 180 seconds. Fast Validation #1205 and Windows archive/updater smoke passed on the preceding head 535a5f6b083eba3090d18088d67782f1202bb530; they do not validate this runner change. The new lifecycle run for this change is pending.
- **Remaining risk:** This fixes the misleading timeout caused by interactive pause behavior; it does not resolve the underlying Windows process-identity failure. The launcher must continue refusing to terminate an unverified PID. A clean standard-user install → upgrade → stop → recovery → diagnostics → uninstall run must pass before the installer area is fully validated.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Windows installer lifecycle → noninteractive stop error handling | fixed; source-inspected, targeted workflow test pending | f49c19decb3f306609df8f2b6da96161c54a83b1 | The underlying WMI identity failure still blocks the installed-product lifecycle; no PID ownership checks were weakened. |

## Windows installer interrupted-update recovery fixture correction — November 6

- **Finding — Medium (Windows installer lifecycle validation → interrupted packaged-update recovery):** Windows installer lifecycle run #56 successfully built the unsigned installer, completed standard-user first install and startup, completed the in-place upgrade, and completed the stop operations reached before recovery. It then failed at the interrupted-update recovery scenario with: `The update recovery journal paths do not match this installation's expected sibling candidate and backup directories.`
- **Root cause confirmed by source and captured run logs:** `desktop/WillardMediaCenter.ps1` intentionally validates that recovery candidates are named `.<installLeaf>.candidate-<GUID>` and backups are named `.<installLeaf>.previous-<label>-<14-digit timestamp>`, with both paths as siblings of the installation. The lifecycle fixture instead created `$InstallRoot.lifecycle-backup`, `$InstallRoot.lifecycle-candidate`, `$InstallRoot.prepared-backup`, and `$InstallRoot.prepared-candidate`. The production recovery guard correctly rejected those nonconforming paths without changing the installation. This was a test-fixture defect; the run had not actually exercised successful recovery.
- **Correction:** Updated both simulated crash phases to create sibling paths using the exact accepted candidate and backup naming contract. The production path-validation guard is unchanged. Added a regression to `installer-config.test.mjs` that checks the accepted naming patterns and rejects the old invalid fixture suffixes.
- **Implementation and regression commit:** `29ca94c42c89b90776f546878a04d6adcf263e93`.
- **Validation:** Fast Validation #1210 passed on the prior source head `c6844f585cfdb16189b5edc4d3501f4e02ddf0ed`: the Linux validation job completed typecheck/generated contracts, desktop safety, release/storage contracts, official 7-Zip 26.05 hash and `node-7z` checks, PostgreSQL conversion-lock/finalization integration, and targeted backend regressions; the Windows archive/updater smoke job also passed. Dependency Review #973 passed on that same head. Those results do not validate this new lifecycle fixture commit. A new Fast Validation and Windows installer lifecycle run must execute the new regression and both recovery scenarios.
- **Process identity follow-up:** The incomplete-WMI stop failure observed in earlier lifecycle attempts did not recur in run #56; the captured lifecycle log shows the reached stop commands returning `[OK] Willard Media Center services stopped.` This is a non-reproduction in this run, not a general Windows process-identity validation.
- **Remaining risk:** The next complete lifecycle run must prove that the corrected `swapped` and `prepared` journal scenarios restore the prior install, preserve the external PostgreSQL/media state, clear only the valid journal, and continue through diagnostics and uninstall. The product recovery code remains fail-closed.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Windows installer → interrupted-update recovery lifecycle fixture | fixed; targeted validation pending | `29ca94c42c89b90776f546878a04d6adcf263e93` | The prior run failed before exercising the valid recovery path. Full Windows install → upgrade → both recovery phases → diagnostics → uninstall must pass on the corrected head. |

## AI Search no-result suggestions must refine the active intent — November 6

- **Finding — Medium (Search → no-result suggestions → inherited filters):** Source inspection found that each no-result suggestion button called `submit(s, true)`. The second argument forces a new search, so `SearchPage` omitted `previousIntent`. However, both the AI parser and local-only fallback deliberately apply the deterministic built-in clear-filter actions only when a previous intent is supplied. Consequently suggestions such as “Remove the date filter,” “Search all media,” and “Include non-favorites” were being parsed as new search phrases instead of removing the corresponding inherited constraint; in local-only mode the suggestion sentence could become literal keywords.
- **Fix:** No-result suggestions now call `submit(s)`, which follows the existing refinement path and supplies the current response intent. Starter prompts still explicitly start a new search. No parser or search-query behavior was duplicated.
- **Regression:** Added a UI contract test asserting no-result suggestions use the refinement call and that the submit handler passes the active intent when refining.
- **Implementation and test commit:** `c5958eed90da42ab487debb1d90a949490832147`.
- **Validation:** Pending on the new branch head. The previous Fast Validation #1210 passed on `c6844f585cfdb16189b5edc4d3501f4e02ddf0ed`, including typecheck/generated contracts and the targeted backend regression suite, but predates this UI correction. The corrected suggestion test must pass in Fast Validation before the finding is marked target-tested.
- **Remaining risk:** The deterministic built-in suggestion strings are covered by the existing `localSearchClearFilters` and `mergeRefinedIntent` tests; AI-provider interpretation of arbitrary user-written refinements remains probabilistic by design.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Search → no-result suggestion → clear inherited filters | fixed; targeted validation pending | `c5958eed90da42ab487debb1d90a949490832147` | Fast Validation must execute the new UI regression on the latest branch head. |

## Search refinement filter overrides — November 6

- **Finding — Medium (Search → refine → remove a conventional media/favorites filter):** The search page only sent `mediaTypes` when the selected type was not “all” and only sent `favoriteOnly` when true. On a refinement, returning the controls to “all” or toggling favorites off omitted the corresponding field. The API therefore retained the previous intent's media-type or favorites constraint. This made a visible filter reset appear successful while results remained constrained.
- **Fix:** The UI now distinguishes untouched controls from explicit user choices. Untouched controls do not override natural-language intent; selecting “all” sends an explicit empty media-type list, and turning favorites off sends explicit `false`. The API now applies empty arrays and both boolean values as intentional overrides. Starting a new search clears the overrides; opening a saved search synchronizes the controls to its saved intent. Built-in “Search all media” and “Include non-favorites” suggestions also clear the matching UI override before refining.
- **Regression coverage:** Added route contract assertions for empty media-type and false favorites overrides, plus UI contract coverage for explicit clear state, reset behavior, saved-search synchronization, and suggestion handling.
- **Implementation/test commit:** `b0b75d489dab5e99b623616156601938948bc2fa`.
- **Validation:** Pending on the new branch head. The preceding Fast Validation #1216 is associated with the earlier no-result suggestion change and does not cover this filter-override batch. The new API/UI regressions must pass in the next Fast Validation run.
- **Remaining risk:** The UI currently exposes one media-type selection at a time. Multi-type intent from natural language or saved searches remains preserved in the search response; the single-select control displays “all” when more than one type is active rather than silently narrowing it.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Search → refine → clear media type or favorites filter | fixed; targeted validation pending | `b0b75d489dab5e99b623616156601938948bc2fa` | Fast Validation must execute the route and UI regressions on the current head. |


## Password-protected archive preview snapshot integrity — November 6

- **Finding — Medium (Archive Library → preview encrypted ZIP/7-Zip files):** Source inspection confirmed that the normal ZIP and 7-Zip listing completion paths call `assertArchiveFileUnchanged`, but their password/encryption error paths accepted and persisted a password-protected classification without the same snapshot check. A file replaced or modified while the library was inspecting it could therefore be recorded as password-protected based on a different file than the one initially snapshotted.
- **Fix:** The ZIP password-error branch now revalidates the captured archive snapshot before setting `isPasswordProtected`. The 7-Zip error branch performs the same check and rejects if the snapshot changed before resolving the preview. The existing fail-closed snapshot helper and archive size/path checks are reused; no new dependency or alternate integrity mechanism was added.
- **Regression:** Extended `archive-safety.test.ts` (already included in Fast Validation's targeted backend regression command) with source-contract assertions that both ZIP and 7-Zip password-error paths perform snapshot verification before accepting the protected result. The existing helper regression for source replacement continues to cover the snapshot helper's runtime behavior.
- **Commits:** implementation `a85dc983574acd95127d0062296a9f03b45e4551`; regression `68a183ff4af333671982bb4c9212a8d3adf78250`.
- **Validation:** Source inspection confirms the two previously missing checks are now present. The new regression has been added to an existing Fast Validation test file, but no targeted test, integration test, Windows test, or full CI result is yet confirmed for this commit. The PR-triggered Fast Validation run must execute the updated `archive-safety.test.ts` before this finding can be marked target-tested.
- **Remaining risk:** The check detects changes observable through size, mtime, ctime, device, and inode snapshots. It does not lock a file against all concurrent writers; a stronger open-descriptor-based archive lifecycle would be a separate design. Windows and SMB timestamp/identity semantics still require platform integration coverage.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Archive Library → password-protected ZIP/7-Zip preview | fixed; target-test pending | `a85dc983574acd95127d0062296a9f03b45e4551`, `68a183ff4af333671982bb4c9212a8d3adf78250` | Fast Validation must run the regression on the final audit head; snapshot metadata is not a cross-platform file lock. |


## November 6 follow-up — archive password-preview integrity and installer lifecycle fixture cleanup

### Password-protected archive preview snapshot verification
- **Finding — Medium (Archive Library → preview encrypted ZIP/7-Zip files):** The normal ZIP and 7-Zip listing completion paths verified the captured archive snapshot, but password/encryption error paths accepted and persisted a password-protected classification without that check. A file replaced or modified during inspection could therefore be classified from a different file than the one initially snapshotted.
- **Fix:** The ZIP password-error branch now revalidates the captured archive snapshot before setting `isPasswordProtected`. The 7-Zip error branch performs the same check and rejects if the snapshot changed before resolving the preview. The existing fail-closed snapshot helper is reused.
- **Regression:** Extended `archive-safety.test.ts` (already included in Fast Validation's targeted backend command) with assertions that both password-error branches verify the snapshot before accepting the protected result. The existing runtime helper test continues to verify that a changed source file is rejected.
- **Commits:** implementation `a85dc983574acd95127d0062296a9f03b45e4551`; regression `68a183ff4af333671982bb4c9212a8d3adf78250`.
- **Validation:** Source inspection confirms both checks. The regression has been added but has not yet been confirmed by a successful run on the final branch head. Fast Validation #1224 failed in a separate Windows installer contract assertion before reaching the targeted backend regression step; the newer run must execute `archive-safety.test.ts`.
- **Remaining risk:** Snapshot metadata detects observable replacement/change using size, mtime, ctime, device, and inode; it is not a cross-platform file lock. Windows and SMB/NAS semantics still need integration coverage.

### Windows interrupted-update lifecycle cleanup contract
- **Finding — Medium (Windows installer lifecycle → recovery fixture validation):** Fast Validation #1224 failed in `scripts/windows/installer-config.test.mjs`. The test correctly asserted that interrupted-update fixtures use the accepted sibling candidate/backup naming scheme, but the lifecycle script's `finally` block still contained two obsolete cleanup expressions for the old `$InstallRoot.lifecycle-backup` and `$InstallRoot.lifecycle-candidate` paths. Those paths were no longer created by either recovery scenario, and their stale presence contradicted the updated fixture contract.
- **Fix:** Removed the two obsolete cleanup expressions. The lifecycle script still removes its disposable install root; successful recovery asserts the candidate/journal cleanup, while failed runs preserve the unique temporary workspace for diagnostics. No production launcher/recovery behavior or process-identity guard was changed.
- **Commit:** `3b063902d289a1d08bc7289221e79ee6900f604a`.
- **Validation:** The failure is confirmed by the #1224 job log and source assertion. The source correction is committed; the existing installer-config regression and Windows lifecycle must run on the latest head before this is marked target-tested or integration-tested.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Archive Library → password-protected ZIP/7-Zip preview | fixed; target-test pending | `a85dc983574acd95127d0062296a9f03b45e4551`, `68a183ff4af333671982bb4c9212a8d3adf78250` | Confirm regression on latest Fast Validation; metadata snapshot is not a file lock. |
| Medium | Windows installer → interrupted-update lifecycle fixture cleanup | fixed; target-test pending | `3b063902d289a1d08bc7289221e79ee6900f604a` | Confirm installer-config test and complete installed-product recovery lifecycle on latest head. |


## UI contract test parser correction — November 6

- **Finding — Medium (Fast Validation → UI accessibility/search filter contracts):** Fast Validation #1229 completed TypeScript/generated-contract checks, Expo CLI configuration, and desktop web-server safety, then failed in `test:ui-contracts` (22 passed, 1 failed). The failing test was `search filter controls can explicitly clear inherited media and favorite constraints`. Its test helper used the first literal `>` after a JSX opening tag; for `onClick={() => { ... }}`, that character is the arrow token inside a JSX expression, not the end of the opening tag. The helper therefore truncated the button before `setFavoriteOnlyOverride(next)` and produced a false regression failure. Source inspection of `search.tsx` confirmed the intended setter is present in the click handler.
- **Fix:** Replaced the first-`>` search with a small brace- and quote-aware JSX opening-tag scanner, and reused it for the favorites-filter button assertion. The scanner ignores arrow tokens and comparison characters inside JSX expression braces, and handles quoted/escaped strings before identifying the actual tag terminator. No application UI code was changed.
- **Commits:** `e641dd6cfbd3509065ca07f0803c49b3832b9a2a` (parser and regression extraction); `fedbcbd0ec3cfa225c1fd7bd29c615eb6eec8db8` (single-backslash escape handling).
- **Validation:** Fast Validation #1229 is a confirmed failure on head `28fbb4b853e20951ebbff7585d6560796598fa86`; its log identifies the exact assertion above. The updated parser has been source-inspected, but no successful UI contract run is yet confirmed on the corrected head. The next Fast Validation run must pass the entire UI contract suite and then reach the targeted backend regression step.
- **Remaining risk:** This improves the static JSX contract test helper, not a full browser accessibility audit. Keyboard/screen-reader behavior still needs real browser testing at a later milestone.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Fast Validation → Search filter UI contract | fixed; target-test pending | `e641dd6cfbd3509065ca07f0803c49b3832b9a2a`, `fedbcbd0ec3cfa225c1fd7bd29c615eb6eec8db8` | Confirm the full UI contract suite on the corrected head; static contract checks do not replace browser accessibility testing. |


## November 6 validation milestone — archive, installer-fixture, and UI contract corrections

- **Fast Validation #1232 passed** on audit head `99874ac039961eebc6d42844c356f9273754ea16`. The Linux job completed typecheck/generated contracts, Expo configuration, desktop web-server safety, release/storage contracts, official 7-Zip 26.05 download/hash verification, Linux node-7z compatibility, PostgreSQL media LIKE behavior, cross-connection advisory locks, PostgreSQL conversion-finalization recovery, and the targeted backend regression suite.
- The paired **Windows archive/updater smoke job also passed** in #1232. It covered PowerShell launcher parsing, concurrent startup protection, developer-launcher orphan handling, UTF-8 launcher environment files, Windows media rename and storage-migration no-overwrite behavior, NAS temp/cleanup safety, conversion finalization rollback, official Windows 7-Zip symlink metadata, compressed TAR preview, updater journal writes, and developer updater preservation/rollback.
- **Dependency Review #995 passed** on the same head.
- The three corrections represented by commits `a85dc983574acd95127d0062296a9f03b45e4551`, `68a183ff4af333671982bb4c9212a8d3adf78250`, `3b063902d289a1d08bc7289221e79ee6900f604a`, `e641dd6cfbd3509065ca07f0803c49b3832b9a2a`, and `fedbcbd0ec3cfa225c1fd7bd29c615eb6eec8db8` are now **target-tested** by the successful Fast Validation run. This is not full CI and does not constitute the Windows installed-product lifecycle.
- **Windows installer lifecycle #83 remains in progress** on the same head. Installer compilation completed successfully; standard-user install, first startup, upgrade, interrupted-update recovery, diagnostics, and uninstall have not yet been confirmed. Do not mark the installer fully validated until that workflow completes successfully.
- Current branch head at this milestone: `99874ac039961eebc6d42844c356f9273754ea16`. No main-branch, production-data, credential, or release changes.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Archive Library → password-protected ZIP/7-Zip preview snapshot integrity | target-tested | `a85dc983574acd95127d0062296a9f03b45e4551`, `68a183ff4af333671982bb4c9212a8d3adf78250` | Snapshot metadata is not a file lock; Windows/SMB source-change semantics remain untested. |
| Medium | Windows installer → interrupted-update lifecycle fixture cleanup | target-tested | `3b063902d289a1d08bc7289221e79ee6900f604a` | Installer lifecycle #83 still needs to finish its installed-product recovery sequence. |
| Medium | Fast Validation → Search filter UI contract parser | target-tested | `e641dd6cfbd3509065ca07f0803c49b3832b9a2a`, `fedbcbd0ec3cfa225c1fd7bd29c615eb6eec8db8` | Static UI contracts do not replace browser keyboard/screen-reader testing. |



## Thumbnail cache clearing preserves in-flight work (2026-11-06)

- Confirmed the thumbnail cache clearing function removed every directory entry, including lock, temporary WebP, and FFmpeg frame files owned by active workers. Removing a live inter-process lock can let another API process acquire the same destination and generate/publish concurrently; deleting an in-flight output can also make the original worker fail.
- Cache clearing now removes completed cache entries only and leaves lock/partial artifacts in place for their owning worker and existing cleanup policy.
- Added a regression test that creates a completed thumbnail plus simulated active lock, temporary WebP, and FFmpeg frame files; it verifies the completed derivative is cleared while all in-flight artifacts remain.
- Targeted test and CI validation are pending. This change does not resolve stale-lock recovery after a crashed worker; that remains an open operational concern.


## Validation follow-up — thumbnail cache race and Windows lifecycle (2026-11-06)

- **Fast Validation #1235 passed** on commit 59cf2461c1f0a8467f3c744309eeefa73bd50c9c: both validate and windows-archive-and-updater-smoke jobs succeeded. The passing validate job includes typecheck/generated contracts, Expo CLI configuration, desktop web-server safety, release/storage contracts, official 7-Zip policy and binary compatibility checks, PostgreSQL media LIKE filters, cross-connection conversion advisory locks, conversion finalization restart recovery, and targeted backend regressions. This run includes the thumbnail cache clear regression.
- **Dependency Review #998 passed** on the same commit.
- **Windows installer lifecycle #86 failed** on the same commit. The installer built and compiled successfully, but the standard-user install/upgrade/recovery/diagnostics/uninstall exercise failed. The job reports the failure in its single lifecycle step; the available GitHub run metadata does not expose the step console output or preserved runner-local diagnostic files, so the failing lifecycle phase is not yet established. Do not treat this as a product defect until the exact assertion/log is recovered; equally, do not mark the installer lifecycle as passed.
- Follow-up inspection confirmed the lifecycle script preserves runner-local diagnostics on failure and prints them to the job log. The current connected GitHub metadata view exposes the failed step but not that log body. Next action is to obtain the failing phase/assertion from the job log, reproduce it, and only then make a targeted correction.
- The thumbnail cache clear change is now **CI-validated** by Fast Validation #1235. It intentionally leaves stale lock recovery open; no age-only lock stealing was reintroduced.
- PR #2 remains open and draft. No main branch, production data, credentials, release artifacts, or production settings were changed.


## November 6 — installer release gate and interrupted-update entrypoint

### Confirmed Windows lifecycle failure

- Windows installer lifecycle run [#87](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42207208095) completed dependency installation, release staging, installer compilation, standard-user first install/start, in-place upgrade, and the simulated `swapped` recovery case.
- It then failed in the prepared-phase recovery case. The smoke test deliberately moved the entire install directory to its sibling backup, leaving the configured install path absent, then invoked `$InstallRoot\\desktop\\WillardMediaCenter.ps1`. The captured standard-user stderr is a PowerShell `CommandNotFoundException` for that missing path; the subsequent health check timed out.
- This exposes a real recovery-entrypoint gap, not merely an arbitrary assertion failure: Inno Setup's Start Menu and desktop shortcuts also point directly to `{app}\\desktop\\WillardMediaCenter.ps1`. When a crash occurs after the old install directory is renamed to its backup but before the candidate becomes the install directory, the ordinary shortcut cannot launch the script that contains `Recover-InterruptedUpdateSwap`. The recovery code is present but unreachable through the normal entrypoint in this exact crash window.
- **Status: high severity, found / architecture blocked.** Do not mark prepared-phase recovery as validated. A safe fix needs a stable bootstrap entrypoint outside the directory being swapped (for example, a small per-user launcher under LOCALAPPDATA) and shortcuts that target it. The bootstrap must validate the journal and all sibling paths, reject reparse/symlink escapes, restore only a verified backup using same-volume no-overwrite moves, preserve candidate/backup/journal on ambiguous states, and then invoke the restored launcher. The Windows lifecycle test must invoke the same stable shortcut target after simulating the missing install directory. Do not paper over this by invoking a hidden backup launcher from the test; that would not represent normal user recovery.
- The lifecycle run did pass the earlier first-install/start, upgrade, and `swapped` rollback path. It did **not** reach the database-failure diagnostics or uninstall checks.

### Release validation was not fail-closed

- The same run's release staging log showed `validate-release.mjs` failing because it expected packaged `sharp@0.35.2` while the resolved API runtime dependency and staged package were `0.35.5`. The PowerShell build script continued to compile Setup.exe because it did not inspect `$LASTEXITCODE` after either Node command. Thus a failed payload validation did not stop the local installer build.
- Fixed the version-drift check to compare the packaged sharp manifest with the actually resolved API-runtime sharp manifest, rather than a stale hard-coded patch version.
- Added a checked Node-step wrapper in `build-installer.ps1` that throws on a non-zero exit from both release staging and release validation, before installer compilation can run.
- Added regression assertions for resolved-version parity and fail-closed command ordering.
- **Commits:** validator `5d32957d24155a10a33695fa7de9b509ca89cfe2`; build gate `487391fc852b9dd359a60e80960f86bb0b057cf1`; tests `693bf789c5ec9657892a59b61cbef1559d1e2221` and correction `dfcae31e1e906c340f1659e41a3e9e9bd9cff856`. These changes are committed. Fast Validation #1242 has passed its Linux validation job and Windows archive/updater smoke; the Windows installer build also completed successfully in lifecycle run #97. The full installed-product lifecycle portion of #97 had not completed at this report update, so it is not counted as a lifecycle pass.

### Prioritized findings ledger update

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| High | Windows updater → restart after crash between install-root rename and candidate activation | found / architecture blocked | — | Normal shortcuts target a launcher inside the temporarily absent install root. Requires a stable out-of-root bootstrap and a lifecycle test that launches through the real shortcut target. |
| High | Windows installer build → release staging/validation failure handling | target-tested | `487391fc852b9dd359a60e80960f86bb0b057cf1` | Source-contract regression and normal Windows build passed; an injected non-zero Node-step failure still needs a direct PowerShell behavior test. |
| Medium | Windows release payload → sharp version parity | integration-tested | `5d32957d24155a10a33695fa7de9b509ca89cfe2` | The Windows release staging/validation/compile step passed; the full installed-product lifecycle remains separately open. |

### Validation snapshot

- Fast Validation [#1236](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42207208446) passed on the preceding code head `164e2f10726f47aa24ea6c97328bed5812f08742`, including typecheck/generated contracts, PostgreSQL media filters and conversion recovery checks, targeted backend regressions, and the Windows archive/updater smoke job.
- Windows installer lifecycle [#87](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42207208095) failed as detailed above. The installer compiled, but the full installed-product lifecycle did not pass.
- Dependency Review #999 passed on the preceding head. The new installer changes still require a fresh dependency-review result.
- This audit branch remains separate from `main`; PR #2 remains open and draft. No production data, credentials, or release artifacts were changed.


## November 6 — conversion crash recovery: partial staged results

- **Finding — Medium (Optimize Center → execute/retry after a worker crash):** The execute route persists per-file counters as work progresses, but writes the per-file `resultJson` only after the entire conversion loop completes. If the process exits or a later database operation throws after one or more files have been successfully converted and verified, those staged files remain under `WillardAI/conversions/<jobId>` but their paths and verification records have not been durably stored. Startup recovery can mark the job failed, but cannot reconstruct which staged files were successful. The retry route clears `resultJson` and reuses the same job-level staging directory.
- Originals remain untouched during this stage, so this does not establish loss of original media. It does mean completed conversion work can become inaccessible to the user and can leave unreferenced staged files; a retry can then encounter or overwrite files from the abandoned attempt.
- **Status: found by source inspection; architecture required.** The safe design is already part of the conversion-worker fencing plan: create a unique staging directory per attempt, persist a durable per-file manifest/checkpoint before advancing the job, and make every checkpoint conditional on the current owner generation. Startup recovery must either restore a complete actionable result set or retain an explicit recovery record for the abandoned attempt. Do not simply clear the shared staging directory on retry while stale workers may still be alive.
- This finding reinforces the existing high-severity FFmpeg/event-loop and worker-fencing work. No partial code workaround was applied.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Optimize Center → crash after successful staged files → retry | found; architecture required | documentation/investigation only | Result JSON is not checkpointed per file; staged successes can become orphaned, and retries reuse the same job-level staging directory. Requires attempt-scoped staging, durable per-file checkpoints, and worker fencing. |


## November 6 — additional media and NAS responsiveness findings

### On-demand thumbnail generation still blocks the API event loop

- **Finding — Medium (Media Library → video/PDF thumbnail requests and image fallback):** `thumbnail-engine.ts` exports an asynchronous thumbnail generation flow, but the video, PDF, and FFmpeg image-fallback helpers call `spawnSync` directly with 15–30 second timeouts. A thumbnail request can therefore block the API event loop for the full tool timeout; concurrent media requests, health checks, and cancellation handling in the same API process are delayed. This is separate from the longer Optimize Center FFmpeg blocking path already recorded above.
- **Status: found by source inspection.** Include thumbnail jobs in the shared asynchronous media-tool runner design. The runner should bound stdout/stderr, time out, terminate the process tree on Windows, clean temporary frames in a finally path, and preserve the existing per-thumbnail lock and atomic publish behavior. Do not convert only the call to a Promise while leaving process ownership/cancellation undefined.

### Organization preflight disk-space probe is synchronous and platform-dependent

- **Finding — Medium (Organize → destination preflight on slow/offline NAS):** `getDiskFreeBytes` calls `fs.existsSync` and `spawnSync("df", ["-B1", ...])` without a timeout. On Linux/macOS, a stalled network mount can block the Node event loop while those synchronous filesystem/command calls wait. On Windows, `df` is not a standard command, so the helper returns `null`; the caller leaves `diskOk` true and reports only “Check unavailable on this system.” The preflight can therefore appear successful even though the per-destination free-space check was not performed.
- **Status: found by source inspection; no runtime failure is claimed.** Replace this with a bounded, asynchronous, cross-platform capacity probe and represent “unknown” separately from “enough space” in the preflight result. Keep the existing NAS-root capacity check, but do not render an unavailable per-destination check as an unqualified pass. Test Windows local and UNC paths, Linux mounted paths, and an unavailable/stalled NAS without blocking unrelated API requests.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Media Library → on-demand video/PDF/fallback thumbnail | found; architecture required | documentation/investigation only | Synchronous FFmpeg calls can block the API event loop for up to 30 seconds per request. |
| Medium | Organize → per-destination disk-space preflight | found; architecture required | documentation/investigation only | Synchronous `df`/filesystem probes can block on NAS; Windows treats an unavailable per-destination check as non-blocking. Requires an async bounded provider and an explicit unknown state. |


### Validation follow-up — November 6, current audit head

- Fast Validation [#1242](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42211932344) completed successfully on audit head `a9870292e38d6a2e5a596e03447088d1c36a5ad4` (run attempt 1). Both jobs passed: Linux validation/typecheck/release-storage contracts/PostgreSQL conversion checks/targeted backend regressions, and Windows archive/updater smoke including no-overwrite, storage migration, NAS temp cleanup, conversion finalization rollback, official 7-Zip symlink metadata, TAR preview, and updater preservation/rollback.
- Dependency Review [#1005](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42211932307) passed on the same audit head.
- Windows installer lifecycle [#97](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42211932341) successfully completed the unsigned installer build/compile step, which exercises the corrected resolved-sharp check and fail-closed build wrapper. Its standard-user lifecycle step was still running at the time of this update. Do not count the lifecycle as passed; run #87 already failed at prepared-phase recovery, and the stable-bootstrap defect remains open.
- No full-repository CI matrix was run. The successful Fast Validation workflow is broad targeted/integration validation, not a claim that every workflow or installed-product scenario passed.


### Post-update status — Windows lifecycle run #97

- Run [#97](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42211932341) was **cancelled**, not passed or failed, after the unsigned installer build/compile step had succeeded. Its installed-product lifecycle step was interrupted when the audit branch received the documentation-only ledger correction; the cleanup step then reported failure because cancellation interrupted teardown.
- Therefore, the new sharp parity and installer build path have a successful Windows build/compile integration result, but run #97 provides no new result for first-start/upgrade/recovery/uninstall. The last completed installed-product lifecycle result remains run #87's prepared-phase recovery failure. Keep that high-severity finding open.

## November 6 — packaged Windows process identity and stop-command reliability

- **Finding — High (Windows installer → stop services after an in-place upgrade):** Windows installer lifecycle run [#99](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42212848059) built and installed the package, completed first startup and upgrade, and passed the earlier swapped-update recovery scenario. The next stop command failed while checking PID 892 because the WMI response did not include enough process identity metadata. The launcher then routed a stop-command error through the generic startup-failure handler, which opened a modal MessageBox. The lifecycle wrapper waited 180 seconds and timed out instead of receiving a prompt failure. The exact omitted WMI field was not recorded in that run; no claim is made that the process was actually stopped.
- **Fix:** The packaged launcher now requires the current process creation timestamp and checks it against the persisted timestamp before using any fallback. When the PID and exact creation timestamp match, omitted ExecutablePath or CommandLine fields may be filled from the already-persisted record. A missing creation timestamp or a PID/creation-time mismatch still fails closed; any returned path or command-line mismatch still fails the identity comparison. This uses the recorded process-generation identity rather than trusting a PID alone.
- **Stop UX correction:** An explicit -Stop failure now writes stop-specific diagnostics, releases the launcher mutex, and exits nonzero without showing the startup modal or retrying an unsafe shutdown. The process-state file is retained for diagnosis and later recovery.
- **Regression coverage:** Updated the installer contract tests for creation-time-gated WMI fallback, required creation timestamps, and non-modal stop failure handling. The installed-product lifecycle remains the real Windows integration check.
- **Commits:** Packaged launcher implementation is committed in `158f4cc7ac66f29a084e017270808b14cdba446a`; its static regression anchor correction is committed in `16de89037e1201eb7a9f9a6787b25adc238af60a`. Fast Validation #1247 then exposed two stale test expectations (the new fifth mutex-release path and property-specific WMI error text); both are corrected in this follow-up batch. The installed-product lifecycle is still pending.
- **Remaining risk:** The failed run did not expose whether WMI omitted ExecutablePath, CommandLine, or both. The new logic is intentionally limited to a matching PID plus exact creation timestamp. The next Windows lifecycle run must confirm that the stop path now completes. The separate prepared-phase update bootstrap gap remains high severity and unresolved.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| High | Windows installer → stop packaged services after upgrade | fixed; targeted validation pending | `158f4cc7ac66f29a084e017270808b14cdba446a` | Must pass Windows installed-product lifecycle; WMI creation timestamp must remain available and match exactly. |
| Medium | Windows launcher → report stop failure without blocking modal | fixed; targeted validation pending | pending commit | Windows lifecycle must verify a failed stop returns promptly and preserves diagnostics/state. |

## November 6 — Media Center accessibility and control semantics

- **Finding — Medium (Media Center → search, filters, folder navigation, status banners, and view controls):** Source inspection found several icon-only buttons without accessible names (dismiss, close details, clear search, folder disclosure, grid/list, and refresh), a search input and sort select without explicit labels, and toggle-like tag/type/folder/view controls that did not expose their selected state. The folder disclosure control was also rendered as an enabled button for folders with no children.
- **Fix:** Added explicit accessible names, pressed/expanded state, and native disabled state for non-expandable folder disclosures. Search and sort controls now have labels. Tag, media-type, current-folder, and view-mode choices expose their selected state. Dismiss/close actions identify the notification or file context.
- **Regression coverage:** Extended the UI accessibility contract suite with assertions for all of these Media Center controls. This is static source-contract coverage; browser keyboard and screen-reader verification remains a separate milestone.
- **Commit:** pending commit.
- **Remaining risk:** This batch covers the audited Media Center controls, not every page or a full assistive-technology session. Browser-level accessibility checks and manual screen-reader verification remain open.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| Medium | Media Center → accessible names and state for search, filters, folder tree, status actions, and view controls | fixed; targeted validation pending | pending commit | Must pass UI contract tests; browser keyboard and screen-reader testing still required. |

## November 6 — Windows process identity parity and stop-command fail-closed behavior

- **Follow-up to lifecycle #99:** The packaged launcher now uses the recorded process creation timestamp as the required PID-reuse discriminator before falling back to persisted executable/command-line values when WMI omits those optional fields. This batch extends the same bounded behavior to the developer launcher so its stop/restart path does not fail on the same WMI metadata omission.
- **Stop lock acquisition:** The packaged launcher now reports an explicit -Stop mutex-acquisition failure through stop-specific diagnostics instead of showing the generic startup MessageBox. The already-fixed outer stop catch also releases the mutex and returns nonzero without retrying a shutdown that could not be verified.
- **Windows runtime regression:** The developer process-ownership smoke now mocks WMI to prove that missing optional fields are accepted only when the exact creation timestamp matches, a reused PID is rejected, and a missing creation timestamp fails closed.
- **Fast Validation #1247:** The run reached release/storage contract tests and completed 81 tests before failing two static assertions in installer-config.test.mjs. The failures were stale test expectations introduced by the new stop-failure mutex release and property-specific WMI errors; the new non-modal stop test itself passed. The next run must pass the corrected installer contracts and then execute the UI and backend regression suites.
- **Windows lifecycle #104:** At this report update it was still in the unsigned installer build/compile stage. No installed-product lifecycle result is claimed; the next run on the updated head must verify first startup, upgrade, stop/restart, recovery, diagnostics, and uninstall.
- **Remaining architecture risk:** Both launchers still validate a PID and later invoke taskkill by PID. The identity check and termination are separate operations; if the original process exits and Windows reuses its PID between those operations, taskkill could target the replacement process. This is a source-inspected TOCTOU risk, not an observed incident. A safe complete fix needs process-instance-bound handles plus process-tree ownership (likely a Windows Job Object with a stable supervisor/owner); do not replace taskkill with a single-process kill that leaves service descendants behind.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| High | Windows installer/developer launcher → verify and stop tracked processes when WMI omits optional fields | fixed; targeted validation pending | pending commit | Exact process creation time remains mandatory; Windows smoke and installed lifecycle must pass. |
| Medium | Windows launcher → explicit stop when startup mutex cannot be acquired | fixed; targeted validation pending | pending commit | Static contract and Windows lifecycle must confirm prompt non-modal failure. |
| Medium | Windows launcher → process identity check followed by PID-only process-tree termination | found; architecture required | — | TOCTOU PID reuse window remains; requires handle-bound process identity and process-tree ownership design. |

## November 6 — Windows stop diagnostics after lifecycle #104

- **Integration result:** Windows installer lifecycle [#104](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42218506198) successfully built and compiled the unsigned installer, created the standard user, installed the product, and completed first startup. The first installed stop command then failed because the tracked process PID 2360 was still present after the shutdown attempt. The process was not force-cleared from the journal and the running installation was left in place. This run does not validate upgrade/recovery/uninstall.
- **Confirmed diagnostic defect:** Both packaged and developer launchers invoked `taskkill` by command name, discarded all output, and ignored `$LASTEXITCODE`. If the executable could not be resolved or Windows refused termination, the only resulting message was the surviving PID; the actual operating-system reason was lost.
- **Fix:** Both launchers now resolve taskkill.exe from the Windows system directory, verify that the executable exists, capture its output and exit code, and include sanitized output with the surviving PID in the retained-state error. They still verify process identity after the attempt and do not clear the state file when a tracked process remains.
- **Remaining risk:** The reason PID 2360 survived in run #104 is not established because the previous code discarded taskkill output. The new diagnostics are intended to distinguish path resolution, access denial, and an actual surviving process in the next Windows lifecycle run. The PID-check-to-taskkill TOCTOU risk remains separately recorded and is not solved by this diagnostic change.

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| High | Windows installer → stop API/web service tree after first startup or upgrade | fixed diagnostic gap; targeted validation pending | pending commit | Must observe taskkill result on next Windows lifecycle run; process still must be stopped safely. |
| Medium | Windows developer launcher → stop tracked service tree | fixed diagnostic gap; targeted validation pending | pending commit | Windows process-ownership smoke and targeted contract tests must pass. |

## November 6 — Windows service-stop race and cleanup API responsiveness

### Confirmed Windows stop race — fixed, targeted-tested; lifecycle validation pending

The Windows lifecycle runs on the preceding test-harness commit exposed a repeatable stop failure in both first-start and post-upgrade flows. taskkill.exe returned success and reported that the tracked Node processes had been terminated, but the immediate Win32_Process identity query still returned the same tracked PID. A later stop attempt succeeded after the stale WMI process record disappeared. The stop routine therefore treated a terminated service as still running and aborted the installer lifecycle.

The packaged launcher and developer launcher now poll the exact tracked process identity for up to five additional seconds after the existing process wait. The identity check still includes the recorded executable path, command line, and creation date; an unverified or genuinely surviving process remains a fail-closed error. This does not weaken process ownership checks.

The same batch corrected two stale test contracts: the lifecycle stage assertion now checks the stage helper actually used by the smoke script, and the developer process-identity assertion now inspects Test-ProcessIdentity rather than the preceding Get-ProcessIdentity function block.

- Diagnostic/test-harness commit: 42f57a36fbb48c8dbe89a954ad6e9ad6d746a03c
- Product stop-race fix and regression-contract commit: bdb60bd57f425cf2392fe09958c33868a7145397
- Fast Validation #1251: validate job completed successfully, including TypeScript/generated contracts, release/storage contracts, Windows archive/updater smoke, and targeted backend regressions. The workflow run was still finalizing when this section was written.
- Dependency Review #1014: passed.
- Windows installer lifecycle #111 and #112: running against the fix; neither is counted as a pass yet.

Remaining risk: the five-second WMI visibility grace still needs the complete installed-product lifecycle run to confirm it is sufficient. The prepared-phase updater recovery entrypoint problem remains open and still requires a stable bootstrap outside the swapped installation directory.

### New confirmed performance finding — Windows cleanup blocks the API event loop

Source inspection of artifacts/api-server/src/routes/cleanup.ts found that the Windows Recycle Bin branch calls spawnSync("powershell", ...) inside the per-file cleanup loop, with a 30-second timeout and up to 500 file IDs accepted by the request. Each synchronous call blocks the API event loop, so a slow or stuck Recycle Bin operation can stall unrelated API requests; a large cleanup batch repeats that risk for every file.

- Severity: Medium (API responsiveness / cleanup workflow).
- Status: found; no code change in this batch.
- Planned fix: use the existing Node child-process async pattern with a bounded timeout, pass the path as environment data rather than interpolating it into PowerShell source, and preserve the current per-file PREPARED/MOVING/FAILED/FILESYSTEM_MOVED journal transitions. Add focused runner-injection and route-contract tests.
- Remaining risk: until changed, Windows cleanup can temporarily block all API request handling while PowerShell runs.

### Prioritized ledger delta

| Severity | Affected workflow | Status | Commit | Remaining risk |
|---|---|---|---|---|
| High | Windows launcher stop; installer upgrade/uninstall | fixed; targeted-tested; lifecycle validation pending | bdb60bd57f425cf2392fe09958c33868a7145397 | Full installed-product lifecycle #111/#112 not yet confirmed |
| Medium | Windows cleanup / Recycle Bin | fixed; target-tested | `04c7823558d9ab4d9d4b6274479861b0be24e883` | Asynchronous bounded PowerShell execution is covered by Fast Validation; actual Windows Recycle Bin runtime behavior and 500-file request duration remain unverified |
| High | Prepared-phase updater recovery | found; architectural plan documented | existing audit findings | Stable bootstrap is still required; do not treat the packaged in-directory recovery routine as reachable when the install directory is absent |
| High | Media conversion and thumbnail event-loop blocking | fixed; target-tested; integration-tested | `71bc9720cb953f1db4fdaf378de7b305e1d477bd`, `42564462587aef12e423ab34a63061a2e25bb2e2`, test correction `01c44d2851ed5841eab6b521d819ac37023dc66b` | Full CI not run; installed Windows lifecycle remains pending |
| Medium | Media subprocess shutdown race | found; follow-up required | none | A new FFmpeg child can start after the shutdown process snapshot; reject new children once shutdown begins |
| Medium | 7-Zip version resolution on API request paths | found; follow-up required | none | Synchronous 10-second version probes repeat in archive routes and can block unrelated API requests |


## November 6 — Windows cleanup Recycle Bin execution moved off the API event loop

- **Finding resolved — Medium (Cleanup → Windows Recycle Bin):** The previous Windows branch used `spawnSync("powershell", ...)` inside the per-file cleanup loop with a 30-second timeout. A blocked shell therefore blocked the entire API event loop. The request accepts batches, so the delay could repeat per file.
- **Fix in code commit:** `04c7823558d9ab4d9d4b6274479861b0be24e883` adds `artifacts/api-server/src/lib/windows-recycle-bin.ts`, uses the existing Node child-process API through asynchronous `execFile`, caps execution at 30 seconds and output at 64 KiB, runs PowerShell noninteractively, and supplies the target path through the child environment rather than interpolating a filename into PowerShell source. The cleanup route awaits the helper and preserves the existing `MOVING`, `FAILED`, and `FILESYSTEM_MOVED` journal transitions. A failed Recycle Bin operation remains recorded as `FAILED`; the route does not mark it moved.
- **Regression coverage:** `windows-recycle-bin.test.ts` checks the bounded noninteractive invocation, quote/metacharacter/Unicode-safe path handoff, surfaced stderr, timeout reporting, and route journaling/no-`spawnSync` contract.
- **Validation:** Fast Validation [run 42226785444](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42226785444) passed on the exact code commit: Linux `validate` job and Windows `windows-archive-and-updater-smoke` job both completed successfully. The Windows archive/updater job is not a Recycle Bin runtime test. This is targeted/integration validation, not full CI and not proof of the actual Windows Recycle Bin provider behavior.
- **Status:** fixed; target-tested. Remaining verification: exercise a real Windows Recycle Bin move/failure/timeout under the installed Windows environment, and measure long cleanup batches. The helper is asynchronous but the route still processes files sequentially, so a 500-file request can take a long time without blocking unrelated API requests.

## November 6 — Prepared-phase Windows updater recovery is unreachable without a stable bootstrap

- **Severity: High. Affected workflow:** Windows installer/updater → recovery after interruption between writing the `prepared` journal and completing the directory swap.
- **Observed integration failure:** Windows installer lifecycle [run 42226785436](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42226785436) successfully built and compiled the unsigned installer, installed it for a standard user, started the product, upgraded it, and completed the simulated `swapped`-phase recovery. It then failed during the prepared-phase recovery scenario. The retained log reports that `C:\\WillardLifecycle\\wl_life_9ac6147a\\desktop\\WillardMediaCenter.ps1` could not be found; the lifecycle subsequently timed out waiting for the API health endpoint. The error occurred in the test's launcher invocation before the packaged recovery code could run.
- **Root cause confirmed from caller and installer entrypoints:** `scripts/windows/installer-lifecycle-smoke.ps1:278-293` simulates the interruption by moving the entire install root to its sibling backup, then calls `Invoke-InstalledLauncher`. That helper resolves the launcher only at `$InstallRoot\\desktop\\WillardMediaCenter.ps1` (`installer-lifecycle-smoke.ps1:105-106`). The installer creates both Start Menu and desktop shortcuts that invoke the same in-directory script (`installer/WillardMediaCenter.iss:57-61`). When the install directory is absent, neither the test nor a user shortcut has a surviving executable entrypoint. The recovery routine inside the moved install tree cannot recover a directory that must exist before that routine can be started.
- **Why no partial workaround was applied:** Changing the test to invoke a backup copy or adding a one-off recovery command inside the test would mask the actual user-facing defect. Moving only the recovery function to another script still leaves the shortcut and update entrypoint coupled to the versioned directory. This is a bootstrap/lifecycle design issue, not a safe local patch.
- **Safe implementation plan:**
  1. Introduce a small stable per-user bootstrap installed outside the versioned install directory and not replaced during an application swap. Update Start Menu, desktop, post-install, repair, and updater entrypoints to call this bootstrap first.
  2. Have the bootstrap validate the journal version and phase, canonical install root, and candidate/backup sibling paths before any filesystem mutation. Reject reparse-point/path escapes and ambiguous or missing backups; retain the journal and diagnostics on uncertainty.
  3. For a `prepared` journal with the live install missing and a verified sibling backup present, restore the previous install atomically, verify its expected identity, clear the journal only after verification, and then launch the restored version. Do not execute the candidate merely because it exists.
  4. Define installer upgrade/uninstall ownership for the stable bootstrap separately from user data. Bootstrap replacement must itself be atomic and recoverable; uninstall must remove it only after services are stopped and the user-data retention policy is honored.
  5. Extend the installed-product lifecycle to launch only through the stable bootstrap with the live install absent. Cover `prepared`, `backup-created`, and `swapped` crash points, invalid journal paths, missing/corrupt backups, and preservation of external database/media state on Windows.
- **Status:** found; architecture plan documented. No product workaround was committed. The existing `swapped` recovery success does not validate `prepared` recovery.
- **Remaining risk:** if an update is interrupted after the old install directory has been moved but before the new one is in place, the packaged launcher and its shortcuts are unavailable. A user may be unable to start the app without manual recovery. Keep this high-priority blocker open until the stable bootstrap is implemented and the installed-product lifecycle passes.

### Validation snapshot for code head `04c7823558d9ab4d9d4b6274479861b0be24e883`

- Fast Validation [run 42226785444](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42226785444): **passed**. The Linux `validate` job and Windows `windows-archive-and-updater-smoke` job both passed. The Linux job includes typecheck/generated contracts, desktop and storage checks, PostgreSQL conversion checks, and the configured targeted backend regressions.
- Dependency Review [run 42226785435](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42226785435): **passed**. Its separate installed-dependency-graph job was skipped.
- Windows installer lifecycle [run 42226785436](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42226785436): **failed** at prepared-phase update recovery after the unsigned installer build/compile and earlier install/upgrade/swap-recovery stages succeeded. The failure exposes the missing stable bootstrap described above; it is not a successful installed-product lifecycle.
- **Full CI:** not run/passed. No claim of full-repository validation is made.


## November 6 — API media conversion and thumbnail subprocesses moved off the event loop

- **Severity: High. Affected workflows:** media optimization/conversion (video, RAW-image and generic image fallback), thumbnail generation (video, PDF and FFmpeg image fallback), and all unrelated API traffic while those operations run.
- **Root cause confirmed by source inspection:** `artifacts/api-server/src/routes/optimize.ts` invoked `spawnSync("ffmpeg")` from the request/SSE path for video conversion (up to a one-hour timeout), RAW-image conversion (five minutes), and generic image fallback (five minutes). `artifacts/api-server/src/lib/thumbnail-engine.ts` also used synchronous FFmpeg for video frame extraction, frame-to-WebP conversion, PDF thumbnails, and image fallback (15–30 seconds). Because these operations execute on the single Node API event loop, health checks, cancellation requests, and unrelated API routes could not run until the current child process returned.
- **Fix:** commits `71bc9720cb953f1db4fdaf378de7b305e1d477bd` and `42564462587aef12e423ab34a63061a2e25bb2e2` replace request-path FFmpeg `spawnSync` calls with the shared asynchronous `execFile` runner. Existing operation timeouts remain bounded; output capture is capped at 1 MiB; FFmpeg runs noninteractively with error-only logging. Video conversion is awaited, and video/PDF/image thumbnail paths now await the same runner. The existing Sharp image path remains unchanged.
- **Process ownership:** the runner registers each child process. The existing conversion shutdown hook now terminates tracked FFmpeg children with SIGTERM and escalates to SIGKILL after a bounded grace period before draining active conversion requests. This includes thumbnail FFmpeg children, not only conversion jobs.
- **Regression coverage:** `media-tools-async.test.ts` verifies that the event loop continues ticking while a child runs, process timeouts are enforced, missing FFmpeg remains actionable, conversion and thumbnail routes no longer use synchronous FFmpeg, and shutdown terminates an owned child. The test also runs on Windows.
- **Validation on exact head `01c44d2851ed5841eab6b521d819ac37023dc66b`:**
  - Fast Validation [run 42249163822](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42249163822): **passed**. Linux `validate` job passed typecheck/generated contracts, desktop/release/storage checks, PostgreSQL media filters, conversion advisory-lock and finalization-recovery integration checks, and targeted backend regressions. The targeted run reported **345 tests, 343 passed, 0 failed, 2 skipped**.
  - The same Fast Validation run's Windows `windows-archive-and-updater-smoke` job **passed**, including the new asynchronous media-process test, storage migration/no-overwrite, NAS temp cleanup, conversion finalization, official Windows 7-Zip symlink metadata, compressed TAR preview, updater journal writes, and developer updater preservation/rollback.
  - Dependency Review [run 42249163854](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42249163854): **passed**. Its separate installed-dependency-graph audit was skipped.
  - Windows installer lifecycle [run 42249163671](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42249163671): **in progress** at this ledger update. The preceding completed lifecycle run [42237900458](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42237900458) failed in prepared-phase recovery as documented below.
  - **Full CI:** not run/passed. The above is targeted plus selected Windows/PostgreSQL integration validation, not full-repository CI.
- **Status:** fixed; target-tested; integration-tested. Not fully validated until the installed-product lifecycle and full CI are complete.
- **Remaining risk:** the process registry takes a snapshot when shutdown starts, but `runMediaToolAsync` does not yet reject a new child after `markShuttingDown`. An in-flight thumbnail request could reach its FFmpeg step after the snapshot and create a late child. Add a shutdown-state guard and regression before treating process ownership as fully closed.

## November 6 — Synchronous 7-Zip version probing (fixed)

- **Severity: Medium. Affected workflows:** 7z/RAR/CAB/ISO catalog/inspection and extraction, plus compressed TAR input that invokes 7-Zip.
- **Root cause:** `getSevenZipPath()` previously ran `spawnSync(candidate, ["i"], { timeout: 10_000 })` on request paths. Organize preview, validation, extraction, archive preview, and compressed TAR input could repeatedly probe configured, packaged, and PATH candidates. A slow or missing candidate could block the API event loop for up to ten seconds per candidate and call.
- **Fix:** version probing now uses the existing tracked `runMediaToolAsync` runner with a 10-second timeout and 64 KiB output bound. The resolver is asynchronous; concurrent first probes share one promise; a verified positive path is cached for the process lifetime; negative results are retried so an operator can install 7-Zip without restarting. Organize list/preflight/extract, archive preview, and compressed TAR input now await the resolver and reuse the resolved path within each operation.
- **Regression coverage:** `sevenzip-path.test.ts` covers candidate precedence, supported/unsupported versions, configured/packaged/Windows/Linux paths, async probe contract, concurrent coalescing, positive caching, and negative-result retry. `archive-tar-input.test.ts` now awaits the resolver and exercises gzip, official 7-Zip bzip2/xz, and invalid compressed input. The official 7-Zip 26.05 TAR preview tests passed in Linux Fast Validation.
- **Status:** fixed; target-tested; Linux archive integration-tested. Windows compressed TAR validation is running in Fast Validation; not fully validated.
- **Commits:** batch range starts at prior audited head `1c40b0d9eb68d88e10573fcb57c7c997137c150e` and reaches current code head `64b430c7528b26e3477b4f5ee8798b98174be618` (10 commits in this batch). Individually observed follow-up commits: `658e8b7ea0609ac0933a013276d535f7f777da8c`, `08590557aff4341feec43796c127bc9491a4ba5a`, `594284e5450975448b6429f276a1433098284c40`, `eae046a47d1e829070dc72a5a225df82a30cd5d4`, `446433e72e127ca501408e13f4bf729e48cc571b`, and `64b430c7528b26e3477b4f5ee8798b98174be618`.
- **Remaining risk:** Windows archive/updater and installer lifecycle workflows are still running at this snapshot; full CI and installed NAS/SMB behavior have not been validated.
## November 6 — Media child-process shutdown late-spawn race (fixed)

- **Severity: Medium. Affected workflow:** graceful API shutdown during an active thumbnail, conversion, or other media-tool request.
- **Root cause:** `stopActiveMediaTools` terminates a snapshot of tracked children. Shutdown marks the application as stopping before invoking the conversion shutdown hook, but `runMediaToolAsync` previously accepted new child requests after that snapshot. A request between thumbnail frame extraction and encoding could therefore start an untracked late child.
- **Fix:** `runMediaToolAsync` now checks `isShuttingDown()` before invoking `execFile` and rejects with `ERR_SERVER_SHUTTING_DOWN` before a new process can start. Existing tracked children still use the existing graceful/forced termination path; the formatter preserves an actionable shutdown message.
- **Regression coverage:** `media-tools-async.test.ts` confirms active child termination and then marks shutdown and verifies a new process request is rejected before spawn.
- **Status:** fixed; target-tested on Linux in Fast Validation. The Windows Fast Validation media subprocess smoke step passed, but the complete Windows job and installer lifecycle are still running.
- **Remaining risk:** this closes the late-spawn race for the shared media-tool runner; other subprocess creation paths still require separate ownership/cancellation review. Full CI has not been run.

## 2026-11-06 validation snapshot — async archive and shutdown batch

- **Branch:** `audit/full-repository-review-2026-11`; exact head `64b430c7528b26e3477b4f5ee8798b98174be618`. Batch range: `1c40b0d9eb68d88e10573fcb57c7c997137c150e` → `64b430c7528b26e3477b4f5ee8798b98174be618`, 10 commits. The individually observed follow-up SHAs are recorded in the 7-Zip section; the GitHub compare confirms the complete batch range.
- **PR #2:** open, draft, unmerged, base `main`; 188 changed files; 1,334 commits. No branch switch, rebase, merge, or PR state change.
- **Branch comparison:** 1,334 commits ahead and 1 behind `main`; observed base SHA `694a055aeb10a41ee8e98f5b776faef89cbd449d`. No concurrent commit was observed during the batch writes.
- **Fast Validation [run 42251591421](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42251591421):** Linux `validate` job `128007829527` completed successfully. Workspace TypeScript typechecks and generated API contracts passed; Expo config, desktop web-server safety, release/storage contracts, official 7-Zip compatibility, PostgreSQL media-filter/conversion-lock/finalization-recovery integration, and targeted backend regressions passed. Targeted backend suite: 346 passed, 0 failed, 2 skipped. New 7-Zip path, official bzip2/xz TAR preview, invalid compressed input, and media shutdown regressions are present in the successful log.
- **Fast Validation Windows job `128008770703`:** still in progress at this snapshot. Windows media subprocess smoke, storage migration, NAS temp cleanup, conversion finalization, official 7-Zip staging/symlink metadata, and compressed TAR preview steps had passed; developer updater preservation/rollback remained in progress. Do not count the whole Fast Validation workflow as passed yet.
- **Dependency Review [run 42251591583](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42251591583):** passed. The separate installed-dependency-graph audit step was skipped by workflow configuration.
- **Windows installer lifecycle [run 42251591470](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42251591470):** still in progress during installer build; no lifecycle result is claimed.
- **Full CI:** not run. These results are Linux targeted/integration validation plus selected Windows checks, not full-repository CI.
- **Unresolved high-priority risks:** clean-machine installer/recovery bootstrap; conversion worker filesystem fencing and attempt-scoped staging; organization worker runtime takeover/SMB validation; durable Replace backup/recovery (feature remains disabled); complete malicious Windows organize-route archive test; first-run owner provisioning for hosted deployments.
- **Next batch:** inspect conversion execution/finalization/retry ownership end to end. Focus on advisory-lock loss, shared job-level staging, per-file durable progress, retry/recovery races, and child-process cancellation. Design a safe cross-process mutation fence and attempt-scoped journal before changing filesystem behavior.


## 2026-11-06 follow-up — Windows installer lifecycle validation was cancelled by its own concurrency policy

- **Severity: Medium. Affected workflow:** PR validation of standard-user Windows install, upgrade, interrupted-update recovery, diagnostics, and uninstall.
- **Root cause confirmed from workflow and run logs:** `.github/workflows/windows-installer-lifecycle-validation.yml` used the shared group `windows-installer-lifecycle-${{ github.ref }}` with `cancel-in-progress: true`. The pull-request path filter is evaluated against the complete PR diff, which already contains installer/desktop files. Every later PR synchronize therefore starts another lifecycle run even when the new commit only changes API code or this audit report. The newer run cancels the in-progress installer build. Run [42251591470](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42251591470) was cancelled at the installer build step; the subsequent `pg_ctl` cleanup warning that `postmaster.pid` was absent is secondary cleanup after cancellation, not the initiating failure.
- **Fix:** changed the lifecycle workflow to `cancel-in-progress: false`. A running 120-minute lifecycle test now finishes instead of being killed by a later audit commit; GitHub may retain only the newest pending run. Added a regression to `scripts/windows/installer-config.test.mjs` that asserts this workflow's own concurrency block does not cancel an active lifecycle run. The release workflow's separate concurrency policy was not changed.
- **Status:** fixed; target-tested. Fast Validation run 42253408096 passed `scripts/windows/installer-config.test.mjs` 85/85, including this assertion. Do not treat cancelled run 42251591470 as a product pass or a product failure.
- **Fix commits:** workflow `6d29a99eb392a144f398dd32ee292e6237361c62`; regression test `ddae704b4724a33d93cb0ec2891e03529f4d652f`.
- **Validation at this snapshot:** prior Fast Validation [run 42251591421](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42251591421) completed successfully on code head `64b430c7528b26e3477b4f5ee8798b98174be618`: Linux `validate` and Windows `windows-archive-and-updater-smoke` both passed. The Windows job passed PowerShell parsing, media subprocess tests (4/4), storage migration (20/20), NAS path safety (16/16), conversion finalization (12/12), official Windows 7-Zip 26.05 hash/smoke, node-7z metadata, compressed TAR preview (7/7), and developer updater preservation/rollback. Linux workspace typecheck and targeted backend regressions passed (346 passed, 0 failed, 2 skipped).
- Dependency Review [run 42251591583](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42251591583) passed; its installed dependency-graph audit step was skipped.
- The replacement lifecycle run [42252476286](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42252476286), started on the previous audit-report head before the concurrency change, was still building the unsigned installer at this snapshot. A new lifecycle run for the concurrency fix is pending; the current Fast Validation run for the regression test is queued. Do not claim either has passed until its latest matching run completes.
- **Full CI:** not run. Fast Validation is targeted/integration coverage and is not the full-repository CI suite.
- **Next batch:** conversion worker ownership/fencing. The source trace confirms the session advisory lock is released on DB disconnect while the old JS worker may continue; retries reuse `WillardAI/conversions/<jobId>`, progress/result checkpoints are job-ID-only, and child processes are not scoped to a conversion attempt. Implement only after a generation-fenced, attempt-scoped staging design and fault-injection tests are agreed.


## 2026-11-06 follow-up — compressed TAR decompressor shutdown ownership

- **Severity: Medium. Affected workflow:** archive preview of bzip2/xz-compressed TAR files on NAS or local storage.
- **Root cause:** `withTarInput` launched the official 7-Zip decompressor directly with `spawn`. The child was not registered with the shared shutdown owner and the path had no shutdown guard. If the API shut down during decompression, `stopActiveMediaTools` could terminate FFmpeg/ffprobe and the async 7-Zip version probe but not this streaming decompressor. The child could continue writing the large scratch TAR and the helper's `finally` cleanup would not run until the child/pipeline ended.
- **Fix:** reused the existing process registry rather than adding another one. `media-tools.ts` now exports `assertMediaProcessStartAllowed` and `trackActiveMediaProcess`; the TAR helper checks the shutdown state immediately before spawning and registers the child with the same owner that `stopActiveMediaTools` drains. The shutdown documentation now covers media and archive children.
- **Regression coverage:** `media-tools-async.test.ts` directly spawns a long-lived child, registers it, and verifies the shared shutdown owner terminates it; the final shutdown test verifies no new child can start after shutdown. `archive-tar-input.test.ts` asserts the production TAR helper uses both the pre-spawn guard and shared tracker.
- **Status:** fixed; target-tested on Linux and Windows in Fast Validation run 42253408096. The direct archive-helper process ownership test passed on both platforms; Windows `media-tools-async.test.ts` passed 5/5 and `archive-tar-input.test.ts` passed 7/7.
- **Remaining risk:** request-abort cancellation is not yet wired to an `AbortSignal`; this fix covers server shutdown. The `node-7z` list/extract streams in Organize and archive preview still need an explicit child-process ownership/cancellation integration audit. No arbitrary timeout was added to large archive decompression.

## 2026-11-06 validation snapshot — process ownership and workflow repair

- **Code head:** `1e7b1fa5a4967e6db6b3407e8559362ad9f51dee`. This is 19 commits after the prior audit-ledger head `1c40b0d9eb68d88e10573fcb57c7c997137c150e`. The exact commits, oldest to newest, are:
  `6ebd2b0425b757987bb52ea226834f6d43e2d522`,
  `f95b218adebc290060ec3d63b3a6155bb01d0ae7`,
  `2707c14cfbf17622463784b2b8dc0073a7e0d584`,
  `f27aee4c9251b81a477810383cc4786bf90e78c9`,
  `658e8b7ea0609ac0933a013276d535f7f777da8c`,
  `08590557aff4341feec43796c127bc9491a4ba5a`,
  `594284e5450975448b6429f276a1433098284c40`,
  `eae046a47d1e829070dc72a5a225df82a30cd5d4`,
  `446433e72e127ca501408e13f4bf729e48cc571b`,
  `64b430c7528b26e3477b4f5ee8798b98174be618`,
  `0cd7148e83a5303c72ecc503a6cce2eb48fc29f0`,
  `6d29a99eb392a144f398dd32ee292e6237361c62`,
  `ddae704b4724a33d93cb0ec2891e03529f4d652f`,
  `4b0c1de5cfd0bd52aa36b6b01d3a22754e2461a4`,
  `49b0025b3eaa16589570f8532cb6972b90e6463f`,
  `a9653098bb3b052c6bd31a01750bb55896758dcb`,
  `a88a1ebf353cc58738b9da355a30e6b26de1c355`,
  `9f8bca6ddb38363a7972e56b2bb0cdd1dc4bf2e0`,
  `1e7b1fa5a4967e6db6b3407e8559362ad9f51dee`.
- **PR #2:** open, draft, unmerged, base `main`; 188 changed files; 1,343 commits. At code head, comparison was 1,343 ahead and 1 behind `main`; base SHA `694a055aeb10a41ee8e98f5b776faef89cbd449d`.
- **Fast Validation [run 42253408096](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42253408096):** fully completed successfully on code head `1e7b1fa...`. Linux `validate` job `128014159749` passed workspace typechecks, generated API contracts, desktop/release/storage checks, PostgreSQL integration, and targeted backend tests: 349 total, 347 passed, 0 failed, 2 skipped. The new shutdown ownership tests, async 7-Zip resolver/cache tests, and workflow concurrency regression all passed.
- The Windows `windows-archive-and-updater-smoke` job `128015062822` also completed successfully. It parsed 20 PowerShell scripts; passed Windows media rename (11), media-tools async/shutdown (5), storage migration (20), NAS path safety (16), conversion finalization (12), official Windows 7-Zip 26.05 hash/archive smoke, node-7z symlink metadata, compressed TAR preview (7), packaged updater journal writes, and developer updater full-version/preservation/rollback.
- **Dependency Review [run 42253407954](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42253407954):** passed. Its separate installed dependency-graph audit was skipped by workflow configuration.
- **Windows installer lifecycle:** prior run [42251591470](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42251591470) was cancelled by the old `cancel-in-progress: true` concurrency policy. That policy is fixed and its regression test passed. The run [42252476286](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42252476286), started before the fix, is still exercising the standard-user lifecycle; the latest run [42253408506](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42253408506) is pending under the non-cancelling policy. No lifecycle pass is claimed yet.
- **Full CI:** not run. Fast Validation and Dependency Review are not full-repository CI.
- **Unresolved high-priority risks:** stable external Windows recovery bootstrap; conversion worker fencing and attempt-scoped staging; organization multi-process takeover/SMB validation; durable Replace backup/recovery (Replace remains disabled); node-7z list/extract child ownership and request-abort cancellation; hosted first-run owner provisioning.
- **Next batch:** conversion worker ownership/fencing. Trace DB advisory-lock loss, job-ID-only progress writes, retry reuse of `WillardAI/conversions/<jobId>`, per-file durable progress, finalization recovery, and child cancellation. Do not add a partial token check; design an attempt generation, isolated staging, and filesystem mutation fence, then test stale workers and crash/retry interleavings.


## 2026-11-06 follow-up — shared ownership for Optimize Center probes; node-7z lifecycle trace

### Fixed — Medium: Optimize Center FFprobe and media-health subprocess ownership

**Affected workflows:** Optimize Center codec detection and Settings/media-tool health checks; API graceful shutdown.

**Evidence and root cause:** Source inspection found two subprocess paths bypassing the existing media-tools.ts process owner:
- detectVideoCodec in artifacts/api-server/src/routes/optimize.ts used promisified execFile("ffprobe", ...), with a 12-second timeout.
- probeTool in artifacts/api-server/src/lib/media-tools.ts used a second direct execFile(bin, ["-version"]) path, with a 5-second timeout.

Those children were not in the shared active-process registry and were not rejected by the common shutdown start guard. A shutdown could therefore finish draining owned media processes while one of these bounded probes remained active.

**Fix:** Both callers now use the existing runMediaToolAsync helper. FFprobe retains its 12-second timeout and 1 MiB output ceiling; health probes retain a 5-second timeout and use a 64 KiB output ceiling. No dependency or parallel process registry was added.

**Regression coverage:** media-tools-async.test.ts asserts that the Optimize Center FFprobe and health probe call sites use the shared runner. The same suite's existing behavioral tests exercise the runner's timeout, event-loop responsiveness, process registration, and shutdown termination.

**Status:** fixed; Linux target-tested. Fast Validation run [42255943324](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42255943324), Linux job 128023065207, completed successfully: workspace typechecks/generated contracts and PostgreSQL integration steps passed; targeted backend suite reported 350 tests, 348 passed, 0 failed, 2 skipped. The new process-ownership assertion passed. Windows archive/updater smoke was still running at this report snapshot; do not claim its result until that job completes.

**Implementation/test commits:** db10a44db2afda0066de4e0deeb46bf0b8ad67a7 (Optimize Center FFprobe); 873cc2b00d2aeab39498f23471ed5fe78345d1a6 (media health probe); 7d6f35d213e89ac6e48407e2b3e7acb4becca3e1 (initial regression); fb293a5c296c5233ec2682e450461607d79f15aa (corrected regression matchers).

**Remaining risk:** This covers the two identified direct probe paths, not every process launched by third-party wrappers. Windows process-level validation is pending.

### Found — High: node-7z listing/extraction children are not integrated with process ownership or cancellation

**Affected workflows:** Archive Preview; Organize archive inspection and extraction; API shutdown and long-running archive safety checks.

**Evidence and root cause:**
- The lockfile pins node-7z@3.0.0. Inspection of that exact tag's src/lifecycle.js confirms that Seven.list/Seven.extractFull spawn a child process and store it on the returned stream's _childProcess; src/main.js starts and attaches the stream listeners before returning it. The package documents deferred/external-child hooks ($defer, $childProcess, Seven.listen), but the product call sites do not use a shared ownership adapter.
- routes/archives.ts peek7z and four routes/organize.ts listing/extraction call sites attach stream event handlers but do not call assertMediaProcessStartAllowed or register the child with trackActiveMediaProcess.
- In the Organize 7-Zip preflight, the first invalid entry calls the local fail function and rejects the wrapper promise; it does not stop the still-running listing child. Other listing paths retain a safety error and wait for the stream's end, so the configured archive entry/size budgets reject the result but do not stop 7-Zip work immediately after the first violation.
- The Organize SSE handler does not register request/response close handlers or expose an explicit active-operation cancellation path. A disconnected client therefore stops receiving progress but does not cancel the server-owned operation. This behavior must not be changed by automatically aborting destructive work on socket close.

**Status:** found; architecture/integration plan required. No partial process-tracking-only patch applied because it would not define cancellation semantics, child-close ordering, or cleanup ownership for extraction staging.

**Safe implementation plan:**
1. Add one adapter around the pinned node-7z stream API. Capture the spawned child immediately, reject starts after shutdown begins, register it with the existing media process owner, and resolve/reject only after both the child and stream lifecycle have settled.
2. Support an explicit AbortSignal for read-only archive preview. On the first archive-safety violation, terminate the listing child and await its close rather than consuming the rest of a hostile listing.
3. Keep Organize execution server-owned when an SSE client disconnects. Add an explicit, durable cancel request/state transition for mutating jobs; do not infer cancellation from a disconnected progress socket. Cancellation must stop 7-Zip, await child close, then clean staging and run the existing journal/rollback path under the current execution lease.
4. Wire every Seven.list and Seven.extractFull call site through the adapter. Ensure stream errors, child errors, abort, and server shutdown converge on one idempotent cleanup path.
5. Add fault-injection tests for shutdown during list/extract, preview disconnect, safety-budget rejection, child spawn/exit failure, cancellation during extraction, and the race between child close and staging cleanup. Run official 7-Zip integration tests on Linux and Windows before marking integration-tested.

**Remaining risk:** Archive preview and Organize 7-Zip operations can currently continue consuming CPU after a safety rejection or client disconnect; their child processes are not included in the shared shutdown registry. The fix must preserve the rule that an SSE disconnect does not silently cancel a destructive job.

### Validation snapshot for this batch

- **Code head:** fb293a5c296c5233ec2682e450461607d79f15aa.
- **PR #2:** open, draft, unmerged; base main at 694a055aeb10a41ee8e98f5b776faef89cbd449d; 188 changed files and 1,348 commits at this snapshot.
- **Branch comparison with main:** 1348 commits ahead, 1 behind.
- **Fast Validation [42255943324](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42255943324):** Linux validation job 128023065207 passed typecheck/generated contracts, release/storage checks, PostgreSQL conversion-lock/finalization integration, and 350 targeted tests (348 passed, 0 failed, 2 skipped). The Windows archive/updater job 128023913661 was still in progress at developer-updater preservation/rollback; no Windows result is claimed here.
- **Dependency Review [42255943232](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42255943232):** passed; the separate installed dependency-graph audit step was skipped.
- **Windows installer lifecycle [42255943133](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42255943133):** pending. Earlier lifecycle run [42254322661](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42254322661) remained in progress at the standard-user lifecycle step. No lifecycle pass is claimed.
- **Full CI:** not run; Fast Validation is not the full-repository CI suite.

**Next batch:** Complete Windows archive/updater and installer-lifecycle result diagnosis, then implement the node-7z ownership/cancellation adapter only after the explicit distinction between read-only preview abort and server-owned destructive Organize execution is covered by tests. Continue the conversion attempt-fencing design separately; do not add a token-only workaround.


## 2026-11-06 follow-up — hard media-tool timeout and Windows recovery failure diagnosis

### Fixed — Medium: media subprocess timeout now escalates beyond SIGTERM

**Affected workflows:** Optimize conversion, video/PDF/image thumbnail generation, 7-Zip version probing, FFprobe codec detection, and media-health probes.

**Evidence and root cause:** runMediaToolAsync previously relied only on child_process.execFile's timeout option. Node sends the configured kill signal (SIGTERM by default) when the timeout expires, but the runner had no escalation if a child handled/ignored SIGTERM. Since the promise settles only after the child-process callback, a stuck encoder could retain its request, worker slot, and conversion lock beyond the configured timeout. Existing timeout coverage used a child that exited when SIGTERM was delivered and did not exercise this case.

**Fix:** runMediaToolAsync now schedules a bounded SIGKILL escalation after a 2-second grace period beyond the configured timeout. It checks that the child still has a PID and is still running, and clears both timers on process close/error. The existing process registry remains the single owner; no dependency was added. Thumbnail and conversion callers write to temporary/staging paths and publish only after successful validation, so timeout cleanup does not overwrite original media.

**Regression evidence:** media-tools-async.test.ts launches a Node child that deliberately handles SIGTERM and would otherwise remain alive for 8 seconds. The runner rejected after the 2-second escalation window (2,209 ms) instead of waiting for the child's own timer.

**Status:** fixed; target-tested on Linux and Windows smoke.
- Fast Validation [42257114134](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42257114134), Linux validation job 128027130518: passed typecheck/generated contracts, PostgreSQL integration and targeted backend tests; 351 tests, 349 passed, 0 failed, 2 skipped. The new ignored-SIGTERM regression passed in 2,209 ms.
- The same Fast Validation run's Windows archive/updater job 128027885762 passed. The ignored-SIGTERM test was intentionally skipped on Windows because Windows terminates the child directly for this signal; the Windows archive/updater preservation and rollback smoke passed.
- Dependency Review [42257114045](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42257114045) passed; its separate installed dependency-graph audit step was skipped.

**Implementation/test commits:** 8808afbb4ec9833483997e2b41f976dcd909dece (SIGKILL escalation); bf3dc6ce88d80b014e555c0c8f5d118a255b9315 (ignored-SIGTERM regression).

**Remaining risk:** This hardens timeout handling but does not add per-job AbortSignal cancellation. A process-kill failure remains an exceptional OS-level case; conversion attempt fencing and job-to-child ownership still require the previously documented design.

### Confirmed — High: packaged Windows recovery cannot start after the install directory is moved

**Affected workflow:** Installed Windows upgrade/recovery, specifically interruption after the old installation directory is moved but before the candidate is swapped into place.

**Latest failure evidence:** Windows installer lifecycle run [42254322661](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42254322661), job 128019096052, failed during the “prepared-phase update recovery” stage. The script then timed out waiting for http://127.0.0.1:8080/api/healthz. The captured stderr states that PowerShell could not find C:\WillardLifecycle\wl_life_13288244\desktop\WillardMediaCenter.ps1.

**Root cause traced through product and test callers:**
- scripts/windows/installer-lifecycle-smoke.ps1 lines 276–295 intentionally move InstallRoot to a sibling backup, write a prepared journal, then call Invoke-InstalledLauncher.
- Invoke-InstalledLauncher (lines 105–108) constructs the launcher path as InstallRoot\desktop\WillardMediaCenter.ps1. That path no longer exists after the simulated move.
- This is not only a test-helper defect: installer/WillardMediaCenter.iss [Icons] and [Run] entries (lines 56–61) also point directly to {app}\desktop\WillardMediaCenter.ps1. Its [InstallDelete] section deletes {app}\desktop before copying the new payload (lines 39–42).
- The production recovery logic is inside desktop/WillardMediaCenter.ps1, whose InstallRoot is derived from its own path. It cannot execute if the entire directory containing it has been moved.

**Status:** found; blocked pending stable-bootstrap implementation. The test is exercising a real recovery gap; do not weaken or skip the prepared-phase scenario to make the workflow green.

**Safe implementation plan:** Install a small, version-independent bootstrap outside the replaceable {app} tree (for example, under the per-user LocalAppData application directory). Point Start Menu/desktop shortcuts and installer recovery entry points at that bootstrap. It must locate and validate the external update journal, restore the last known-good sibling backup when the live tree is absent, verify the restored launcher before handing off, and remain available until the uninstaller has safely stopped services and removed the payload. Preserve the current path-containment and no-overwrite checks. Add tests for missing live tree, prepared/backup-created/swapped journals, corrupt or redirected journals, repeated recovery, standard-user permissions, and uninstall. Do not merely change the lifecycle test to launch a different path.

**Current lifecycle status:** Windows installer lifecycle run [42257114207](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42257114207) was pending at this report snapshot on code head bf3dc6ce88d80b014e555c0c8f5d118a255b9315. No lifecycle pass is claimed.

### Validation snapshot

- **Code head:** bf3dc6ce88d80b014e555c0c8f5d118a255b9315.
- **PR #2:** open, draft, unmerged; base main; 188 changed files; 1,351 commits.
- **Comparison with main:** 1,351 commits ahead, 1 behind.
- **Full CI:** not run. Fast Validation and the Windows archive/updater smoke are not the complete installer lifecycle or full-repository CI.
- **Next batch:** resolve the external stable Windows bootstrap and rerun the full lifecycle workflow; then continue node-7z ownership/cancellation and conversion attempt-fencing. Keep read-only archive-preview cancellation distinct from server-owned destructive Organize jobs.


## November 6 — desktop database backup module parse failure and startup recovery regression

### Fixed — Critical (P1): malformed snapshot-release refactor prevented desktop startup and backup operations

**Affected workflows:** Installed Windows first startup and portable recovery-export creation; PostgreSQL backup/restore helper loading; Linux Fast Validation database-backup tests. This is a desktop packaging/runtime defect, not a production database or credential change.

**Evidence and root cause:** Fast Validation run [42258840028](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42258840028), job 128033213739, reached the release/storage-contract step and failed when Node parsed `desktop/database-backup.mjs` at line 372: `SyntaxError: Unexpected token ')'`. The installed Windows lifecycle run [42258840104](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42258840104), job 128034365366, independently reproduced the same parser error in the installed copy at `C:\\WillardLifecycle\\...\\desktop\\database-backup.mjs:372`. The installer compiled and installed, but first startup could not create the required portable recovery export and never reached the API health check or prepared-phase recovery scenario.

The source diff traced this to an incomplete refactor of `openDatabaseSnapshot`: the function had been changed to delegate snapshot acquisition and release to `waitForExportedSnapshot` and `releaseExportedSnapshot`, but the tail of the old inline timeout/close callback remained after the new `release()` method. The orphaned `}, 3000);` and child-close callback made the entire ES module unparsable. This was a real installed-product blocker, not a test-only failure.

**Fix:** Removed the obsolete callback fragment. `openDatabaseSnapshot` now returns the snapshot lease with a valid `release()` method that delegates to the existing shared process owner. No new process registry, dependency, or alternate timeout path was added.

**Regression coverage:** Added a focused source-contract test to `desktop/database-backup.test.mjs` verifying that the snapshot lease uses the shared acquire/release helpers and contains no stale inline timeout or child-close listener. The existing database-backup test module also imports the production module, so Node module parsing is exercised before the suite runs. The shared process helper retains its timeout, SIGTERM/SIGKILL escalation, close-race, output-bound, and stdin-error tests.

**Implementation/test commits:** `7c21a3e080af6f65c406dd673de903f06ea1da9b` (production syntax fix); `90358602bb8f01649c58bb9f0a9e78ba8039bf92` (initial regression test); `6665e37c92f034d6125ee0613be7283517444010` (corrected regression assertions).

**Status:** fixed; CI validation pending on the corrected code/test head. The previous Fast Validation failure was diagnosed as a source syntax defect, not an environment or dependency-install failure.

### Validation evidence and remaining risk

- **Fast Validation [run 42258840028](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42258840028), code head `767a1632822b2e5f03209632154e4aed203050cd`:** failed at `pnpm run test:database-backup`. Workspace typechecks/generated contracts, Expo CLI config, and desktop web-server safety checks completed before the failure. The database-backup module failed to parse; the separate snapshot-process tests reported 11 passed and 1 failed (the module-load failure). Later validation steps were skipped.
- **Windows installer lifecycle [run 42258840104](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42258840104), same code head:** installer build and install completed, then first startup failed at the same syntax error. The required portable recovery export was not created and the API health check was never reached. This run therefore does not validate or invalidate the separate prepared-phase recovery scenario.
- **Dependency Review [run 42258840118](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42258840118), same code head:** passed the production advisory gate; the separate installed dependency-graph audit was skipped.
- **Corrected code/test head `6665e37c92f034d6125ee0613be7283517444010`:** Fast Validation run [42265234092](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42265234092) was in progress; Windows installer lifecycle run [42265234139](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42265234139) was pending; Dependency Review run [42265234216](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42265234216) was queued. No pass is claimed for these runs at this snapshot.
- **Full CI:** not run. Fast Validation, Dependency Review, and the dedicated Windows lifecycle workflow are separate scopes and do not constitute full-repository CI.

**Remaining high-priority risks:** The previously confirmed stable-bootstrap gap remains unresolved: prepared-phase recovery cannot launch when the entire install directory has been moved because the recovery launcher and shortcuts are inside that directory. The current lifecycle failure occurred before that scenario, so the bootstrap fix remains blocked and unvalidated. The node-7z child ownership/cancellation and conversion attempt-fencing findings remain open as documented above.

**Next batch:** Confirm the new Fast Validation run, then rerun the installed Windows lifecycle through first startup, upgrade, prepared-phase recovery, standard-user permissions, and uninstall. Preserve the prepared-phase scenario; do not weaken the test. If startup proceeds, diagnose the next actual lifecycle failure before designing the stable external bootstrap. Continue the node-7z process ownership/cancellation work after the installer blocker is isolated.


## November 6 follow-up — conversion worker can outlive its database ownership lock

### Confirmed — High: stale conversion workers are not fenced from retries or shared staging

**Affected workflows:** Optimize Center conversion execute/retry/cancel/finalize; API restart recovery; multi-instance operation and rolling restarts. This is a data-integrity and job-state ownership risk. Original media is staged/untouched during conversion, but stale workers can overwrite staged outputs, publish stale job results, or race a newer attempt's finalization.

**Root cause traced through callers, schema, process ownership, and tests:**

- `artifacts/api-server/src/lib/conversion-job-lock.ts:25-44` acquires a PostgreSQL session advisory lock on a dedicated checked-out pool client. PostgreSQL correctly releases that lock when the session disconnects. The lock helper does not own or terminate the JavaScript request or its FFmpeg child when that happens.
- `conversion-recovery.ts:17-38` treats an available advisory lock as evidence that a `running` job is abandoned and marks it failed. That is correct for a dead worker, but a lost lock connection does not prove that the separate API request or child process has stopped.
- `routes/optimize.ts:1683-1723` tracks only a process-local request count, acquires the lock, then claims the row. There is no listener/abort path that stops the worker when the lock connection is lost.
- `routes/optimize.ts:1291-1318` retries the same row by resetting it to `pending`, clearing `resultJson`, and resetting counters. It does not increment an attempt generation or allocate a new attempt identity.
- `routes/optimize.ts:1793-1796` uses the shared staging path `WillardAI/conversions/<jobId>`. A retry therefore reuses the same staging directory. A previous request that is still alive can write to the same staged filename as the new request.
- Numerous progress updates in `routes/optimize.ts:1837-2000` filter only by job ID. The final result/status write at lines 2032-2035 also filters only by job ID. The catch path at lines 2051-2061 filters by job ID and `status = running`; if a newer retry has already claimed the row, the stale worker can still match that status and mark the newer attempt failed. These writes are not fenced by a generation or owner token.
- `conversion_jobs` schema (`lib/db/src/schema/conversion_jobs.ts:1-22`) contains no attempt ID, generation, or owner token.
- `media-tools.ts:41-44, 59-75, 107-123, 159-226` provides a global child-process registry and timeout/shutdown handling, but `MediaToolExecutionOptions` has no `AbortSignal` or attempt owner. The registry cannot cancel only the child processes belonging to a particular conversion attempt.
- The cancel endpoint records `cancelledAt`; the worker checks it between files and after a completed conversion. That cooperative behavior preserves completed staged outputs, but it does not provide a per-attempt process cancellation path if ownership is lost.
- Existing `conversion-job-lock-postgres.test.ts` verifies lock serialization and automatic lock release after disconnect. `conversion-recovery.test.ts` verifies that recovery skips a locked job. Neither keeps an old worker/child alive after deliberately dropping its lock and then races recovery plus retry. The finalization tests cover per-move journal recovery, not cross-attempt fencing.

**Status:** found; architecture required. No partial token check or cleanup workaround was applied. Clearing the shared staging directory on retry would be unsafe while a stale worker may still be alive, and adding only a post-process status check would not prevent stale filesystem writes.

**Safe implementation plan:**

1. Add a monotonically increasing `attempt_generation` (or immutable attempt UUID) to `conversion_jobs`. Increment it atomically in the pending-to-running claim and return the generation to the worker. Include it in the durable job result and all finalization journal records.
2. Give each attempt a unique, exclusively created staging directory, e.g. `WillardAI/conversions/<jobId>/<attemptId>`. Never reuse or eagerly delete another attempt's staging tree. Preserve abandoned attempts until recovery proves they are safe to remove or the user explicitly clears them.
3. Fence every progress, result, error, cancellation, and final-status write with `id + attempt_generation + expected status`. A stale worker must receive a zero-row result and stop; it must never overwrite the new attempt's state.
4. Bind every spawned media child to an attempt-scoped `AbortController`/owner registry. Monitor the advisory-lock connection's error/end/close events; loss of the lock must abort the attempt and terminate only its children with bounded SIGTERM/SIGKILL escalation. Retain the database generation fence as the authority even if process termination is delayed.
5. Before every filesystem mutation during finalization, revalidate the attempt generation and lock ownership. Persist intent and verified completion with the attempt ID; preserve the existing no-overwrite/hash checks and unresolved-move journal. Recovery must reconcile only the matching attempt and must not clear a newer attempt's journal.
6. Make retry allocate a new attempt identity only after recovery has fenced the previous attempt. Keep per-file staged-result checkpoints durable so a crash after a successful conversion does not orphan its verified output.
7. Add PostgreSQL fault-injection tests that drop the lock connection while an FFmpeg child remains alive, run recovery and a retry, and prove that the old worker cannot update the new row, write into the new staging directory, or finalize files. Also test crash points before/after each durable finalization intent/completion checkpoint and cancellation during a long-running child.

**Validation gap:** Source inspection only for this finding. Existing advisory-lock/recovery tests do not cover the stale-worker interleaving described above. This requires the generation/staging/process-ownership design and PostgreSQL concurrency tests before it can be marked fixed.

**Current validation snapshot at investigation:** PR #2 remained open/draft on branch `audit/full-repository-review-2026-11`. Fast Validation run [42265345413](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42265345413) was pending/in progress, Windows installer lifecycle run [42265345436](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42265345436) was pending, and Dependency Review run [42265345459](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42265345459) was in progress on head `dd9f65bf2e6d7c461005c83c0605c27b0d9fbfaf`. No result is inferred from those states.

**Investigation/report commit:** `dd9f65bf2e6d7c461005c83c0605c27b0d9fbfaf` (ledger update only). No conversion product code was changed in this batch.


## November 6 follow-up — Fast Validation concurrency was cancelling Windows coverage

### Fixed — Medium: new PR commits cancelled the in-progress Windows archive/updater validation

**Affected workflow:** `.github/workflows/fast-validation.yml`, especially the Windows `windows-archive-and-updater-smoke` job that installs the API-server test dependency graph and then exercises Windows archive, storage, media-process, and updater behavior.

**Failure evidence:** Fast Validation run [42265345413](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42265345413) on code/test head `dd9f65bf2e6d7c461005c83c0605c27b0d9fbfaf` completed its Linux `validate` job successfully, but the Windows job was cancelled during `pnpm install --filter @workspace/api-server... --frozen-lockfile --ignore-scripts --no-optional`. Its log ends with `##[error]The operation was canceled.` at 17:53:16 UTC. The audit-ledger commit `704631bf79569ba3f90064cc7d8483ae73e90904` had been pushed at 17:53:08 UTC, and the workflow's concurrency policy was `cancel-in-progress: true`. The newer PR run superseded the active Windows validation; the package installation log showed no dependency-resolution error.

**Root cause:** The Fast Validation workflow's ref-level concurrency group cancelled the entire running validation whenever another commit was pushed to the PR. Unlike the dedicated Windows installer lifecycle workflow, Fast Validation had not been changed to preserve an already-running job. Documentation-only audit-ledger commits were therefore interrupting the Windows dependency install and preventing the full Windows smoke scope from completing.

**Fix:** Changed `cancel-in-progress` to `false` in `.github/workflows/fast-validation.yml`, matching the non-cancelling lifecycle workflow policy. The running validation is now allowed to finish; GitHub may replace an older *pending* run with the newest pending run, but it should not cancel the active run merely because another audit commit arrives.

**Commit:** `da327bd5fa6a29fc32a676334dbb033daf47be08`.

**Status:** fixed by source/workflow inspection; regression evidence pending the next overlapping run. The currently running Fast Validation run [42265708345](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42265708345) started on the preceding head `704631bf79569ba3f90064cc7d8483ae73e90904`; the new policy commit was pushed while it was running. Confirm that it completes rather than being cancelled before marking this workflow fix target-tested.

### Validation snapshot after the database-backup syntax fix

- **Fast Validation [run 42265345413](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42265345413), code/test head `dd9f65bf2e6d7c461005c83c0605c27b0d9fbfaf`:** Linux `validate` job passed. Workspace typechecks/generated contracts and Expo/desktop safety checks passed. `pnpm run test:database-backup` passed 33/33, including the new snapshot-lease ownership regression; `postgres-snapshot-process.test.mjs` passed 85/85. PostgreSQL media-query validation passed 6/6, advisory-lock integration passed 1/1, conversion finalization recovery passed 2/2, and the targeted backend batch passed 351 tests (349 passed, 0 failed, 2 skipped). The Windows archive/updater job was cancelled during dependency installation by the concurrency behavior described above; no Windows pass is claimed for this run.
- **Dependency Review [run 42265345459](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42265345459), same code/test head:** passed production advisory checks; the separate installed dependency-graph audit was skipped.
- **Later Fast Validation [run 42265708345](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42265708345), head `704631bf79569ba3f90064cc7d8483ae73e90904`:** Linux validation was in progress at this snapshot. Its Windows job had not yet completed. This run predates the non-cancelling workflow commit.
- **Windows installer lifecycle:** run [42265345436](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42265345436) was cancelled while pending when a newer pending run replaced it; run [42265706819](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42265706819) was the latest pending lifecycle run at this snapshot. The lifecycle workflow already has `cancel-in-progress: false`; pending-run replacement is GitHub's one-pending-run concurrency behavior, not a product test failure.
- **Full CI:** not run. Fast Validation, Dependency Review, and Windows installer lifecycle remain distinct validation scopes.

**Next batch:** Verify the active Fast Validation run survives the next commit and completes its Windows archive/updater smoke; verify the newest lifecycle run starts and reaches installed first startup. Then address the stable external Windows bootstrap design and continue the generation-fenced conversion-worker work. Do not treat the cancelled Windows job as passed.


## November 6 status correction — thumbnail subprocesses are already asynchronous

The earlier finding under **“On-demand thumbnail generation still blocks the API event loop”** is stale for the current audit branch and should not be treated as an open defect.

**Current source evidence:** `artifacts/api-server/src/lib/thumbnail-engine.ts` imports `runMediaToolAsync` and `formatMediaToolExecutionError`; video, PDF, and FFmpeg image-fallback generation all await the shared runner (current source lines 241–312). The file contains no `spawnSync` call. Video frame scratch output is removed in a `finally` path, and the existing per-thumbnail lock plus atomic publish path remains in place.

**Regression coverage:** `artifacts/api-server/src/__tests__/media-tools-async.test.ts` asserts the thumbnail engine does not use synchronous FFmpeg spawning and that video/PDF generation awaits the asynchronous runner. The thumbnail cache/publication suite also exercises concurrent requests, corrupt cache replacement, partial cleanup, and cache reuse.

**Validation:** Fast Validation run [42265708345](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42265708345), Linux `validate` job 128056974463, passed the targeted backend batch (351 tests: 349 passed, 0 failed, 2 skipped). The Windows archive/updater job in the same run was still in progress at this snapshot; no Windows result is claimed.

**Status:** fixed; target-tested on Linux. The async refactor is already part of the existing PR diff; its exact introducing commit was not isolated during this pass, and no new thumbnail code was changed. Keep request-abort/per-thumbnail cancellation and process-tree ownership as separate remaining design questions; the current fix covers event-loop responsiveness and shared shutdown ownership, not attempt-scoped cancellation.


## November 6 — organization preflight destination-capacity check made asynchronous and fail-closed

### Fixed — High: per-destination disk-space probe blocked the API and failed open on non-GNU systems

**Affected workflow:** Organize Center preflight for archive/folder jobs, especially Windows and NAS/SMB destinations with nested mounts or unavailable shares.

**Evidence and root cause:** `routes/organize.ts` used `spawnSync("df", ["-B1", checkDir])` in the preflight request, with no timeout. A slow or disconnected network filesystem could hold the API event loop while `df` waited on the mount. The command is GNU-specific and unavailable on Windows/macOS; on those systems the helper returned `null`, but the route initialized `diskOk = true` and treated an unknown per-destination capacity result as a passing check. The existing `evaluateCapacity` call checks the configured NAS root, not every unique destination filesystem, so a full nested mount could be missed.

**Fix:** Reused the existing `capacity-service` asynchronous `fs.promises.statfs` provider through new `probeFilesystemCapacity`. Organization preflight now uses asynchronous `fs.promises.stat`/`realpath` for destination path resolution, awaits the per-filesystem capacity probe, and fails closed if the path or free space cannot be measured. Removed the synchronous `df` child process and its import. No new dependency or parallel capacity subsystem was added.

**Regression coverage:**
- `capacity-service.test.ts`: injected known/unknown destination probes and a real default filesystem probe against the current platform's temporary directory.
- New `organize-preflight-capacity.test.ts`: verifies preflight awaits the per-destination probe, uses async path checks, and does not pass when free space is unknown.
- Fast Validation now runs both tests on Linux and Windows.

**Commits:** `1f98f02437b38305df9c51566d14e77d8ed8d5fb` (shared probe); `3cce8c673187063bdb74781f660f9894070cd92c` (probe tests); `33978312046d37ca8fc4d82a4ec21495627a1c42` (preflight fix); `1b290916e748bf58cfa4325b07b7dc122880d540` (route regression test); `60e18c7cf6bad3dd067f111854db5be6522c60f7` (Linux/Windows CI coverage).

**Status:** fixed; targeted and Windows validation pending on the latest code head. Fast Validation run [42266842331](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42266842331) was in progress on head `60e18c7cf6bad3dd067f111854db5be6522c60f7`; its Linux job had started and its Windows archive/updater job had not yet completed. Dependency Review [run 42266842234](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42266842234) passed the production advisory gate; the separate installed dependency-graph audit was skipped.

### Validation follow-up — database-backup fix and Fast Validation concurrency

- Fast Validation [run 42265708345](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42265708345) on head `704631bf79569ba3f90064cc7d8483ae73e90904` completed successfully. Linux `validate` job 128056974463 passed typechecks/generated contracts, desktop/Expo checks, release/storage contracts, PostgreSQL media LIKE checks, conversion advisory-lock integration, finalization recovery, and targeted backend regressions. The database-backup suite passed 33/33 and the snapshot-process suite passed 85/85; the targeted backend batch passed 351 tests (349 passed, 0 failed, 2 skipped).
- The Windows `windows-archive-and-updater-smoke` job 128057682197 also completed successfully. It passed launcher PowerShell parsing (20 scripts), single-instance startup, orphan-service handling, UTF-8 environment creation, media rename/no-overwrite, non-blocking media process checks, storage migration, NAS temp cleanup, conversion finalization rollback, official Windows 7-Zip symlink/TAR checks, updater journal writes, and developer updater preservation/rollback. Its update-preparation error messages were expected negative-path assertions; the final log states: `Windows updater smoke passed: full-version update, preservation, and rollback.`
- Fast Validation [run 42266208602](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42266208602) on head `bc455b61d076064d7e39d868faa1b3601fcf3210` also completed successfully on Linux and Windows. This run continued while newer audit commits were pushed, confirming that the `cancel-in-progress: false` change in `da327bd5fa6a29fc32a676334dbb033daf47be08` prevents a new PR commit from cancelling an already-running Windows validation. Newer pending runs were replaced by the latest pending run, as GitHub's one-pending-run concurrency rule allows.
- These Fast Validation runs are not full CI and do not replace the dedicated installed Windows lifecycle workflow. The latest lifecycle run [42266842470](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42266842470) was pending at this snapshot; no installed first-start or prepared-phase recovery result is claimed.
- **Full CI:** not run.

**Next batch:** Finish Fast Validation run 42266842331 on the new capacity code and verify the Windows capacity-probe step. Then let the latest Windows installer lifecycle run start; it must get beyond installed first startup now that the module parse defect is fixed. Continue with the stable external bootstrap design and attempt-fenced conversion worker architecture; do not weaken recovery tests.


### Capacity-preflight validation update — target tests passed on Linux and Windows

Fast Validation run [42266842331](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42266842331) on code head `60e18c7cf6bad3dd067f111854db5be6522c60f7` has now completed its Linux `validate` job 128061473992 successfully. The targeted backend batch reported 355 tests, 353 passed, 0 failed, and 2 skipped. The new tests passed explicitly: per-destination known/unknown capacity probe behavior, the real default `fs.promises.statfs` probe against the runner's platform filesystem, and the organization-preflight source contract.

The same run's Windows `windows-archive-and-updater-smoke` job 128062355978 has passed its new **“Verify organization capacity probes on Windows”** step (step 10), including the real Windows temporary-filesystem `statfs` probe. All preceding Windows launcher, dependency-install, media, storage, NAS cleanup, conversion finalization, and official 7-Zip/TAR steps also passed. The final developer-updater preservation/rollback step was still in progress at this update, so the Windows job and overall Fast Validation run are not yet marked complete.

**Status:** capacity fix is now target-tested on Linux and Windows; full Fast Validation completion remains pending. The separate Windows installer lifecycle run [42267164897](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42267164897) was still installing isolated PostgreSQL 16; it had not yet reached installer build or first-start/recovery testing.


### Final Fast Validation result — both Linux and Windows jobs passed

Fast Validation run [42266842331](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42266842331) on exact code head `60e18c7cf6bad3dd067f111854db5be6522c60f7` completed successfully: Linux `validate` job 128061473992 and Windows `windows-archive-and-updater-smoke` job 128062355978 both concluded `success`.

The Windows job completed its developer-updater preservation/rollback step. Its final log confirms: `Windows updater smoke passed: full-version update, preservation, and rollback.` The run also passed the new Windows organization-capacity step, official 7-Zip symlink metadata and compressed TAR preview checks, storage/NAS cleanup checks, conversion finalization no-overwrite/rollback checks, and launcher/media subprocess checks.

**Status:** the organization destination-capacity fix is target-tested on Linux and Windows; the full Fast Validation workflow passed for this code head. This is not full-repository CI and does not test a real disconnected SMB/NAS mount. The latest branch head is a later documentation-only commit, so this pass is attributed to code head `60e18c7cf6bad3dd067f111854db5be6522c60f7`, not the later ledger commit.

The dedicated Windows installer lifecycle run [42267164897](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42267164897) was still in its installer build/compile step. It had not yet run standard-user install, installed first startup, prepared-phase recovery, diagnostics, or uninstall. No lifecycle result is claimed.


## November 6 — Windows prepared-phase lifecycle failure reproduced; test harness now fails fast on missing launcher

### Confirmed High (P1): installed recovery cannot start after the entire versioned install directory is moved

**Affected workflow:** Windows installer upgrade recovery after interruption in the `prepared` phase, specifically the interval after the previous install tree has been moved to its sibling backup and before the new candidate is activated.

**Evidence and root cause:** Windows installer lifecycle run [42267809733](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42267809733), exact tested head `e8b42bba1b31890f7cf28b9e39e3b73493cf9567`, job `128067482740`, completed the unsigned installer build, standard-user install, first start, upgrade, post-upgrade start, and simulated `swapped`-phase recovery. It then failed in **prepared-phase update recovery** at `scripts/windows/installer-lifecycle-smoke.ps1:295`, timing out while waiting for `http://127.0.0.1:8080/api/healthz`.

The lifecycle fixture explicitly moves `$InstallRoot` to `$preparedBackup` before invoking the installed launcher. The recovery launcher remains at `$InstallRoot\desktop\WillardMediaCenter.ps1`, inside the directory that has just been moved. There is no stable executable bootstrap outside that tree to read the journal and restore the backup. This confirms the previously documented product recovery gap; the prepared-phase test is not to be weakened or skipped.

**Status:** blocked pending the stable external bootstrap architecture. **Commit:** none for the product recovery design. **Remaining risk:** a power loss in this update window can leave the installed product unable to start its own recovery. Preserve the existing path-containment, journal validation, no-overwrite, and prior-version health-check rules in the eventual implementation.

### Fixed — Medium: lifecycle test harness masked a missing launcher as a later health timeout

**Affected workflow:** Windows installed-product lifecycle diagnostics, especially missing-tree recovery tests.

**Evidence and root cause:** `Invoke-InstalledLauncher` constructed the launcher path and immediately spawned PowerShell. The generated child runner invoked `& $Launcher` without first verifying that the packaged launcher existed and without setting a fail-fast error preference. When the install tree was absent, the harness could proceed to its 150-second HTTP health wait and report a timeout instead of identifying the missing executable at the point of invocation.

**Fix:** The parent helper now checks the exact launcher path with `Test-Path -LiteralPath ... -PathType Leaf` before spawning the child. The generated runner repeats that check and sets `$ErrorActionPreference = "Stop"`, so a path disappearing between the parent check and child launch also fails immediately with an explicit path diagnostic. This is a test-harness reliability fix only; it does **not** implement or claim to fix the missing stable product bootstrap.

**Regression coverage:** `scripts/windows/installer-config.test.mjs` asserts both fail-closed guards and that each guard runs before the launcher invocation.

**Commit:** `be8f472e55c82f15aae16af2ad33870960f82c33`. **Status:** fixed; targeted/Windows validation pending for this exact commit. **Remaining risk:** the actual prepared-phase recovery remains blocked as described above.

### Validation snapshot before the diagnostic-harness commit

- Fast Validation [run 42267810148](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42267810148) on `e8b42bba1b31890f7cf28b9e39e3b73493cf9567`: Linux `validate` job `128065982436` passed; Windows `windows-archive-and-updater-smoke` job `128066736846` passed. The Linux job included typechecks/generated contracts, Expo/desktop safety, release/storage contracts, PostgreSQL media-query and conversion-lock/finalization checks, and the targeted backend regression batch. The Windows job included launcher parsing, startup ownership, organization capacity, media rename/process responsiveness, storage migration, NAS cleanup, conversion rollback, official 7-Zip link metadata, compressed TAR preview, and updater preservation/rollback.
- Dependency Review [run 42267809670](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42267809670): production advisory gate passed; the separate installed dependency-graph audit was skipped.
- Windows installer lifecycle [run 42267809733](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42267809733): failed at prepared-phase recovery as detailed above. It is not a lifecycle pass.
- These runs predate the diagnostic-harness commit `be8f472e55c82f15aae16af2ad33870960f82c33`; no test result is attributed to that commit until a matching run completes.
- **Full CI:** not run. Fast Validation, Dependency Review, and the dedicated Windows installer lifecycle remain distinct scopes.


## November 6 — packaged Windows install root overlaps the persistent data root

### Confirmed Critical (P1): default installer path makes the self-updater move its own user data and recovery journal

**Affected workflows:** Default per-user Windows installation, automatic self-update, interrupted-update recovery, local configuration/backup-credential preservation, and uninstall/repair.

**Source evidence:**

- `installer/WillardMediaCenter.iss` sets `DefaultDirName={localappdata}\Willard Media Center` (the default `{app}` path).
- `desktop/WillardMediaCenter.ps1` derives `$InstallRoot` from the installed launcher path, but independently sets `$DataRoot = Join-Path $env:LOCALAPPDATA "Willard Media Center"`. Under the default installer path, these resolve to the same directory.
- The launcher stores `$UpdateJournal` under `$DataRoot\updates\swap-journal.json` and keeps the local `.env`, logs, backup-protection material, and update staging under that same data root.
- `Invoke-PackagedVersionSwap` writes the journal, then moves the entire `$InstallRoot` to a sibling backup before moving the release candidate into `$InstallRoot`. The candidate is a versioned application payload, not a copy of the user's persistent data.
- The installer comment says user data is outside `{app}`, but that statement is false for the current default path.
- The lifecycle fixture does not expose this collision: `scripts/windows/installer-lifecycle-smoke.ps1` sets `$InstallRoot = Join-Path $env:SystemDrive "WillardLifecycle\\$UserName"` while `$DataRoot` remains under the disposable user's `LOCALAPPDATA\Willard Media Center`. Its external-data preservation checks therefore run with distinct paths, unlike a normal default installation.

**Root cause and impact:** The packaged installer uses the same per-user directory for the replaceable application tree and persistent data. During a self-update, moving `$InstallRoot` also moves the data root and the journal that the next launcher expects at the canonical `$DataRoot` path. If the process is interrupted after that move, the next launch starts from the new candidate tree, cannot find the journal at its expected path, and has no stable launcher outside the moved tree to discover/restore the backup. The previous backup can retain the old `.env`, local backup-protection credential, logs, and update journal, but those files are no longer at the paths the new installation reads. The external PostgreSQL database and media directory are separate; this finding concerns local configuration and recovery state, not a claim that those external stores were moved.

**Status:** found; blocked pending a coordinated installer/data-layout migration. No product-path change was made in this batch because a partial path edit could strand existing installations or destroy the only recovery journal.

**Safe implementation plan:**

1. Define and enforce two distinct canonical paths: a versioned application payload directory and a stable per-user data directory. Reuse the existing `LOCALAPPDATA\Willard Media Center` location for persistent data only; put the replaceable payload in a separate child or sibling directory. Ensure the paths remain on the same volume where atomic sibling swaps are required.
2. Move the update journal, download/staging area, backup-protection material, `.env`, and logs outside the replaceable payload. Validate journal paths against the canonical install parent and reject reparse-point/path redirection before any move or cleanup.
3. Install a small version-independent bootstrap under the stable data root. Point Start Menu, desktop, first-run, repair, and recovery entry points at that bootstrap. It must recover from a missing live payload using only a validated external journal and sibling backup; it must not depend on a launcher inside the tree being moved.
4. Design an explicit one-time migration for existing users whose legacy `{app}` and data root are identical. Stop the old services using the old install path, preserve every known data item (including unknown user-created files), install the new payload location, and retain the legacy tree/backup until the new launcher and health checks prove the migration succeeded. Do not infer that a directory is disposable merely because it is under the old `{app}`.
5. Make uninstall stop services through the stable bootstrap, remove only the versioned application payload and shortcuts, and preserve the stable user data root by default. Any user-data wipe must be a separate explicit action with a clear warning.
6. Change the Windows lifecycle test to install at the exact default path. Assert `InstallRoot` and `DataRoot` are distinct; verify `.env`, backup-protection marker, update journal, logs, external PostgreSQL marker, and media marker survive successful upgrade, each injected crash phase, repair, and uninstall. Include a legacy-layout migration fixture and standard-user ACL checks.

**Remaining risk:** High and unresolved. The current default packaged install can strand its local configuration and recovery journal during an interrupted self-update. The previously documented stable-bootstrap issue and this install/data-root collision are related but distinct: fixing only the bootstrap without separating the persistent data root would still leave the journal and user data inside the replaceable tree.

### Validation snapshot for the diagnostic-harness commit

- Fast Validation [run 42274282530](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42274282530), code/test head `be8f472e55c82f15aae16af2ad33870960f82c33`: Linux `validate` job `128086474928` completed successfully. Typechecks/generated contracts, Expo/desktop checks, release/storage contracts, PostgreSQL media-query and conversion-lock/finalization integration checks, and targeted backend regressions completed. The targeted batch reported 355 tests, 353 passed, 0 failed, and 2 skipped. The new lifecycle missing-launcher regression passed. The Windows archive/updater job `128087265574` was still running at this report update; no Windows result is claimed yet.
- Windows installer lifecycle [run 42274282416](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42274282416), same code/test head: job `128086475632` was still compiling the unsigned installer; the installed lifecycle stages had not yet run.
- Dependency Review [run 42274282218](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42274282218): production advisory gate passed; the separate installed dependency-graph audit was skipped.
- The latest branch head at this update is documentation-only commit `f8912e741e5a0960b52c3d3e6f3905410ebadba8`; matching workflows for that head were pending. Results above are attributed only to the exact code/test head `be8f472e55c82f15aae16af2ad33870960f82c33`.
- **Full CI:** not run. Fast Validation, Dependency Review, and installed Windows lifecycle validation are separate scopes.


## November 6 — avoid repeating the expensive Windows lifecycle build for docs-only PR synchronizations

### Fixed — Medium: PR-wide path filtering reran installer lifecycle on audit-ledger-only commits

**Affected workflow:** Windows installer lifecycle CI cost and feedback time; no product runtime behavior.

**Evidence and root cause:** The lifecycle workflow had both a branch-specific `push` trigger with a path filter and a `pull_request.synchronize` trigger with the same paths. GitHub evaluates a pull-request path filter against the overall PR diff, not only the newest commit. The audit PR currently contains 191 changed files including installer inputs. A documentation-only ledger commit `f8912e741e5a0960b52c3d3e6f3905410ebadba8` therefore still created a pending Windows installer lifecycle run [42274363837](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42274363837), even though that commit changed only the audit report. This repeats a costly unsigned installer build for no installer-code change.

**Fix:** The PR trigger now runs on `opened` and `reopened`; subsequent branch commits are handled by the existing branch-specific `push` trigger, whose path filter is evaluated for the pushed commit. The job's branch/base guard, Windows lifecycle coverage, manual dispatch, read-only permissions, and non-cancelling concurrency remain unchanged. The installer configuration regression test now asserts that `synchronize` is absent from the PR trigger and that the branch push trigger remains present.

**Commit:** `bacce51da775563e3eaab04d2f079faa6b8de3d9`. **Status:** fixed; targeted validation pending for this exact workflow/test commit. **Remaining risk:** this workflow-scope change must be confirmed by the next installer-related branch push; the available commit-run listing exposes PR-triggered runs only, so no unobserved push-run result is claimed.

### Validation update — diagnostic lifecycle guard

- Fast Validation [run 42274282530](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42274282530), code/test head `be8f472e55c82f15aae16af2ad33870960f82c33), completed successfully. Linux `validate` job `128086474928` passed typechecks/generated contracts, Expo/desktop checks, release/storage contracts, PostgreSQL media-query and conversion-lock/finalization checks, and targeted regressions (355 tests: 353 passed, 0 failed, 2 skipped). The new lifecycle missing-launcher test passed.
- The same Fast Validation run's Windows `windows-archive-and-updater-smoke` job `128087265574` passed. Logs confirm 20 PowerShell scripts parsed; launcher mutex and developer process ownership checks passed; Windows organization capacity, media rename/process shutdown, storage migration, NAS cleanup, conversion finalization, official 7-Zip 26.05, node-7z symlink metadata, compressed TAR preview, updater journal validation, and developer-updater preservation/rollback passed.
- Dependency Review [run 42274282218](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42274282218) passed the production advisory gate; the separate installed dependency-graph audit was skipped.
- Windows installer lifecycle [run 42274282416](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42274282416) remained in the unsigned installer build/compile step at the last inspection. It had not reached standard-user install, prepared-phase recovery, or uninstall; no installed-product result is claimed.
- For the new workflow/test commit `bacce51da775563e3eaab04d2f079faa6b8de3d9`, Fast Validation [run 42275019531](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42275019531) was pending and Dependency Review [run 42275019537](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42275019537) had passed the advisory gate. No matching Fast Validation result is claimed yet.
- **Full CI:** not run. These targeted Linux/Windows validation workflows and Dependency Review are not the full repository CI.


## November 6 — bind authenticated sessions to the credential version

### Confirmed High (P1): a late session-store upsert can resurrect a session after password reset

**Affected workflows:** API authorization, login/session management, password change, recovery-key reset, session inventory, and destructive organization/optimization actions protected by one-time action tokens.

**Evidence and root cause:**

- artifacts/api-server/src/app.ts updates sess.lastSeenAt on every authenticated API request. Express-session persists modified sessions when the response finishes.
- artifacts/api-server/src/lib/action-tokens.ts also mutates session.actionTokens and explicitly calls req.session.save(). Current callers include organization execute/resume and optimization execute.
- The pinned connect-pg-simple@10.0.0 store's set() uses INSERT ... ON CONFLICT (sid) DO UPDATE. A late save can therefore recreate a session row after another request has deleted it.
- artifacts/api-server/src/routes/auth.ts correctly updates the password and deletes all session rows in one transaction, but the global authorization middleware previously checked only the authenticated flag and inactivity timestamp. It did not bind a stored session to the password credential that created it.

**Confirmed race:** Request A passes authentication and begins work. Request B changes the password or consumes the recovery key and commits DELETE FROM session. Request A then persists its modified session; the session store's upsert recreates the old row. A later request can load that row with authenticated=true and a fresh activity timestamp, defeating the intended session revocation.

**Fix — commits:** implementation/tests a3e25f38c633b9635a359daa49f97df80dadf186; source-assertion correction fd99adc2c3fda0cef125ab68a763fe2acdacd0dd.

- New sessions now store the settings-row id and a SHA-256 fingerprint of the current bcrypt password hash. The bcrypt hash itself is not copied into the session.
- The global API authorization middleware checks the current database password hash against the session fingerprint before any protected route runs. Missing, malformed, or stale fingerprints are rejected and the stale session is destroyed; database verification failures fail closed with HTTP 503.
- /auth/status now reports stale sessions as unauthenticated and clears their cookie.
- /auth/sessions lists only sessions belonging to the current credential version, so a late-resaved but invalid session is not presented as active.
- Existing sessions created before this change have no credential fingerprint and will be invalidated once after upgrade; users will need to log in again.
- Added focused fingerprint/current-credential tests and a source-level regression that verifies the session stamp, API guard ordering, status behavior, and session-list filter.

**Status:** fixed; target-tested on code/test commit 7e185ba807503bf7975af6c58e994c75f4ac71e0 by Fast Validation run 42284916889. The later 009faac4883931ffd619fc2b0e74e9523165a66b commit changes only this audit ledger; validation for that documentation-only head was queued separately.

**Remaining risk:** The credential fingerprint closes late-save resurrection after password change/recovery, but it does not protect explicit logout or targeted session revocation. Those routes still delete session rows without a durable revocation tombstone; a concurrent request can upsert the same SID with the unchanged credential fingerprint and make it valid again. This separate High (P1) finding is documented below. Already-authorized in-flight operations can also finish; cancellation needs request/job fencing.

### Validation snapshot — credential-version fix

- Fast Validation [run 42275249021](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42275249021) passed on prior head 8ae002499d8ead4480b92e46ec74e9c6a290c142: Linux typecheck/generated-contract and targeted backend steps passed; Windows archive/updater smoke passed. This is baseline evidence only, not validation of the credential-version change.
- Fast Validation [run 42284276873](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42284276873) was started for implementation commit a3e25f38c633b9635a359daa49f97df80dadf186; its source-assertion test was corrected in the subsequent commit fd99adc2c3fda0cef125ab68a763fe2acdacd0dd. No result from the earlier run is attributed to the corrected head.
- Fast Validation [run 42284372360](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42284372360) is pending on corrected head fd99adc2c3fda0cef125ab68a763fe2acdacd0dd.
- Dependency Review [run 42284372391](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42284372391) is in progress on the same corrected head.
- **Full CI:** not run.

## November 6 — prepared-phase Windows recovery failure confirmed by installed-product logs

### High (P1): the installed product has no stable launcher when the live payload directory is moved

**Affected workflow:** Windows self-update, interrupted-update recovery, and standard-user installed-product startup.

**Evidence:** Windows installer lifecycle [run 42275010242](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42275010242), push commit bacce51da775563e3eaab04d2f079faa6b8de3d9, job 128090382407, failed in the installed-product exercise after the unsigned installer compiled successfully. The exact log reports:

**Lifecycle failure during prepared-phase update recovery:** Installed launcher is missing before start: C:\WillardLifecycle\wl_life_da6f085f\desktop\WillardMediaCenter.ps1

The PR-triggered rerun [42274780057](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42274780057), job 128092163188, failed at the same prepared-phase step with the same missing-launcher condition. The fail-fast check added to the lifecycle harness is working as intended; this is not a generic health-endpoint timeout or a false-positive test failure.

**Root cause:** The test simulates the real interruption point after the previous installation directory has been moved to its backup but before the candidate is moved into the live path. The next start is still directed to the launcher inside the now-missing live directory. No stable bootstrap exists outside that replaceable directory to read the journal and restore the backup.

**Status:** found; blocked pending the coordinated stable-bootstrap and install/data-root migration described in the preceding Windows path-collision finding.

**Remaining risk:** The normal installed-product prepared-phase recovery remains broken. Installer compilation and Fast Validation's separate Windows archive/updater smoke do not establish installed-product lifecycle success.


## November 6 — explicit logout and session revocation can be undone by late session-store upserts

### Confirmed High (P1): deletion-only revocation has no durable tombstone

**Affected workflows:** Logout, revoke one device/session, revoke all other sessions, session inventory, and any in-flight authenticated request that persists session state after revocation.

**Evidence and root cause:**

- The session middleware configures rolling cookies with a seven-day maximum age and the global API guard mutates lastSeenAt on every authenticated request.
- The organization/optimization action-token helper also mutates the session and explicitly persists it during protected operations.
- The pinned connect-pg-simple store can recreate a deleted row through its INSERT ... ON CONFLICT (sid) DO UPDATE set operation.
- POST /auth/logout calls req.session.destroy(), while DELETE /auth/sessions/:sid and DELETE /auth/sessions delete rows directly. None records a durable revocation marker.
- The credential-version fix above changes only when the password hash changes. Logout and individual/all-other-session revocation leave that fingerprint unchanged.

**Confirmed race:** Request A loads a session and passes the global guard. Request B logs out or revokes that SID and deletes the session row. Request A then completes and saves its modified session. The store can insert the old SID again. Because its password credential fingerprint is still current, a later request can pass the new credential-version check. The same issue affects an in-flight request from a device revoked through the session-management screen.

**Status:** fixed; target validation pending on code commit `347b8cdbd9c093aae216920d33c25a48f6009358`.

**Fix — commit:** `347b8cdbd9c093aae216920d33c25a48f6009358`.

- Added the idempotent `revoked_sessions` table to the single required-schema bootstrap used by standalone setup and API startup. The desktop launcher's schema fingerprint includes `setup-db.cjs`, so the changed schema script invalidates its prior ready marker and runs the migration before starting the API.
- Added `auth-session-revocation.ts`. Logout and authenticated-session cleanup write a SID tombstone and delete the session row in one transaction. Targeted device revocation inserts a tombstone only for a row belonging to the current settings ID and credential generation. Revoke-all tombstones every other row in that credential generation before deleting it and deliberately does not filter by expiry, because an expired row may still be held by an in-flight request.
- The global authorization middleware now checks the tombstone and credential version in one query before dispatching protected routes. A tombstoned SID is rejected even if connect-pg-simple later recreates its row. Database verification failures return 503 rather than authorizing.
- `/auth/status` checks tombstones; `/auth/sessions` excludes them. Logout reports 503 if durable revocation cannot be written instead of returning a false success.
- Session regeneration while already authenticated now tombstones the previous SID before express-session destroys it, closing the same late-save window on re-login/session rotation.
- The physical session-row delete is cleanup only after the marker commits. If that delete fails, the tombstone still denies authorization and the cleanup failure is logged.
- Tombstones are retained indefinitely in this batch. No age-only cleanup is safe until the application establishes and enforces a maximum in-flight request lifetime; removing a marker while an old request can still upsert would reopen the vulnerability.

**Regression coverage added:**

- `auth-session-revocation-postgres.test.ts` uses a real PostgreSQL service and reproduces connect-pg-simple's `INSERT ... ON CONFLICT DO UPDATE` after deletion for logout, targeted revoke, and revoke-all.
- The integration test verifies current-session preservation, credential-scope isolation, and that expired-but-still-present session rows are tombstoned.
- `install-auth-reliability.test.ts` verifies every revocation entry point, the global guard, and inventory filtering.
- `schema-bootstrap.test.ts` verifies the new table is created by the idempotent required-schema bootstrap.
- Fast Validation now runs the PostgreSQL tombstone integration test and the schema-bootstrap regression explicitly.

**Remaining risk:** Already-authorized work that began before revocation is not forcibly cancelled; this change prevents a later request from using the SID after a late upsert. Cancellation/fencing of already-running destructive jobs remains a separate workstream. Tombstone rows currently accumulate until a safe bounded-lifetime cleanup design is available.

## November 6 — validation failures diagnosed and audit checks stabilized

### Test-harness failure 1: over-escaped source assertions

Fast Validation [run 42284276873](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42284276873) failed on implementation commit a3e25f38c633b9635a359daa49f97df80dadf186 because the new source-contract regression used over-escaped regular expressions and therefore did not match the intended source text. The failure was in the regression assertion, not the application code. Commit fd99adc2c3fda0cef125ab68a763fe2acdacd0dd replaced those patterns with literal includes and explicit ordering checks.

### Test-harness failure 2: PostgreSQL advisory-lock disconnect test raced server teardown

Fast Validation [run 42284372360](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42284372360) failed at the PostgreSQL conversion advisory-lock integration test. The test called pg.PoolClient.release(true) and immediately attempted to reacquire the session lock. The logs show the assertion failed about 23 ms later because PostgreSQL had not yet observed the asynchronous socket teardown. The product lock implementation was not changed. Commit 7e185ba807503bf7975af6c58e994c75f4ac71e0 adds a bounded five-second poll at 25 ms intervals so the integration test verifies eventual release rather than assuming synchronous server-side disconnect processing.

### Exact validation evidence

- Fast Validation [run 42284573101](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42284573101) completed successfully on documentation head 80546a9a825e51076f7f512d9987521ece8873ad, which contains the credential-version implementation and corrected source assertions. Linux validation job 128122474396 passed workspace typechecks and generated-contract checks; its targeted suite reported 358 tests, 356 passed, 0 failed, 2 skipped. The PostgreSQL advisory-lock and conversion-finalization integration steps passed. Windows archive/updater smoke job 128123281575 passed, including 20 PowerShell script parses, launcher/process ownership, Windows organization capacity, media rename, conversion rollback, official Windows 7-Zip, compressed TAR preview, updater journal, and developer updater preservation/rollback.
- Fast Validation [run 42284916889](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42284916889) completed successfully on code/test head 7e185ba807503bf7975af6c58e994c75f4ac71e0. Linux validation job 128124598990 passed workspace typechecks/generated contracts and 358 targeted tests (356 passed, 0 failed, 2 skipped), including PostgreSQL advisory-lock/finalization integration and credential-version regressions. Windows archive/updater smoke job 128125482533 passed: 20 PowerShell scripts parsed; launcher/process ownership and Windows organization capacity passed; media rename and conversion no-overwrite/rollback passed; official Windows 7-Zip hash verification and compressed TAR preview passed; updater journal and developer-updater preservation/rollback passed.
- Documentation-only ledger commit 009faac4883931ffd619fc2b0e74e9523165a66b was the latest branch head at this inspection. Fast Validation [run 42285922698](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42285922698) and Dependency Review [run 42285922760](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42285922760) were queued on that exact head; no result is attributed to it yet.
- Dependency Review [run 42284917015](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42284917015) passed on code/test head 7e185ba807503bf7975af6c58e994c75f4ac71e0. The production advisory gate passed; the separate installed dependency-graph audit was skipped.
- No dedicated full-CI workflow exists in .github/workflows at this branch head. The available workflows are dependency refresh, dependency review, Fast Validation, Windows installer lifecycle validation, and Windows release. Full CI was not run; the release workflow was not invoked.



## November 6 — durable session revocation implementation and validation

### High (P1): logout/device-session late-upsert resurrection

- **Status:** PostgreSQL integration-tested; implementation, authorization wiring, and regression suite pass on code/test commit `cc4c1ae25ad06ae6b2ff357a03026b0da0caf635` and latest documentation head `6df792a4b96d062127146a9529bc1ed487dc3be6`.
- **Implementation commits:** `347b8cdbd9c093aae216920d33c25a48f6009358` (tombstone implementation) and `cc4c1ae25ad06ae6b2ff357a03026b0da0caf635` (TypeScript and route-parameter corrections after CI diagnostics).
- **Affected files:** `setup-db.cjs`, `artifacts/api-server/src/lib/auth-session-revocation.ts`, `artifacts/api-server/src/app.ts`, `artifacts/api-server/src/routes/auth.ts`, authentication/schema tests, and `.github/workflows/fast-validation.yml`.
- **Typecheck failure diagnosed:** Fast Validation [run 42292732845](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42292732845) and its documentation-head rerun [42292867502](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42292867502) stopped at API-server typecheck. The exact compiler errors were (a) deriving the transaction client from the overloaded `pool.connect` return type selected its callback overload and inferred `void`, and (b) Express route params are typed `string | string[]`. Commit `cc4c1ae25ad06ae6b2ff357a03026b0da0caf635` changed the transaction callback to use the already-inferred client inside the helper and normalizes/bounds the route SID before calling the revocation service.
- **Fast Validation:** [run 42293037190](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42293037190) completed successfully on exact code/test commit `cc4c1ae25ad06ae6b2ff357a03026b0da0caf635`. Linux job 128151123402 passed all workspace typechecks and generated-contract validation, Expo CLI configuration, desktop web-server safety, release/storage contracts, PostgreSQL media LIKE tests, conversion advisory-lock and finalization-recovery integration, the new session-tombstone late-upsert integration test (1/1 passed), and the targeted backend suite (360 tests: 358 passed, 0 failed, 2 skipped). Windows job 128151967468 passed all archive/updater smoke steps: 20 PowerShell scripts parsed; launcher/process ownership, capacity probes, media rename, conversion no-overwrite/rollback, official 7-Zip hash and extraction, symlink metadata, compressed TAR preview, updater journal, and developer-updater preservation/rollback passed.
- **Dependency Review:** [run 42293037273](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42293037273) passed on the same exact commit; the production advisory gate passed and the separate installed dependency-graph audit was skipped.
- **Windows installer lifecycle:** [run 42292725030](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42292725030) completed **failed** on earlier implementation commit `347b8cdbd9c093aae216920d33c25a48f6009358`. The unsigned installer built and compiled; standard-user first install/start, in-place upgrade, post-upgrade start, and simulated `swapped` recovery completed. The prepared-phase recovery scenario then failed fast at `scripts/windows/installer-lifecycle-smoke.ps1:108` with `Installed launcher is missing before 'start': C:\\WillardLifecycle\\wl_life_109f4310\\desktop\\WillardMediaCenter.ps1`. This is the known stable-bootstrap/install-data-root recovery defect, not a health-check timeout or a passing lifecycle result.
- **Latest-head Fast Validation:** [run 42294097100](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42294097100) completed successfully on exact branch head `6df792a4b96d062127146a9529bc1ed487dc3be6`. Linux job 128154738981 passed workspace typechecks/generated contracts, Expo configuration, desktop safety, release/storage contracts, official 7-Zip 26.05 compatibility, PostgreSQL LIKE tests (6/6), conversion advisory-lock integration (1/1), conversion finalization recovery (2/2), session tombstone late-upsert integration (1/1), and targeted backend tests (360 total: 358 passed, 0 failed, 2 skipped). Windows job 128155515316 passed every archive/updater smoke step, including PowerShell parsing, process ownership, storage migration, NAS path safety, conversion rollback, official 7-Zip 26.05, symlink metadata, compressed TAR preview, updater journal, and developer-updater preservation/rollback.
- **Latest-head Dependency Review:** [run 42294097091](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42294097091) passed on the same exact head; the production advisory gate passed and the separate installed dependency-graph audit was skipped.
- **Full CI:** not run. Fast Validation is broad targeted Linux/PostgreSQL plus Windows archive/updater coverage, but it is not a full-repository CI run.
- **Residual risk:** tombstones are retained without automatic cleanup to avoid deleting a marker while a stale request could still upsert. Already-authorized in-flight operations are not cancelled by session revocation; destructive job fencing remains a separate finding.


### Session revocation validation correction — November 6

- Fast Validation initially exposed two compile-time integration issues in the first tombstone implementation: the overloaded `pool.connect` type was inferred through its callback overload, and Express 5 exposes route params as `string | string[]`. These were corrected in `cc4c1ae25ad06ae6b2ff357a03026b0da0caf635`; the route now rejects empty/oversized IDs after normalizing the param, and the transaction helper uses the inferred client locally rather than an invalid `ReturnType` alias.
- Exact latest code validation is Fast Validation [42293037190](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42293037190): passed on `cc4c1ae25ad06ae6b2ff357a03026b0da0caf635`, including workspace typechecks, PostgreSQL late-upsert test, 360 targeted tests (358 passed, 2 skipped), and Windows archive/updater smoke.
- Dependency Review [42293037273](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42293037273) passed on the same commit; installed dependency-graph audit skipped.
- The installed Windows product lifecycle run [42292725030](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42292725030) is still separate and was running against earlier commit `347b8cdbd9c093aae216920d33c25a48f6009358`; no lifecycle pass is claimed.


## November 6 — latest-head validation and prepared-phase lifecycle failure

- **Branch head:** `6df792a4b96d062127146a9529bc1ed487dc3be6` (audit ledger update only after code/test commit `cc4c1ae25ad06ae6b2ff357a03026b0da0caf635`).
- **PR #2:** open, draft, unmerged; branch remains `audit/full-repository-review-2026-11`, base `main`; 1,389 commits and 193 changed files at this snapshot. No merge, deploy, release, production-data operation, or credential modification.
- **Fast Validation [42294097100](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42294097100):** passed on this exact head. Linux typechecks/generated contracts and targeted regressions passed; PostgreSQL session tombstone late-upsert integration passed 1/1; targeted backend suite passed 358/360 with 2 skipped; Windows archive/updater smoke passed all steps.
- **Dependency Review [42294097091](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42294097091):** passed on this exact head; production advisory gate passed; installed dependency-graph audit skipped.
- **Windows installer lifecycle [42292725030](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42292725030):** failed on earlier code commit `347b8cdbd9c093aae216920d33c25a48f6009358` in prepared-phase recovery. The fail-fast test diagnostic now exposes the missing launcher path directly. First install, first start, upgrade, post-upgrade start, and swapped-phase recovery had succeeded before the prepared-phase failure. This confirms the stable-bootstrap defect remains; no recovery workaround was applied.
- **Full CI:** not run. The available validation workflows remain separate and do not constitute full-repository CI.


## November 6 — manual local first-run setup and session transaction type hardening

- **Branch head before this report update:** `168edf6b95ef3250c5ff152841fd92dd24f43633`.
- **PR #2:** open, draft, unmerged; existing branch `audit/full-repository-review-2026-11`, base `main`; 1,395 commits and 195 changed files at this snapshot. No branch switch, merge, deployment, release, production-data operation, or credential modification.
- **Architecture/repository review:** rechecked `ARCHITECTURE.md`, workspace/package boundaries, API startup/auth middleware, setup authorization, desktop/developer launchers, setup UI, root scripts, workflow definitions, current PR diff, findings ledger, and recent branch CI before changing files.

### P2 — documented manual local setup could not complete first-run authorization

- **Affected workflow:** direct/manual API startup on a user's own Windows, macOS, or Linux computer, followed by first administrator password creation.
- **Evidence/root cause:** `authorizeFirstRunSetup()` intentionally permits tokenless setup only when the process has the explicit `WILLARD_LOCAL_SETUP=true` opt-in, is not running under Replit, and binds to `HOST=127.0.0.1`. The packaged and developer desktop launchers set those values. The documented manual startup in `LOCAL_SETUP.md` did not, so users following the documented direct-start commands received `token_required` or `token_misconfigured` and could not complete first-run setup without an undocumented workaround.
- **Fix:** `LOCAL_SETUP.md` now provides PowerShell and POSIX first-run commands that set both values for the local API process, explicitly warns not to use the bypass on a hosted server or behind a reverse proxy, and directs remote/LAN setup to the operator-configured `WILLARD_SETUP_TOKEN`.
- **Regression coverage:** `install-auth-reliability.test.ts` now asserts both shell command forms and the hosted/reverse-proxy warning. Existing `setup-authorization.test.ts` continues to verify that the bypass requires explicit opt-in and rejects non-loopback peers.
- **Status:** fixed; target-tested on exact code/test head `168edf6b95ef3250c5ff152841fd92dd24f43633` by Fast Validation [42296111129](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42296111129). The manual-start regression passed in the targeted backend suite.

### P3 — remove untyped transaction client from session-revocation code

- **Affected workflow:** logout, per-device session revocation, revoke-other-sessions, and stale-session cleanup transactions.
- **Evidence/root cause:** `auth-session-revocation.ts` accepted its transaction client as `any`, weakening compile-time checks around the new security-critical transaction boundary.
- **Fix:** `lib/db/src/index.ts` now exports the existing `pg` `PoolClient` type, and the revocation transaction helper uses that type. This is type-only; it adds no runtime dependency and changes no transaction behavior.
- **Status:** fixed; workspace/library and API typechecks passed on code commit `ec1a916295c3c9191b1ad151200d36a2bdfa6cd1`, and the latest exact-head typecheck also passed in Fast Validation [42296111129](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42296111129).

### Validation evidence

- **Fast Validation [42296111129](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42296111129), exact head `168edf6b95ef3250c5ff152841fd92dd24f43633`:** Linux validation job passed. Workspace typechecks/generated contracts, Expo configuration, desktop web-server safety, release/storage contracts, PostgreSQL media-query validation, conversion advisory-lock integration, conversion finalization recovery, and session-revocation tombstone integration passed. Targeted backend regressions: 361 total, 359 passed, 0 failed, 2 skipped. The new manual local setup documentation regression passed.
- **Windows archive/updater smoke:** the matching job in run 42296111129 was still in progress at the time this ledger update was prepared; no pass is claimed for that job yet. The same Windows smoke job did pass on code commit `ec1a916295c3c9191b1ad151200d36a2bdfa6cd1` in Fast Validation [42296007239](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42296007239), including PowerShell parsing, launcher ownership, Windows capacity probes, storage migration, NAS temp-path safety, conversion rollback, official 7-Zip symlink metadata, compressed TAR preview, updater journal, and developer-updater preservation/rollback.
- **Dependency Review [42296110982](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42296110982), exact head `168edf6b95ef3250c5ff152841fd92dd24f43633`:** production advisory gate passed; installed dependency-graph audit skipped.
- **Full CI:** not run. The repository has Fast Validation, Dependency Review, Windows installer lifecycle, and Windows release workflows, but no full-repository CI workflow or all-tests script. Fast Validation is broad targeted validation, not full CI.

### Remaining prioritized risks

- **Critical / blocked:** default Windows installer directory overlaps persistent data directory; the stable external recovery bootstrap and legacy data migration still need a coordinated implementation and installed-product lifecycle validation.
- **High / architecture work:** conversion workers need attempt-generation fencing and unique staging ownership; node-7z list/extract child processes still need shared process ownership and cancellation.
- **High / open:** organization worker takeover and NAS/SMB recovery, durable replacement rollback, and cleanup/revocation retention boundaries still need further concurrency and crash testing.
- **Lifecycle evidence:** the latest Windows installer lifecycle run remains [42292725030](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42292725030), failed on earlier commit `347b8cdbd9c093aae216920d33c25a48f6009358` in prepared-phase recovery. No installed-product recovery pass is claimed.


## November 6 — follow-up validation status for manual setup/auth hardening

- **Code/test head `168edf6b95ef3250c5ff152841fd92dd24f43633`:** Fast Validation [42296111129](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42296111129) subsequently completed successfully on both jobs. Linux validation passed workspace typechecks/generated contracts, PostgreSQL integration checks, release/storage/UI contracts, and 361 targeted backend tests (359 passed, 0 failed, 2 skipped). Windows archive/updater smoke also passed, including PowerShell launcher checks, Windows capacity probes, storage migration, conversion rollback, official 7-Zip symlink metadata, compressed TAR preview, updater journal, and developer-updater preservation/rollback. This supersedes the earlier note that the Windows job was still running when the previous ledger entry was prepared.
- **Dependency Review [42296110982](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42296110982)** passed on the same code/test head; the production advisory gate passed and the separate installed dependency-graph audit was skipped.
- **Ledger-only head `09217122be644e2fbea6168f70f7adb3f13088ef`:** Fast Validation [42297148800](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42297148800) Linux validation job passed; the matching Windows archive/updater smoke job was still running at this follow-up. Dependency Review [42297148813](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42297148813) passed the production advisory gate; installed dependency-graph audit skipped.
- **Installed Windows lifecycle remains separate and unresolved:** run [42292725030](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42292725030) failed on earlier commit `347b8cdbd9c093aae216920d33c25a48f6009358` during prepared-phase recovery. The archive/updater smoke pass does not validate the installed-product recovery path.
- **Full CI:** still not run; no full-repository CI workflow exists in this repository snapshot.


## November 6 follow-up — node-7z subprocess ownership and archive-preview cancellation

### Confirmed High (P1): 7-Zip archive commands could outlive their API owner

**Affected workflows:** archive preview, archive analysis/preflight, safe archive extraction, API graceful shutdown, and retry/recovery after interrupted organization jobs.

**Evidence and root cause traced through the pinned dependency and every production caller:**

- The repository pins `node-7z@3.0.0`. Its `Lifecycle.run` implementation starts the binary with `child_process.spawn` (detached process by default) and stores the child on the returned stream's `_childProcess` property. `Seven.listen` attaches stream parsing but does not register the child with Willard AI's shared `activeMediaProcesses` owner.
- `artifacts/api-server/src/routes/archives.ts` called `Seven.list` in `peek7z` without registering the child, without an AbortSignal, and without observing response disconnect. A client closing an archive preview therefore did not stop the 7-Zip process. When an unsafe link or path/budget violation was discovered, the code recorded `safetyError` but continued consuming the listing until 7-Zip exited.
- `artifacts/api-server/src/routes/organize.ts` had three additional `Seven.list` validation calls and one `Seven.extractFull` call that also bypassed the shared process owner. The extraction writes only into the job's private staging directory; it must remain a server-owned operation rather than being cancelled merely because the SSE client disconnects. On shutdown, however, the process must be stopped so it cannot continue writing after its API owner exits and a later worker attempts recovery.

**Fixes:**

- `artifacts/api-server/src/lib/media-tools.ts` now exports `stopMediaProcess`, which applies the existing bounded SIGTERM-to-SIGKILL policy to one owned child. `stopActiveMediaTools` reuses that helper for every registered process.
- `artifacts/api-server/src/lib/sevenzip.ts` now provides `createTrackedSevenZipStream`. It rejects new process starts during shutdown, registers the pinned node-7z stream's spawned child with the shared shutdown owner, and optionally binds an AbortSignal to bounded termination. `stopTrackedSevenZipStream` stops a listing as soon as validation rejects its metadata.
- All five production node-7z calls are now wrapped: the archive preview listing, three organization/preflight listings, and the organization extraction.
- The read-only archive preview binds its child to the HTTP response lifecycle. A disconnected client aborts the listing; the route does not attempt to write an error response after the connection has closed.
- Unsafe 7-Zip metadata now terminates listing promptly instead of parsing the rest of an invalid archive. Organization extraction remains server-owned and is not tied to the SSE client's connection; it is registered for server shutdown and writes only to the job staging area.
- Regression coverage exercises shared shutdown ownership, AbortSignal cancellation, and all production call sites. The official 7-Zip compatibility test now wraps real node-7z list/extract operations and asserts that the pinned library exposes the child process expected by the adapter.

**Implementation/test commits:** `6ae4cfbd5a256a9b078806e2281b42e686825857` (bounded per-child termination); `3296c08443cc76b88a202246d40404c8a9f54f46` (node-7z process adapter); `ae2d24af05ddc2285a3ce11d3f45a2652566bd3d` (preview disconnect and early safety stop); `12adcc6d26e0bcefe1752cdd21b48be56f7465dc` (all organization calls); `1a6207fa12295a5d3547d9c5a5d0a99d47eacd11`, `2ade1d24e3a6a05a1d2ad8e915b2ce47245a1c01`, `50a265b3af72fe9aef150f27dea6e13dc9fcb44b`, and `7f541970dbaed5a07fadd123841544217a653cec` (unit, source-contract, and real-binary integration coverage).

**Status:** fixed in source. Targeted tests and official-binary integration are pending the matching Fast Validation run for exact code/test head `7f541970dbaed5a07fadd123841544217a653cec`; no pass is claimed yet. The intermediate Fast Validation run [42301729288](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42301729288) on earlier helper commit `6ae4cfb` passed Linux typechecks, generated contracts, PostgreSQL integration checks, and its targeted backend batch; its Windows smoke was still running at the last inspection and that run did not yet contain the final node-7z adapter/call-site changes. Fast Validation runs for intermediate commits were queue-replaced/cancelled as newer commits arrived; those cancellations are not test failures.

**Exact latest-head CI snapshot:** Fast Validation [42301992363](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42301992363) was pending on `7f541970dbaed5a07fadd123841544217a653cec`. Dependency Review [42301992365](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42301992365) passed its production advisory gate on the same head; its separate installed dependency-graph audit was skipped. The latest installed Windows lifecycle result remains the earlier prepared-phase recovery failure [42292725030](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42292725030); this archive-process batch does not resolve the stable Windows bootstrap or install/data-root collision. Full CI was not run.

**Remaining risk:** There is still no explicit durable user-cancel endpoint for a server-owned organization extraction, nor an operation-specific deadline for a connected but indefinitely stalled 7-Zip listing/extraction. The current change covers server shutdown, preview-client disconnect, and early rejection of unsafe listings. A user-facing destructive-job cancellation needs a durable job-state transition and lease-aware rollback design; it must not be implemented by tying extraction to the SSE connection. The adapter intentionally relies on the pinned node-7z 3.0.0 `_childProcess` runtime property, which is not declared by the package's TypeScript typings; the real-binary compatibility test guards that dependency contract.

### Remaining prioritized risks after this batch

- **Critical / blocked:** default Windows installer directory still overlaps persistent data; stable external bootstrap and legacy data migration require a coordinated design and installed-product lifecycle validation.
- **High / architecture work:** conversion workers still need attempt-generation fencing, attempt-specific staging, and ownership-checked finalization after advisory-lock loss.
- **High / architecture work:** organization worker takeover, NAS/SMB crash recovery, and the path-anchored no-follow move primitive remain open.
- **High / blocked:** destructive Replace still needs a durable displaced-destination journal and restore workflow; do not re-enable it through a partial workaround.
- **High / open:** explicit durable cancellation for server-owned organization jobs and operation-specific 7-Zip deadlines remain separate design items.
- **Windows lifecycle:** prepared-phase recovery remains failed on the prior run; Fast Validation's Windows archive/updater smoke is not installed-product lifecycle validation.


### Validation update — exact documentation head `05a8c88150b4b8de47be3b5e7d1bef22542bc3d9`

This head is a documentation-only commit after code/test commit `7f541970dbaed5a07fadd123841544217a653cec`; it contains the same archive process-ownership implementation and tests.

- **Fast Validation #42302252050 — Linux job 128182985506: passed on exact head `05a8c88150b4b8de47be3b5e7d1bef22542bc3d9`.** Typecheck and generated-contract validation passed; Expo CLI configuration, desktop web-server safety, release/storage contracts, official static 7-Zip 26.05 compatibility, PostgreSQL media filters, conversion advisory-lock integration, conversion finalization recovery, session-revocation tombstones, and the targeted backend regression batch all passed. Targeted backend batch: 364 tests, 362 passed, 0 failed, 2 skipped (both explicitly require the configured PostgreSQL test database). The new node-7z ownership, AbortSignal, call-site contract, and shutdown tests all passed. The real official-binary node-7z compatibility test passed 1/1.
- **Fast Validation #42302252050 — Windows job 128183713964: in progress at last inspection.** PowerShell parsing, launcher serialization/orphan handling, environment-file encoding, dependency installation, Windows capacity checks, media rename/no-overwrite, media subprocess responsiveness, storage migration, NAS temp cleanup, conversion finalization/rollback, official Windows 7-Zip staging, node-7z symlink metadata, compressed TAR preview, and packaged updater-journal tests had passed. The final developer-updater preservation/rollback step was still running; therefore Windows Fast Validation is not yet marked passed.
- **Dependency Review #42302252056 — passed on exact head `05a8c88150b4b8de47be3b5e7d1bef22542bc3d9`.** The production advisory gate passed; the separate installed dependency-graph audit was skipped.
- Fast Validation #42301992363 for preceding code/test head `7f541970dbaed5a07fadd123841544217a653cec` was queue-replaced/cancelled when the documentation-only head was pushed. This is not a test failure; the newer run above is the matching validation.
- **Full CI:** not run. Fast Validation is the Linux + Windows smoke/targeted validation workflow, not a full-repository CI claim.

**Status for the node-7z batch:** source fix complete; targeted Linux tests and real-binary integration passed on exact head `05a8c88150b4b8de47be3b5e7d1bef22542bc3d9`; Windows smoke is still in progress. Do not mark Windows or full validation complete until the matching Windows job finishes successfully.


### Final validation update — Fast Validation #42302252050 completed successfully

The previously running Windows job has now completed. Both jobs in Fast Validation #42302252050 passed on exact code/test head `05a8c88150b4b8de47be3b5e7d1bef22542bc3d9`:

- Linux validation job `128182985506`: **success**. Typecheck/generated contracts, Expo/desktop/release/storage checks, official static 7-Zip 26.05 with node-7z, PostgreSQL media filters, conversion advisory locks, conversion finalization recovery, session-revocation tombstones, and the targeted backend suite all passed. Targeted backend suite: **364 total, 362 passed, 0 failed, 2 skipped** (the two Trash recovery cases explicitly require the configured PostgreSQL test database). The new node-7z process ownership, AbortSignal cancellation, production-call-site contract, and shutdown tests all passed. Real official-binary node-7z compatibility passed 1/1.
- Windows archive/updater smoke job `128183713964`: **success**. All 23 steps passed, including Windows media subprocess responsiveness, storage migration/no-overwrite, NAS temp cleanup, conversion finalization rollback, official Windows 7-Zip 26.05 hash verification, node-7z symlink metadata, compressed TAR preview, packaged updater journal writes, and developer updater preservation/rollback.
- Dependency Review #42302252056 on the same head: **success** for the production advisory gate; the separate installed dependency-graph audit was skipped.
- The latest branch head after recording this evidence is documentation-only commit `bf305dc8e457edf042e10bced4ee3bf7d7aee4ca`. Fast Validation #42302869641 for that documentation head is queued; Dependency Review #42302869626 is in progress. Do not transfer the completed code/test results above to a claim that the newer documentation head has completed its own matching run.

**Status:** node-7z source fix is target-tested and integration-tested on Linux and Windows Fast Validation. It is not a full-CI or installed-product-lifecycle validation. The Windows installer/data-root collision and stable external bootstrap remain blocked and unchanged.

## November 6 — Optimize Center NAS traversal, cache I/O, and codec-probe concurrency

### High (P1): large Optimize scans could block the API event loop and exhaust subprocess resources

- **Affected workflows:** Optimize Center scan summary, conversion job preflight, conversion staging/capacity admission, JPEG/video analysis, scan-cache reads/writes, and API health/other requests sharing the same Node process.
- **Status:** shared async walker and bounded codec-probe behavior target-tested; subsequent async cache/per-file/finalization I/O changes await the latest matching Fast Validation run. No full-CI status is claimed.
- **Evidence/root cause:** the Optimize Center route walked up to 500,000 recognized files using synchronous `readdirSync` and `statSync`. The conversion execute route repeated a synchronous recursive walk, then synchronously statted every candidate to estimate staging capacity and again while processing each file. Cache reads and writes used synchronous file I/O. These operations ran inside async Express handlers but still blocked the event loop while each filesystem call completed; on a slow or disconnected SMB/NAS mount, unrelated API requests could stall.
- **Additional resource-exhaustion root cause:** codec analysis used `Promise.allSettled(paths.map(...))` for every tracked video path. The scan stores up to 5,000 paths per container extension; four container extensions could schedule up to 20,000 ffprobe children for one request, with no process-wide concurrency cap. `runMediaToolAsync` owned and timed out those children but did not limit how many could start concurrently.
- **Fix — asynchronous shared traversal:** `optimize-scan.ts` now provides one asynchronous directory walker used by both `walkForOptimize` and `walkForConversion`. Directory reads and file metadata inspection use `fs.promises`; nested directories are revalidated with `lstat` immediately before recursion, and file candidates are revalidated as regular non-symlink files. Hidden/internal/backup exclusions and the conservative 500,000-file limit are preserved. Read failures include the affected path and abort the scan instead of producing partial totals or a false empty-library result.
- **Fix — bounded ffprobe:** all container codec probes are collected into one per-scan worker pool of four, while a process-wide FIFO limiter caps actual ffprobe children at four across simultaneous scan requests. Results retain input order and all-settled semantics, preserving deterministic group-level codec selection and best-effort handling of individual probe failures.
- **Fix — remaining high-volume filesystem I/O:** conversion scan results now carry the validated source size so capacity estimation does not perform a second synchronous stat pass. The Optimize route's cache read/write, NAS directory checks, JPEG source sizing, per-file source/output verification, staged-file cleanup, and post-finalization staging cleanup now use asynchronous filesystem APIs. A fresh `lstat` before conversion rejects sources that disappeared or changed into symlinks/non-regular files. Direct synchronous `fs.*Sync` calls were removed from `routes/optimize.ts` at the source-inspection checkpoint.
- **Regression coverage:** `optimize-scan.test.ts` covers event-loop yielding before scan completion, grouped file sizes, scan-cap behavior, symlink exclusion, missing/unreadable directory failures for both walkers, hidden/internal/backup filtering, validated conversion source sizes, bounded per-scan workers, process-wide concurrency across independent callers, invalid limits, and source contracts for async traversal/cache/file I/O. `optimize-job-claim.test.ts` now checks the shared async conversion walker rather than assuming it remains a local synchronous function. Fast Validation's Windows job now also runs `optimize-scan.test.ts`.
- **CI harness correction:** Fast Validation on intermediate commit `30ff3f98b5fc031d85a1210f0f37dcb3944c1371` failed after 367 tests passed because `optimize-job-claim.test.ts` still searched `routes/optimize.ts` for the old local `function walkForConversion`. The walker was intentionally moved into the shared helper; this was a stale source-contract assertion, not a product-test failure. Commit `61685f383021eee87e3c2bd66bed7cd13611a38d` updated the test to inspect the helper and verify the route awaits it. The additional unreadable-conversion-directory regression was added in `cc08aefb7cbc4c3212b9717e943a62e02840ea5f`.
- **Implementation/test commits:** `fda6c2366d2e16bc10ec21e1c7f55c0630a27b1d` (async walkers and concurrency helpers); `75052fa17d5bfeec242ba0d1899692b40f5ee881` (route wiring and bounded ffprobe); `30ff3f98b5fc031d85a1210f0f37dcb3944c1371` (initial scan regressions); `97601b7da68fb685d4c34f0ce637b08f94d961b1` and `5599f07b756ac2f41e840ce48d9ba47ef5ede61a` (symlink wording and event-loop test correction); `61685f383021eee87e3c2bd66bed7cd13611a38d` (shared-walker source contract); `cc08aefb7cbc4c3212b9717e943a62e02840ea5f` (unreadable conversion directory runtime regression); `5de51b1fab39549989ac97c67561f0ccca89eda6` (carry source size); `e915d8bd5636050d15e80dd33a563c8d7edfb3fc` and `f12ebb098a03368275cf6905fb2e59049ce0b0b5` (async cache, source/output inspection, cleanup, and awaited call sites); `edbeaff57588941768cc89c6e8f1599a2f6d18fa` and `c7fb11ad65464cf4222f2494940515d4ddb70ef4` (size and async-I/O regression assertions); `86ee0fbe52b38d189862339956186858680a1ce2` (Windows Fast Validation coverage); `e75d73d143e03f74ae8cae1de10b31c64aabe1f5` (conversion verifier parameter-order correction).
- **Validation on predecessor code/test commit `cc08aefb7cbc4c3212b9717e943a62e02840ea5f`:** Fast Validation [run 42308407574](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42308407574) completed successfully. Linux validation job `128203806391` passed typechecks/generated contracts, PostgreSQL media/conversion/finalization/session integration, official 7-Zip compatibility, and the targeted backend suite: 371 total, 369 passed, 0 failed, 2 skipped. Windows archive/updater smoke job `128204382877` also completed successfully. This predecessor commit contains the asynchronous walkers, per-scan/process-wide codec limits, and the corrected shared-walker tests, but it predates the later async cache/per-file/finalization I/O changes and the added Windows Optimize scan test step.
- **Latest code/test head at the time of this entry:** `e75d73d143e03f74ae8cae1de10b31c64aabe1f5`. Fast Validation [run 42308887662](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42308887662) is queued/in progress; Linux job `128205437090` was in progress at the last inspection. No result is attributed to this latest head until that run completes. Dependency Review [run 42308887561](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42308887561) passed the production advisory gate; the separate installed dependency-graph audit was skipped.
- **Full CI:** not run. Fast Validation is targeted Linux/PostgreSQL plus Windows smoke coverage, not a full-repository CI claim.

**Remaining risk:** `ensureDirectoryWithinRoot` remains the existing synchronous NAS path-creation/containment helper called while staging conversion outputs; it still deserves a separate careful async/no-follow review for slow SMB paths. Read-only scan cancellation on client disconnect is also not implemented, so a disconnected Optimize scan can continue its bounded filesystem/probe work. Conversion attempt-generation fencing, advisory-lock-loss process cancellation, and unique per-attempt staging remain separate high-priority architecture findings. The Windows stable-bootstrap/install-data-root collision and prepared-phase recovery failure are unchanged; latest known installed-product lifecycle failure remains [run 42292725030](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42292725030). Full CI was not run.

## November 6 — Optimize scan active-library guard and latest typecheck repair

### Medium (P2): latest Fast Validation was blocked by unsafe nullable path flow in Optimize scan

- **Affected workflow:** `GET /optimize/scan`, Optimize Center initial scan, cache lookup, NAS traversal, and generated Fast Validation typecheck.
- **Status:** fixed in source; focused regression added; validation pending on the new code/test head.
- **Evidence/root cause:** Fast Validation [run 42309059481](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42309059481) on branch head `2124a59d5c419182e1eaffcc098d7ebf796cfe0b` failed at **Typecheck and validate generated contracts**. The actual TypeScript diagnostics were `TS2345` at `routes/optimize.ts:903, 913, 1107` because `nasPath` remained `string | undefined`, and `TS18047` at line 905 because `library` remained possibly null. The source contract `getActiveLibraryContext()` returns `ActiveLibraryContext | null`; deriving `nasPath` with optional chaining and then checking a separate `nasDirectoryAvailable` boolean did not narrow either value for later cache response and scan calls.
- **Fix:** the route now explicitly returns HTTP 400 when the active library is absent or its configured path is blank, then assigns `const nasPath = library.nasPath` before asynchronous filesystem access. The existing inaccessible-directory response remains unchanged. This makes the route's fail-closed precondition explicit and resolves the type-narrowing problem without a cast or weakened type.
- **Regression coverage:** `optimize-scan.test.ts` now verifies that the missing-library guard appears before cache lookup and NAS traversal and that the route uses the narrowed `library.nasPath`.
- **Commits:** route fix `56aa6e5cfca9eeb213b8b4895856b2d257a6e8b3`; regression `9bed19f4a0d54b2ea6e68c94e52993ec18228f3f`.
- **Validation evidence:** the failing typecheck was diagnosed from the actual job log for run 42309059481; dependency review [run 42309059482](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42309059482) passed its production advisory gate, with the installed dependency-graph audit skipped. No Fast Validation result was yet returned for the new code/test commit when this entry was written. No successful result is inferred from the fix.
- **Full CI:** not run.

**Remaining risk:** the existing `ensureDirectoryWithinRoot` helper remains synchronous and is called during Optimize staging. It performs security-sensitive root/path checks and directory creation, so converting it to async requires a caller-wide migration and equivalent no-follow/race protections; do not replace it with a weaker `mkdir({ recursive: true })` workaround. Optimize read-only scan cancellation on client disconnect, conversion attempt-generation fencing, lock-loss process cancellation, and unique per-attempt staging remain open. Windows install/data separation and the stable external recovery bootstrap remain blocked.

## November 6 — Optimize scan cache path-integrity and freshness hardening

### High (P1): Optimize scan cache reads and writes bypassed NAS symlink protection

- **Affected workflow:** Optimize Center cache lookup and scan persistence; any API process using the configured NAS library.
- **Status:** **fixed; target-tested and Windows-smoke-tested** on exact code/test head `4096d1d15ef127e53685037cec5da576383263d3`.
- **Evidence/root cause:** `getWillardAIDir(nasPath)` only joins the configured NAS path with `WillardAI`. The previous `readScanCache` read `getCachePath(nasPath)` directly, while `writeScanCache` recursively created the cache directory and wrote directly to the final filename. Neither checked the cache directory or final entry for symlinks. A symlinked directory could redirect both operations outside the library; a symlinked file could redirect a write into another writable file.
- **Fix:** extracted shared cache helpers into `lib/optimize-scan.ts`. They validate the cache directory with the existing `ensureDirectoryWithinRoot` policy and use its canonical path; read only a regular file with `O_NOFOLLOW` where supported, an opened file handle, and before/opened/after identity checks; revalidate the cache directory around the read; and write through a unique exclusive mode-`0600` temporary file followed by same-directory atomic rename. The final path is checked after publication. Cache failures remain non-fatal and become cache misses or skipped writes.
- **Regression coverage:** tests cover a valid cache hit, malformed/stale/future timestamps, old/future/missing versions, profile/raw-conversion mismatches, symlinked cache directory, symlinked cache file, and a deterministic regular-file replacement between initial `lstat` and `open`. The replacement test verifies a changed file identity is rejected.
- **Implementation commits:** `73a2bfe7de52e4d9be083fdb84bca39163022a84` (cache helper, route wiring, initial regressions); `4096d1d15ef127e53685037cec5da576383263d3` (directory revalidation and replacement-race regression).
- **Validation:** Fast Validation [#42340479418](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42340479418) passed on exact head `4096d1d15ef127e53685037cec5da576383263d3`. Linux job `128306831959` passed typecheck/generated contracts and the targeted backend batch: **377 total, 375 passed, 0 failed, 2 skipped**. All five new cache regressions passed on Linux. Windows job `128307128660` passed; the Optimize scan test step reported **21 total, 16 passed, 0 failed, 5 skipped**. The two symlink-specific cache tests are explicitly skipped on Windows; the regular-file replacement test passed there. Dependency Review [#42340479436](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42340479436) passed the production advisory gate; the separate installed dependency-graph audit was skipped.
- **Full CI:** not run. Fast Validation is targeted Linux/PostgreSQL plus Windows smoke coverage, not a full-repository CI claim.
- **Remaining risk:** the existing `ensureDirectoryWithinRoot` helper performs synchronous path checks and directory permission work, so a slow SMB/NAS path can still briefly block the event loop. The path-based checks reduce static symlink and replacement risks but do not provide a kernel-atomic, handle-relative parent-directory fence against an adversary racing a parent-directory swap between validation and the filesystem operation. Windows does not run the two symlink-creation tests. Preserve best-effort behavior and consider a stronger cross-platform no-follow directory abstraction in a separate storage-policy batch.

### Medium (P2): malformed and incompatible cache records were accepted

- **Affected workflow:** Optimize scan reuse and conversion decisions derived from cached per-file analysis.
- **Status:** **fixed; target-tested** in the same commits and exact validation above.
- **Evidence/root cause:** invalid `scannedAt` values produce `NaN`; the prior `age > TTL` comparison then evaluates false. Future timestamps also produce a negative age and were accepted. The old version comparison rejected only older versions, so an unknown future cache format was accepted.
- **Fix:** require the exact current cache version, a parseable timestamp, a timestamp not later than the current clock, and an age within the 24-hour TTL. Profile and raw-conversion mode checks remain enforced.
- **Regression coverage:** malformed, stale, future-dated, older-version, future-version, and missing-version cache entries all return a cache miss.
- **Commits:** `73a2bfe7de52e4d9be083fdb84bca39163022a84`; follow-up identity/revalidation tests in `4096d1d15ef127e53685037cec5da576383263d3`.
- **Remaining risk:** cache JSON shape validation remains intentionally bounded to version, timestamp, profile, and raw-conversion compatibility; deeper validation of every cached decision field is a separate compatibility review.

## November 6 — Health Center full-library inspection blocks the API event loop

### High (P1): Health Center performs an unbounded synchronous NAS scan inside a request

- **Affected workflow:** Health Center page load, media verification, thumbnail/cache inventory, empty-folder detection, and cleanup preflight.
- **Status:** **found; architecture plan required; no partial synchronous-to-async rewrite applied.**
- **Evidence/root cause:** `pages/health.tsx` calls `GET /media/health` on mount. `routes/media-health.ts` calls `inspectLibrary`, which checks NAS reachability synchronously, loads all active media rows, then loops through every row using synchronous path resolution and `isMissingRegularMediaFile` (`lstatSync`) and `isThumbnailFileValid` (`statSync`, `openSync`, `readSync`). It then calls `cacheInventory` (`readdirSync`/`statSync`) and recursively calls `walkDirectories` (`readdirSync`). The walker also accumulates a `files[]` array that the caller does not use; only empty-folder results are consumed.
- **Impact:** a large library or slow SMB/NAS can block the single API event loop for the entire traversal, delaying unrelated requests and health checks. The full file-path array adds avoidable memory proportional to the number of files. Opening the Health Center page repeats the full scan; its verification buttons also call the same full `load()` path.
- **Cleanup workflow:** `POST /media/cleanup` repeats `inspectLibrary` inline after starting an SSE response, then performs per-item synchronous `unlinkSync`/`rmdirSync` work and sequential thumbnail generation. It inserts a `library_jobs` row with `jobType: "HEALTH_CLEANUP"` and `profile: "HEALTH"`, but does not enqueue through `startLibraryJob`. Those strings are outside the current `JobType` (`SCAN`, `THUMBNAILS`, `REPAIR`, `VERIFY`, `OPTIMIZE`, `METADATA`) and `JobProfile` (`QUICK`, `FULL`, `HEALTH_SCAN`) contracts. The row is therefore not a worker-owned health job; startup recovery can only mark its RUNNING state failed after a restart.
- **Additional data-integrity race:** `orphanedRecords` deletes the media row and derived records from the earlier inspection result without rechecking the source immediately before deletion. If a file is restored or reappears between inspection and cleanup, the source media remains but its catalog row and derived metadata can be deleted based on a stale observation.
- **Safe implementation plan:** use the existing durable library-job engine and typed job/profile contracts rather than a second ad-hoc worker. Make inspection server-owned and restart-aware, use bounded asynchronous no-follow traversal and metadata checks, persist progress and a compact report, and let SSE disconnect only detach the observer. Remove the unused file-path accumulation. For orphan-index cleanup, record candidates and revalidate source identity/state immediately before the destructive database transition; uncertain or unreadable paths must be skipped, not treated as missing. Keep original NAS media immutable. The Health Center should load the last completed report and start/subscribe to a job explicitly rather than scanning the entire library on every page mount.
- **Remaining risk:** current Health Center inspection and cleanup can stall the API on slow NAS, consume memory on large libraries, and act on stale missing-file observations. No production or NAS data was modified by this audit.

### Medium (P2): Health Center metadata rebuild reports a queue action that is never queued

- **Affected workflow:** Health Center's `rebuildMetadata` cleanup action.
- **Status:** **found; fix pending.**
- **Evidence/root cause:** `POST /media/cleanup` handles `rebuildMetadata` by sending the progress text “Metadata rebuild is queued for the next library scan.” It does not call `startLibraryJob`, insert a METADATA worker job, or otherwise schedule work, then marks the cleanup record DONE. The UI exposes this action, so the message is a false success.
- **Safe correction:** enqueue the existing `METADATA` job with the supported `HEALTH_SCAN` profile through the existing job engine, or remove/disable the action until that integration exists. Return the actual job ID/status and distinguish “queued” from “completed”.
- **Remaining risk:** users can currently believe a metadata rebuild has been scheduled when no worker was started.

### Medium (P2): Health Center SSE errors are treated as progress and selection is cleared

- **Affected workflow:** Health Center cleanup progress, error reporting, and selection retention after partial or failed cleanup.
- **Status:** **fixed; target-tested** on code commit `6ea997da9ff06715faaeaa5cb36aead617016626`.
- **Evidence/root cause:** the server emits named `progress`, `done`, and `error` events. The previous `pages/health.tsx` parsed only the `data:` line and ignored the `event:` name and `done.ok`. A server `error` message was displayed as ordinary progress; when the stream closed, the UI cleared selected actions and reloaded regardless of whether a `done { ok: true }` event arrived. The cleanup job insert also occurred after `writeHead(200)` but before the route's `try`, so a database insert failure could escape the SSE error path after response headers had been sent.
- **Fix:** added a typed Health Center SSE parser for named progress, completion, and error events; the page now displays named errors, rejects unsuccessful or missing completion events, and clears selected actions only after an explicit `done { ok: true }`. The server now creates its cleanup journal row inside the guarded route lifecycle and reports insertion failures through the SSE error event. A failure to persist the journal's FAILED state no longer masks the original error delivered to the client.
- **Regression coverage:** new parser tests cover progress/done/error events, malformed payloads, unknown events, and count normalization. A page contract test asserts selections are not cleared before successful completion. The API health-scan test now asserts cleanup job creation is inside the SSE error boundary.
- **Commit:** `6ea997da9ff06715faaeaa5cb36aead617016626`.
- **Target validation:** Fast Validation run [#1357](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42343942264) on the exact code commit passed its Linux `validate` job `128317485586`: workspace typecheck, frontend SSE parser tests, and targeted backend regressions including the new cleanup job-creation boundary test. The Windows archive/updater smoke job was still in progress when this report update was prepared; do not treat this as full Fast Validation until that job completes.
- **Remaining risk:** this fixes the stream's outcome reporting, not the Health Center architecture. Full-library inspection and cleanup still perform synchronous NAS I/O in the request; cleanup is not yet a durable worker-owned job; the stale missing-file observation race and metadata-rebuild no-op remain open. No NAS or production database data was changed.

## November 6 — Synchronous filesystem checks remain on media and archive request paths

### Medium (P2): NAS-backed media requests still perform synchronous metadata and file reads

- **Affected workflows:** media streaming, thumbnail delivery, archive preview, and media rename.
- **Status:** **found; asynchronous no-follow migration pending.**
- **Evidence/root cause:** `GET /media/file/:id/stream` in `routes/media.ts` calls `existsSync` and `statSync` on the source before streaming. `GET /media/:id/thumbnail` calls `isThumbnailFileValid`, which uses synchronous stat/open/read operations to validate the WebP header, including on cache hits. Archive preview in `routes/archives.ts` performs synchronous exists/stat checks. The media rename route also uses synchronous directory enumeration and filesystem operations for portable-name collision checks and rename.
- **Impact:** these handlers are asynchronous at the Express boundary but their synchronous filesystem calls still block the API event loop. On SMB/NAS mounts, a slow metadata response can stall unrelated API requests.
- **Safe correction:** reuse the existing storage-root policy but introduce async, no-follow file-handle validation with descriptor/path identity checks; migrate stream, thumbnail, archive preview, and rename call sites in coherent batches. Preserve range handling, content-type checks, authorization, and fail-closed behavior. Add event-loop-yield and replacement-race tests.
- **Remaining risk:** no change made in this batch; media and archive requests can still block on slow NAS metadata operations.

## November 6 — Database schema readiness marker can bypass required migrations

### High (P1): launcher schema markers are not bound to the selected database or actual schema

- **Affected workflows:** installed Windows startup, developer startup, API startup, and any deployment that sets `WILLARD_SCHEMA_READY=1`.
- **Status:** **found; safe schema-verification design required; no database mutation performed.**
- **Evidence/root cause:** `desktop/WillardMediaCenter.ps1` fingerprints `setup-db.cjs` and `version.json`; `scripts/launcher/start.ps1` fingerprints `setup-db.cjs` and `artifacts/api-server/src/app.ts`. Neither marker includes the selected `DATABASE_URL` identity or queries the actual database before skipping setup. Both set `WILLARD_SCHEMA_READY=1`. `artifacts/api-server/src/index.ts` trusts that variable and skips `bootstrapSessionTable()`, which otherwise runs the required schema under the existing `withSchemaBootstrapLock`.
- **Observed database evidence (user-provided, read-only):** the inspected database reported `organization_jobs` exists, `lease_token` is missing, and `willard_schema_versions` contains only versions 1 and 2. Current `setup-db.cjs` declares schema version 3 and includes `ALTER TABLE organization_jobs ADD COLUMN IF NOT EXISTS lease_token text`. This confirms a real schema mismatch in the inspected database; it does not prove which event (database target change, restore, or later schema alteration) caused it.
- **Safe implementation plan:** add a reusable `verifyRequiredSchema(client)` to `setup-db.cjs` that checks the recorded current schema version and critical required tables/columns, including `organization_jobs.lease_token`. Under the existing API schema advisory lock, verify first, run the existing idempotent `runRequiredSchema` only when needed, then verify again and fail closed if still incomplete. Do not trust `WILLARD_SCHEMA_READY` as a substitute for verification. Add unit tests for version-2 history, missing columns with a version-3 row, wrong database target, successful post-migration verification, and failed verification; use a disposable PostgreSQL database for integration. Do not run migrations against the user's connected database without explicit approval.
- **Remaining risk:** a matching local marker can currently cause the API to start without required columns. The observed database remains unchanged by this audit.

## November 6 — Windows installed-product prepared-phase recovery remains blocked

### Critical (P1): recovery launcher is inside the install directory that the updater moves away

- **Affected workflow:** Windows installed-product update interrupted after the old install directory is moved to its backup but before the candidate directory is installed.
- **Status:** **blocked; architecture correction and current-head installed-product lifecycle validation required.**
- **Reconfirmed failure:** Windows installed-product lifecycle run [#42292725030](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42292725030) failed on older code/test head `347b8cdbd9c093aae216920d33c25a48f6009358`. Its log reports `Installed launcher is missing before 'start': C:\WillardLifecycle\wl_life_109f4310\desktop\WillardMediaCenter.ps1`. The smoke fixture moves the live `InstallRoot` to the prepared backup, leaves the candidate at a sibling path, then tries to invoke the launcher from the now-missing `InstallRoot`. The recovery function is inside that same moved directory, so it cannot run. The installer log confirms the launcher was installed before the simulated crash; this is not simply a missing payload at initial install.
- **Safe implementation plan:** add a small stable recovery bootstrap outside the mutable install directory, in a persistent application-data/program-data location. It must validate the journal version and all sibling path constraints before restoring the previous install, preserve the rollback backup on ambiguous state, and launch the in-install launcher only after the live directory is restored. Keep application data outside the install tree and coordinate legacy data migration with the installer. Do not patch the test to skip the missing-launcher state or delete the backup.
- **Validation limitation:** Fast Validation's Windows archive/updater smoke passing does not validate installed-product lifecycle recovery. The lifecycle workflow has not run on the current head `4096d1d15ef127e53685037cec5da576383263d3`; the connected GitHub actions operations used in this audit did not expose a workflow-dispatch action to trigger its manual run.
- **Remaining risk:** an interruption in the prepared phase can leave the user with no launcher at the shortcut target and no in-place recovery entry point. Do not call PR #2 merge-ready until a stable external bootstrap and clean-machine installed-product lifecycle tests pass.


## November 7 — Health Center metadata rebuild now starts the durable worker

### Medium (P2): Health Center reported a metadata rebuild queue action without starting any work

- **Affected workflow:** Health Center selective cleanup, metadata refresh, and the global Library Jobs surface.
- **Status:** **fixed; regression tests added; validation pending** on code/test commit `6c35eccd185614a4c636a7d28576ef7ef305a6c7`.
- **Evidence/root cause:** the `rebuildMetadata` branch emitted “Metadata rebuild is queued for the next library scan” but did not call the existing library job engine, create a METADATA job, or otherwise schedule work. The route then marked its temporary `HEALTH_CLEANUP` row DONE and emitted `done { ok: true }`, so the UI presented a successful queue operation that never happened.
- **Fix:** Health Center now calls the existing `startJob` API with `jobType: "METADATA"` and the supported `HEALTH_SCAN` profile. It first marks its temporary cleanup row DONE to release the library's partial unique active-job claim. It checks storage/capacity errors returned by the job engine. If the engine reports an existing active job, the route accepts it only when the durable row is a RUNNING METADATA job; it does not misreport a concurrent scan or paused/interrupted job as a successful metadata refresh. The actual metadata job ID is included in progress, completion, and cleanup summary data. The UI label now says “Rebuild outdated metadata now”.
- **Regression coverage:** the API contract test verifies the METADATA/HEALTH_SCAN start call, storage/error handling, existing-job type/status check, and release of the temporary claim before starting the worker. The frontend contract test verifies the action label reflects immediate worker execution.
- **Commit:** `6c35eccd185614a4c636a7d28576ef7ef305a6c7`.
- **Validation:** Fast Validation and Dependency Review are pending for this code/test commit. No test or CI success is claimed yet.
- **Remaining risk:** this corrects the metadata action only. Health Center's full-library inspection and cleanup still use synchronous NAS filesystem operations inside request handlers; the temporary `HEALTH_CLEANUP` row is not a restart-aware worker. The stale missing-file observation race and durable Health Center inspection/cleanup architecture remain open. No production database or NAS media was changed.


## November 7 — Dependency Review no longer cancels an in-progress PR audit

### Medium (P2): Dependency Review cancelled the previous head when the next PR commit arrived

- **Affected workflow:** PR dependency advisory review and audit commit validation.
- **Status:** **workflow corrected; validation pending** on the workflow/report commit.
- **Evidence/root cause:** Dependency Review run [#42348768299](https://github.com/christopherlwillard-debug/willard-ai/actions/runs/42348768299), associated with code/test commit `6c35eccd185614a4c636a7d28576ef7ef305a6c7`, was cancelled when the following report-only commit `6976605017ad083bb724b824480820c61424bbbc` synchronized PR #2. The workflow's concurrency group had `cancel-in-progress: true`. Its pull-request path filter is evaluated against the PR diff, which already contains dependency manifest/lockfile changes, so later docs-only commits still trigger another dependency review and cancel the in-progress run.
- **Fix:** changed Dependency Review concurrency to `cancel-in-progress: false`. A newer run may wait behind the active run instead of cancelling it. The latest head still receives its own review.
- **Commit:** pending.
- **Validation:** a new Dependency Review run on the latest head is expected; no success is claimed until the high/critical production advisory gate completes.
- **Remaining risk:** GitHub concurrency allows only one pending run per group, so rapid successive updates may replace an older pending run. The latest PR head remains the required validation target. Fast Validation already uses `cancel-in-progress: false` and preserves its in-progress Windows smoke job.
