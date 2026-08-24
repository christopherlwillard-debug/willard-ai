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