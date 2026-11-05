| Medium | Private media stream I/O error semantics — thumbnail/logo/media preview | target-tested | Regression changes documented in PR body; latest end-to-end status requires fresh CI confirmation | Browser-level interrupted-stream behavior remains to be exercised |
| High | Developer updater journal replacement — Windows update/recovery | fixed (source-reviewed) | Current Windows smoke #753 exposed leftover journal temp/backup artifact(s); this batch removes backup-file creation and adds a source regression | Fresh Windows updater integration rerun pending; preserve old journal on replacement failure |

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

## 2026-11-05 audit batch — Windows developer updater journal cleanup

**Confirmed validation failure:** Fast Validation run #753 passed the Linux validation job, including generated contracts, workspace typecheck, release/storage contracts, official Linux 7-Zip checks, PostgreSQL conversion-lock and restart-recovery tests, and the targeted backend regressions. The Windows job also passed PowerShell parsing, fresh .env secret generation and Node readability, storage migration concurrency, NAS path safety, conversion finalization, official Windows 7-Zip hash and metadata checks, and the packaged updater journal smoke. It failed in the developer updater smoke at the new atomic journal replacement assertion: one or more temporary or backup artifacts remained after a successful replacement. The log did not print artifact names, so the precise filesystem artifact was not independently identified.

**Correction:** The developer journal now uses same-directory System.IO.File.Replace with a null backup path. The previous complete journal remains the destination if replacement fails, and the operation no longer asks Windows to create a separate backup artifact. The temporary file remains protected by finally cleanup. Added a focused source regression requiring the null backup argument and rejecting the removed backup variable. Improved the Windows smoke failure message to print any remaining artifact names.

**Validation status:** Source and regression changes are committed together. The Windows integration smoke must pass on the new head before this finding is marked integration-tested or fully validated. Run #753 remains a failure and is not retroactively relabeled. Dependency Review #517 passed on the previous head; the new code does not change dependencies.

**Remaining risk:** This smoke covers the developer updater journal atomic replacement and recovery states, not a clean standard-user installer upgrade/uninstall lifecycle. That separate end-user validation remains blocked.