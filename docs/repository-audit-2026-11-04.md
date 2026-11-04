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


## Legacy 7-Zip binary dependency risk (2026-11-04)

- Confirmed the Linux x64 binary shipped by `7zip-bin@5.2.0` is built from upstream p7zip 16.02. Its checked-in build script downloads `p7zip_16.02_src_all.tar.bz2` from SourceForge. The upstream binary-refresh PR remains open, so the package currently used by the API does not receive the current official 7-Zip parser fixes.
- Current security advisories document multiple memory-corruption flaws in p7zip/old 7-Zip, including a heap buffer overflow in the NTFS handler fixed in official 7-Zip 26.01. The API parses untrusted archives using this executable, so this is a high-priority dependency exposure, not merely a version freshness concern.
- Candidate replacement: `7zip-bin-full@26.5.1`, which packages official upstream 7-Zip 26.05 binaries for Windows, Linux, and macOS and exposes a `path7z` executable path. This is a third-party repackaging project and is relatively new; the complete package includes multiple platforms and adds significant size, so it should not be adopted without testing runtime behavior and deployment footprint.
- Added a compatibility smoke test that exercises the candidate's real static binary (`path7zzs`) through `node-7z`: version check (26.01+), archive creation, `techInfo` list metadata parsing, POSIX symlink metadata detection on Linux, and extraction. Fast Validation now installs the pinned candidate into a temporary CI-only directory on Linux and Windows and checks Windows create/extract behavior; this does not yet change the production dependency. The candidate compatibility run is pending.
- References: `https://raw.githubusercontent.com/develar/7zip-bin/master/linux/x64/do-build.sh`; `https://github.com/develar/7zip-bin/pull/28`; `https://www.debian.org/lts/security/` (DLA-4681-1, 2026-07-13); `https://www.npmjs.com/package/7zip-bin-full`.


## Temporary NAS staging directory symlink containment (2026-11-04)

- `getTempDir` previously used recursive `mkdir` under `<library>/WillardAI/temp` without canonicalizing existing ancestors. A symlink at `WillardAI`, `temp`, or the per-job directory could redirect temporary archive/media work outside the configured library.
- Added `ensureDirectoryWithinRoot`, which canonicalizes the root, retains the target's lexical suffix so every descendant can be checked with `lstat`, rejects all descendant symlinks (including links to another path inside the library), creates directory components individually, and returns the canonical path. `getTempDir` now validates the shared `temp` directory and makes it private before creating per-job directories, then applies private permissions to each job directory. Archive extraction revalidates the staging chain immediately before resetting it, and redundant recursive `mkdir` calls were removed.
- Added regression tests for a normal private temp directory and symlink escapes at each of the three path levels. Included the tests in Fast Validation. Latest test result is pending.

## Invalid 7-Zip overwrite switch (2026-11-04)

- The organize extractor passed `overwrite: "qs"` to `node-7z`, which emits `-aoqs`. The documented 7-Zip switch accepts exactly one mode character (`a`, `s`, `t`, or `u`); the actual 26.05 candidate binary rejected `-aoqs` with `Command Line Error: Too long switch`, so valid 7z-family archive extraction could fail before writing any files.
- Changed the extractor to `overwrite: "a"` (overwrite all) because the staging directory is deliberately cleared and recreated before extraction. This avoids prompts and uses a valid switch. The integration smoke now checks the real CLI path and asserts the application route no longer uses `qs`.
- The first candidate smoke run failed on the invalid option, which confirmed the defect. The corrected candidate run is pending; the production dependency has not yet been upgraded.


## NAS temporary directory symlink containment (2026-11-04)

- Confirmed `getTempDir()` used recursive `mkdir` under `<LIBRARY>/WillardAI/temp/<job>`, without checking whether `WillardAI` or `temp` had been replaced by a symlink. A local filesystem/NAS user able to alter those directories could redirect temporary archive extraction and media staging outside the configured library.
- Added `ensureDirectoryWithinRoot()` to canonicalize and check the target against the configured NAS root, then create and verify each directory component without following symlinks. `getTempDir()` now secures the shared `temp` parent and per-job directory with private permissions before returning the canonical path.
- Added regression tests for normal private directory creation and symlink escapes at `WillardAI`, `temp`, and the per-job directory. Added the suite to Fast Validation.
- Validation status: the prior Fast Validation run passed typecheck, release/storage contracts, and the Windows updater smoke job, but was cancelled after the candidate 7-Zip compatibility step failed. The NAS-specific suite has not yet completed in CI.
- Candidate 7-Zip compatibility test failure was traced to an invalid `node-7z` option (`overwrite: "qs"` emitted unsupported `-aoqs`). Corrected the test to use the wrapper's supported `$overwrite: "a"` option; production 7-Zip dependency remains unchanged pending a passing Linux/Windows compatibility run.


## CI dependency-review prerequisite (2026-11-04)

- The new dependency-review workflow was invoked for the audit PR but GitHub returned: `Dependency review is not supported on this repository. Please ensure that Dependency graph is enabled`. This is a repository security-setting prerequisite, not a code or dependency vulnerability finding.
- The action cannot evaluate pull-request dependency changes until GitHub's Dependency graph feature is enabled for this repository. The scheduled `pnpm audit --prod --audit-level high` path remains separate and is not a substitute for PR diff review.
- Remaining external configuration: enable Dependency graph under repository Settings → Code security and analysis, then rerun the dependency-review check. No repository settings or main-branch changes were made as part of this audit.


## Dependency-review workflow compatibility (2026-11-04)

- The GitHub `dependency-review-action` failed on this repository because GitHub's Dependency Graph feature is not enabled for the repository. This is a repository setting limitation, not a dependency finding.
- Replaced the PR job's dependency-review action with `pnpm audit --prod --audit-level high`, which evaluates the locked production dependency graph without requiring GitHub Dependency Graph. The scheduled audit already uses this pnpm audit path. The updated PR audit run is pending.
