# Release validation

## Dependency audit — August 24, 2026

The dependency audit was rerun after upgrading the direct API dependencies and
adding narrowly scoped workspace overrides for vulnerable transitive versions.

- Critical findings: **0**
- High findings: **1**
- Remaining finding: `image-size@1.2.1`, pulled by Expo/Metro development
  tooling. The current upstream release is still `2.0.2`, which is also within
  the affected range; no fixed upstream release is available yet. This package
  is not used by the API server or the production web application.
- Resolved transitive findings: `brace-expansion`, `ip-address`, `js-yaml`,
  and the older `sharp@0.34.5` copy.

The remaining development-tooling finding should be reevaluated when Metro or
`image-size` publishes a fixed release. Do not replace it with an arbitrary
major version without testing Expo/Metro asset processing.