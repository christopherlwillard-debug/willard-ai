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

## Organization worker lease is not fenced against stale workers (2026-11-04)

- Confirmed a multi-worker correctness and data-loss risk in the organization execution/recovery lifecycle. The five-minute lease is represented only by `status` and `stageUpdatedAt`; it has no unique owner/fencing token.
- `startOrganizationJobHeartbeat` updates a row using only job ID, NAS path, and status. If worker A is paused long enough for its lease to expire and worker B successfully reclaims the job, worker A can resume and refresh worker B's lease because both workers share the same status. The old worker can also continue filesystem operations.
- Related stage and file-move checkpoints are not fenced to a specific execution attempt: stage writes filter only by job ID, and file-move journal writes also filter only by job ID. A stale worker can therefore overwrite the new worker's stage timestamp or recovery journal. This undermines the intended stale-lease compare-and-swap and can produce overlapping work or incomplete rollback records.
- Source evidence: `startOrganizationJobHeartbeat` filters by `id`, `nasPath`, and `status` only; the resume claim changes the same status to `executing` without assigning an attempt identity; `setStage` and the per-file `fileMoves` checkpoint do not include an attempt identity in their update predicates.
- No code change was made. A safe fix needs a durable per-attempt lease/fencing token (or equivalent database-backed ownership generation), conditional heartbeat/stage/journal updates, and checks that prevent a superseded worker from beginning additional filesystem mutations. The design must cover initial execute, resume, rollback, capacity-admission failure, and crash recovery. An in-memory mutex or status-only predicate is insufficient across processes.
- Validation: source inspection only; no regression test or runtime concurrency test was run because the ownership mechanism is not implemented. Do not treat this as fixed or validated.
- Priority: high. Until fencing is implemented, a worker paused beyond the five-minute lease can potentially overlap a recovery worker. Avoid manually resuming or rolling back a job while its original worker may still be alive.


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
- **Organization jobs:** exclusive destination moves, pre-move intents, checksum-verified rollback, journal checkpoint failure handling, resume journal retention, and final destination integrity checks have been added across the branch. Stale-worker fencing and durable backups for `conflictPolicy=replace` remain critical open items.
- **Conversion/optimization:** pending jobs now use an atomic execution claim. Finalization remains critical: partial per-file failures can still be followed by staging deletion and a `done` status, and retry can discard staging after interrupted finalization. Do not use replace/archive/recycle on the only copy of valuable files until the durable finalization journal and recovery design is implemented.
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
