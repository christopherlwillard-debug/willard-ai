---
name: Node 24 database test imports
description: Node's strip-types test runner requires explicit TypeScript file extensions in the shared DB package.
---

Node 24's `--experimental-strip-types` runner does not resolve directory or extensionless imports in the TypeScript database package. Keep the DB package's source imports explicit and enable `allowImportingTsExtensions` for its declaration-only build so integration tests can use the mandated runner.

**Why:** Recovery integration tests need the real database package under the same runner used by the API test workflows; relying on a specifier-resolution compatibility flag would make the documented command fail.

**How to apply:** When adding Node 24 TypeScript integration tests that import `@workspace/db`, run them with `--experimental-strip-types` alone and preserve explicit `.ts` imports in the DB package.