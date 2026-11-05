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
- The API server pins `7zip-bin@5.2.0`. Its upstream Linux x64 build script downloads p7zip 16.02, and upstream PR #28 remains open; its author explicitly says the current binaries contain vulnerabilities and proposes replacing them with official 24.09 binaries. See [the build script](https://github.com/develar/7zip-bin/blob/master/linux/x64/do-build.sh) and [the unmerged binary update PR](https://github.com/develar/7zip-bin/pull/28).
- A maintained alternative, `7zip-bin-full@26.5.1`, bundles official 7-Zip 26.05 binaries and publishes npm provenance, but the package is about 76 MB and changes the binary API from `path7za` to `path7z`. I did not change the dependency in this pass: the bundle-size increase and third-party package/platform compatibility need a deliberate packaging review and Windows validation before adoption. See [the package and provenance details](https://www.npmjs.com/package/7zip-bin-full).
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
- The first Windows journal smoke exposed a runtime compatibility issue: the runner's current .NET rejected a null backup-file argument to `File.Replace`. The writer now supplies a unique same-directory backup path and removes it after replacement. The journal smoke is included in the non-publishing Windows job in Fast Validation; the corrected run is pending. No release workflow was run and no release artifacts were published.


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
- Fast Validation has not yet run against this commit; test is included in the existing database-backup test command.


## Production dependency advisories and patch alignment (2026-11-04)

- The API server's direct Sharp update alone was insufficient: Transformers retained vulnerable Sharp 0.35.2. A workspace-wide Sharp 0.35.5 override now forces the patched release throughout the dependency graph.
- A high-severity Zod memory-exhaustion advisory affected versions below 4.6.6. The workspace Zod catalog is upgraded to 4.6.7 and the mobile zod-validation-error package is aligned to v4.0.2. Full workspace typecheck passed with the Zod v4 change.
- The next advisory inventory found 16 moderate issues. Updated workspace overrides for qs 6.16.1, ip-address 10.7.4, postcss 8.5.23, uuid 11.1.1, glob 14.0.2, minimatch 11.0.1, and the affected brace-expansion ranges removed those moderate advisories from the production dependency graph.
- The regenerated lockfile completed a frozen install and full workspace typecheck. The latest production audit passed its high/critical gate and now reports only one low-severity advisory: deepmerge prototype poisoning in the Expo configuration dependency chain. The advisory currently lists no patched release, so it remains documented rather than forcing an unreviewed fork.
- GitHub Dependency Graph is disabled for this repository, so the PR dependency gate uses pnpm audit instead of GitHub's dependency-review action. The lockfile refresh workflow is restricted to this audit branch; it does not publish releases or modify main.


## PostgreSQL snapshot process failure handling (2026-11-04)

- The backup snapshot holder wrote its SQL to child stdin before registering stdin error handling. If psql exited immediately, a broken-pipe error could be emitted by the writable stream without a listener. The 10-second timeout also sent only SIGTERM and did not guarantee termination if the child remained alive.
- Extracted the process protocol into postgres-snapshot-process.mjs. It registers stdout, stderr, stdin, spawn-error, and close handlers before writing; bounds stdout to 64 KiB and stderr to a 4 KiB tail; handles write callback and stream errors; and escalates from SIGTERM to SIGKILL after a grace period. Termination is idempotent.
- database-backup.mjs now uses the guarded helper. Added regression tests for successful snapshot token capture, stdin EPIPE, and timeout termination/escalation. The tests are included in the existing database-backup test suite. The first CI attempt exposed an escaped-newline error in the success-case fixture (the EPIPE and timeout tests passed); the fixture was corrected in commit 8f8e722. Validation of that corrected fixture is pending.


## Production dependency audit result (2026-11-04)

- The regenerated dependency graph completed a frozen install and full workspace typecheck. `pnpm audit --prod --audit-level high` passed with only one low advisory remaining; no high, moderate, or critical production advisories remained.
- The high Sharp findings were eliminated by forcing Sharp 0.35.5 across direct and transitive dependency paths. The high Zod memory-exhaustion advisory was eliminated by upgrading the shared Zod catalog to 4.6.7 and aligning `zod-validation-error` to 4.0.2. The full workspace typecheck passed with these versions.
- The dependency refresh workflow completed successfully and regenerated the lockfile. At the time of this entry, the next code validation was pending for the PostgreSQL snapshot process regression suite and official 7-Zip candidate compatibility checks; later completed validation results are recorded below.


## NAS temporary-directory symlink containment (2026-11-04)

- `getTempDir()` previously used recursive directory creation under `<library>/WillardAI/temp/<job>`. That followed existing symlinks and could place temporary archive/media staging outside the configured library.
- Added `ensureDirectoryWithinRoot()` to validate the lexical path beneath the configured root, inspect each existing component with `lstat`, reject symlinks and non-directory components, create one component at a time, recheck after creation, and return the canonical path. The shared `temp` parent and each job directory are created with private mode `0700` on POSIX.
- `getTempDir()` now validates the shared parent before creating a job directory. Tests cover symlink escapes at `WillardAI`, `temp`, and the job directory, in-root cross-job symlink substitution, and private permissions. The first CI run exposed an assertion expecting the wrong error wording; the assertion now matches the fail-closed symlink error. Final validation is pending.

## Further production dependency patching (2026-11-04)

- The first advisory inventory reported 16 moderate and 1 low findings after the high/critical issues were removed. Updated workspace overrides to patched versions: `qs` 6.16.1, `ip-address` 10.7.4, `postcss` 8.5.23, `brace-expansion` 1.1.21/2.1.7/5.0.12, `uuid` 11.1.1, `glob` 14.0.2, and `minimatch` 11.0.1.
- The regenerated lockfile completed a frozen install and full workspace typecheck. The production audit now reports no critical, high, or moderate advisories; one low advisory remains for `deepmerge` 4.3.1 in the Expo configuration tooling chain. The advisory database lists no patched release. This is documented as a residual low-severity issue rather than forcing an unreviewed fork.
- The `uuid`, `glob`, and `minimatch` overrides cross major versions for transitive Expo tooling. Workspace typecheck and the Expo CLI configuration smoke are required before treating those overrides as runtime-validated.


## Latest integrated validation result (2026-11-04)

- Fast Validation run `41930470325` completed successfully on audit commit `a1d844ce85c7b6d536d5f283ac239d45684fe96a`. Both `validate` and `windows-updater-smoke` jobs passed. This includes workspace typecheck, generated API contract checks, desktop web-server safety tests, database backup and PostgreSQL snapshot process tests, release/storage contracts, NAS temporary-directory symlink tests, targeted backend regressions, official 7-Zip candidate compatibility on Linux, and Windows updater/7-Zip smoke tests.
- The PR dependency-review workflow also passed on the same commit. The separate production dependency refresh workflow previously completed a frozen install, full workspace typecheck, and production audit: no critical, high, or moderate advisories remain; one low `deepmerge` advisory in Expo configuration tooling remains without a patched release.
- Deployment-path review narrows the residual archive dependency risk: Replit pins official 7-Zip 26.05 in `replit.nix`; Windows release staging downloads hash-verified official 26.05 assets and includes `7z.exe`, `7z.dll`, and the license in `api-runtime/vendor/7zip`. `resolveSevenZipPath` prefers that packaged path, so these packaged deployments do not use the `7zip-bin@5.2.0` fallback. Residual limitation: unprovisioned Linux/macOS and local development can still fall back to `7zip-bin@5.2.0`; the legacy dependency remains in the graph.
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
- The implementation and tests are committed to the audit branch. Latest Fast Validation after the full set of 7-Zip resolver changes is pending; the individual ZIP/TAR test assertions are included in the targeted backend suite.


## Remove vulnerable legacy 7-Zip fallback (2026-11-04)

- The API previously preferred official 7-Zip from `WILLARD_7ZIP_PATH`, the packaged `vendor/7zip` directory, or PATH, but silently fell back to `7zip-bin@5.2.0` when none existed. On Linux this package supplies p7zip 16.02, leaving unprovisioned environments exposed to old archive-parser vulnerabilities.
- Removed the direct `7zip-bin` dependency and its lockfile entries. The resolver now verifies the executable reports official 7-Zip 26.01 or newer before selecting it. Old, missing, or unrecognized executables are skipped. Archive routes resolve the executable lazily and return an actionable error when none is available, so the API itself still starts and non-archive functionality remains usable.
- Replit uses the pinned official static 7-Zip 26.05 derivation; packaged Windows builds stage hash-verified official 7-Zip 26.05 into `api-runtime/vendor/7zip`. CI tests both platforms and `node-7z` compatibility. Resolver regression tests cover configured/system/packaged priority, version rejection, missing-binary behavior, and the actionable error. Latest Fast Validation for this resolver/dependency removal is pending.


## Plaintext database backup temporary-file permissions (2026-11-04)

- `createBackup` wrote the unencrypted `pg_dump` file into a randomly named directory under the OS temp root using recursive `mkdir` with default permissions. On POSIX systems with a permissive umask, that directory could be traversable by other local users while the plaintext dump existed, before encryption and secure cleanup.
- Replaced the manually generated directory with `fs.mkdtemp`, which creates an owner-only work directory on POSIX. The raw dump remains inside that private directory until encryption completes; cleanup behavior is unchanged. Added a regression test that verifies the actual directory mode is `0700` on POSIX. Fast Validation for this change is pending.


## Backup retention authenticates manifests before deleting (2026-11-04)

- `pruneBackups` previously used `createdAt` from a structurally valid manifest to sort and delete old backup directories without checking the manifest's AES-GCM authentication tag. An altered creation date could make a valid backup appear expired and cause automatic retention to delete it.
- Retention now reads, decrypts, and verifies each candidate backup using the configured backup secret before considering its authenticated creation date. Corrupt or tampered backup directories are excluded from retention deletion and preserved for manual inspection.
- Extended the PostgreSQL-backed backup/restore integration test: a copied backup has only its `createdAt` changed to 2000, then retention runs with zero-day retention and `keep=1`. The test requires the tampered backup to remain while the authenticated older backup is pruned. Fast Validation is pending.


## Restore plaintext workspace isolation (2026-11-04)

- Restore decrypted the complete database dump into a randomly named file directly under the shared OS temp directory. The file used mode `0600`, but creation was not exclusive and its parent was shared with unrelated processes.
- Restore now creates a unique owner-only operation directory with `mkdtemp`, writes `database.dump` with exclusive `wx` creation, zeroes the dump during cleanup, and removes the private workspace. This reuses the existing backup workspace helper and avoids introducing another dependency.
- Added a regression assertion for private workspace creation, exclusive file creation, and workspace cleanup. Fast Validation is pending for this change.


## Trash manifest crash safety and symlink containment (2026-11-04)

- Restore/expiry previously rewrote the complete trash manifest through a temporary file. On Windows, replacement fell back to deleting the old manifest before renaming the new one; a crash in that interval could erase unrelated recoverable trash entries.
- Manifest removals now append an authenticated-state-independent tombstone record and leave all prior lines intact. `readTrashManifest` applies tombstones when presenting active entries, preserving idempotent removal while making the journal append-only. Unknown/malformed lines remain untouched.
- Manifest path resolution now creates/checks the logs directory component-by-component under the configured library root and rejects symlinks, preventing manifest writes from following a redirected logs directory.
- Added regression tests for active-entry filtering, retained original journal lines, malformed-line preservation, and external logs-directory symlink rejection. Fast Validation is pending.


## Backup subprocess output and plaintext handling follow-up (2026-11-04)

- Bounded stdout/stderr capture for database backup subprocesses so a noisy or misbehaving PostgreSQL utility cannot grow process memory without limit. Regression coverage exercises oversized stdout and stderr tail retention.
- Restore plaintext is now written only inside a private per-operation workspace, with exclusive file creation, zero-overwrite cleanup, and workspace removal. Decrypted buffers used by backup creation, verification, restore, and discovery are explicitly zero-filled after use.
- The first validation after exporting the bounded subprocess helper exposed a duplicate named export (`runTool` was exported both at declaration and in the export list). Removed the duplicate; latest validation is pending.


## Trash entry symlink protection (2026-11-05)

- Trash root directories were already being checked, but individual manifest paths still used a resolver that followed symlinks. A symlink inside `.Trash` pointing at another file inside the trash root could therefore cause restore/removal to act on the target instead of the manifest path.
- Added component-by-component `lstat` resolution for trash paths. It rejects symlinks and non-directory parent components, including links that remain inside the trash root. Manifest insertion, restore reconciliation, purge, and tombstone removal now use this resolver.
- Added a regression test that creates a trash symlink pointing at a different file and verifies removal refuses to follow it and preserves both the target and link. Fast Validation is pending.


## Windows 7-Zip release payload path (2026-11-05)

- The compiled API entry point is `api-runtime/dist/index.mjs`. The resolver resolves `../vendor/7zip` relative to that entry point, so the actual runtime path is `api-runtime/vendor/7zip`. The release builder stages verified official binaries in `deployOutput/vendor/7zip`, which copies to that exact location.
- Added a release-payload contract test that checks the builder staging path and the final API runtime vendor directory against the resolver. The release builder verifies `7z.exe`, `7z.dll`, and `License.txt` are regular files at the final `api-runtime/vendor/7zip` location after copy/merge. The release validator also requires those files and executes the binary to confirm version 26.05.
- Official 7-Zip 26.05 asset SHA-256 values used by the staging scripts were checked against the upstream GitHub release metadata; the Linux x64 archive, Windows extra archive, Windows installer, and 7zr hashes match upstream release digests. Fast Validation is pending.


## Cross-platform ZIP reparse-point and drive-relative path rejection (2026-11-05)

- ZIP preflight previously inspected only the upper 16-bit Unix file mode for symlinks. Windows-created ZIP entries can instead carry `FILE_ATTRIBUTE_REPARSE_POINT` (0x0400) in the lower DOS attribute word; those entries were not rejected by the pre-extraction link check and could reach the extractor before the post-extraction tree inspection.
- ZIP link detection now rejects both Unix `S_IFLNK` modes and the Windows reparse-point attribute. Archive path validation also rejects drive-relative names such as `C:relative.txt`, not only fully-qualified drive paths such as `C:\\outside.txt`.
- Added focused regressions for Windows reparse-point attributes and drive-relative paths. Fast Validation is pending; no validation result is claimed yet.


## Backup cryptographic key buffer cleanup (2026-11-05)

- AES-256-GCM backup creation and restore derive per-operation keys with scrypt. Those key buffers previously remained allocated until garbage collection after cipher use.
- Encryption and decryption now zero the derived key buffers in `finally` blocks, including authentication failures. Added a regression assertion for both paths. Fast Validation is pending.


## Trash restore paths through symlinked NAS mount aliases (2026-11-05)

- The symlink-safe trash resolver returns a canonical path. When the configured NAS root is itself a symlink alias, the manual restore route passes that canonical path back to tombstone removal; a purely lexical root comparison would reject it and leave a stale active manifest record.
- The resolver now accepts either the configured lexical path or its canonical equivalent only when the configured root itself is a symlink alias. Canonical fallback uses lexical normalization rather than realpath on the requested target, so an outside symlink pointing into the library is still rejected. It checks every descendant component for symlinks. The mount-alias regression exercises both the canonical path returned by the route resolver and an outside symlink attempt.
- Fast Validation is pending.


## Temporary job identifiers cannot escape their child directory (2026-11-05)

- `getTempDir` sanitized job identifiers to letters, digits, dots, underscores, and hyphens, but allowed the exact values `.` and `..`. `path.join(tempRoot, "..")` could therefore return the parent `WillardAI` directory, and an empty ID could return the shared temp root instead of a per-job directory.
- Empty and dot-segment IDs now receive unique generated child names. Added regression coverage verifying empty, `.`, and `..` all resolve to distinct directories directly under `WillardAI/temp`. Fast Validation is pending.
