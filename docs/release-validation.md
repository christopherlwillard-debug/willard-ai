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