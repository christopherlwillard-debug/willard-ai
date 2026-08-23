---
name: Node 24 local test imports
description: Node's experimental strip-types runner needs explicit local TypeScript import extensions through imported dependencies
---

Direct Node 24 tests using `--experimental-strip-types` do not apply the bundler's extension resolution. Any local TypeScript module reached by the test must use an explicit `.ts` import suffix.

**Why:** A test can fail during module resolution before any assertions run even though the same imports work in the application bundler and typecheck.

**How to apply:** When adding a directly runnable Node test, follow the import graph into local modules and use `.ts` suffixes for each relative import.