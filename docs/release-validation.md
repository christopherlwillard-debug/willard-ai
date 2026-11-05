# Release validation

## Dependency audit and Metro recheck — August 24, 2026

The dependency audit was rerun after upgrading the direct API dependencies and
adding narrowly scoped workspace overrides for vulnerable transitive versions.

- The audit still reports `image-size@1.2.1`, pulled through
  `@expo/cli > @expo/metro > metro`.
- npm's latest published `image-size` release remains `2.0.2`; the current
  advisories affect every published version through `2.0.2` and report no
  patched version. This package is not used by the API server or the
  production web application.
- Expo web asset processing was rechecked successfully with
  `pnpm --filter @workspace/willard-mobile exec expo export --platform web`.
- Workspace typechecking was rechecked successfully with `pnpm run typecheck`.
- Resolved transitive findings: `brace-expansion`, `ip-address`, `js-yaml`,
  and the older `sharp@0.34.5` copy.

The remaining development-tooling finding should be reevaluated when Metro or
`image-size` publishes a fixed release. Do not replace it with an arbitrary
major version without testing Expo/Metro asset processing. The exception
remains intentional until then.

## Windows payload contract

`pnpm run check:artifacts` is the source-of-truth guard for the workspace. It
discovers artifact manifests while skipping generated directories, requires the
single API artifact at `artifacts/api-server/.replit-artifact/artifact.toml` to
own port 8080, and rejects tracked build directories or ZIP files. This keeps
the registered API workflow and release inputs tied to source rather than to a
copied or stale generated tree.

Windows releases are staged only in the ignored `build/windows` directory.
The release builder deletes that directory before every build, builds the web
and API outputs from source, dereferences production dependencies, and removes
application source and package-manager build metadata from the shipped runtime.

Each staged payload contains a deterministic `payload-manifest.json` with the
size and SHA-256 digest of every other file. `validate-release.mjs` checks that
manifest, rejects symlinks and payload drift, verifies the launcher and web
loading assets, and confirms the Windows Node and ONNX runtime files exist.
`make-release.ps1` is the single workflow entry point: it builds once, creates
the ZIP, writes its checksum manifest, and validates that exact staged payload
and ZIP before publication. The published release manifest is Ed25519-signed
with the private key held in GitHub Actions secrets; installed clients embed
the matching public key and reject unsigned or mismatched metadata before
downloading an update.

## Installed Windows updates and signing

The installed launcher checks for updates on each cold start. If its API and
web services are already healthy, another shortcut click opens the existing
app without another update check. A per-user startup mutex serializes concurrent
launches and update attempts; waiting launches recheck the running services
before proceeding.

The launcher verifies the signed release manifest and semantic version before
selecting an update. The default `/releases/latest/` endpoint is the stable
release channel. The update ZIP is downloaded to a partial file only after a
HEAD request reports a positive size no larger than 1 GiB. The downloaded size,
manifest-bound SHA-256, and signed artifact binding are checked before
extraction. Partial files are removed on failure and at the next startup.
Update failures leave the installed version in place; a candidate is not
promoted until both local services pass their health checks.

Update diagnostics are written to
`%LOCALAPPDATA%\Willard Media Center\logs\update.log`, with one rotated backup
at `.1`. The log records update stage, outcome, error type, and HTTP status,
not raw exception text or credentials. `last-update-check.txt` is updated only
after the API and web health checks succeed.

The pinned Ed25519 public-key fingerprint (SHA-256 over DER SubjectPublicKeyInfo)
is `312e013a8d547959823dff9dcc5114de659361018b7e5e1e337122481d4cbe97`.
The corresponding private key is supplied to the release workflow through the
`WILLARD_RELEASE_SIGNING_PRIVATE_KEY` GitHub Actions secret. The manifest's
signature binds the ZIP checksum and release metadata; the ZIP does not have a
separate detached signature. To rotate the key, ship a client that trusts the
replacement public key before signing a release with the replacement private
key. Never commit either private key.

Public installers require Authenticode signing. The release workflow expects
the `WILLARD_WINDOWS_SIGNING_CERTIFICATE_BASE64` and
`WILLARD_WINDOWS_SIGNING_CERTIFICATE_PASSWORD` GitHub Actions secrets, with a
certificate that has the Code Signing EKU and the expected Willard publisher.
The recorded failed build created an installer but stopped because the
certificate secret was missing; that run did not pass the trust check or
publish a release.

Manual `workflow_dispatch` runs default to validation-only. In that mode the
installer may be unsigned so the standard-user lifecycle can be tested without
a code-signing certificate; the trust-metadata step and publication are
skipped. Such an unsigned installer is only for validation and must not be
distributed. Push releases and manual runs with validation-only disabled still
require Authenticode signing.