---
name: pnpm patch install verification
description: Verify workspace package patches with pnpm itself, not only with git apply.
---

Do not assume `git apply --check` proves a `patchedDependencies` change is valid for this workspace. Run `pnpm install` after changing a package patch and verify the exact lockfile path and dependency graph. If the patch cannot be applied, keep installs usable and report the advisory as unresolved rather than claiming the patch worked.

**Why:** Local `deepmerge` patch rewrites passed Git's patch check but failed during pnpm installation, so the dependency advisory remained open.

**How to apply:** Before editing a package patch, compare it with the exact installed package source and preserve the patch metadata and whitespace. Verify with lockfile-only resolution followed by a complete install and a dependency audit.

Published deepmerge 4.3.1 files use different tab indentation in `index.js`, `dist/cjs.js`, and `dist/umd.js`; use exact, minimal hunks for each file. pnpm audit may still list the advisory for the published version after patchedDependencies is applied, so record the mitigation and prove it with runtime tests.
