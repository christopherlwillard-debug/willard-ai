---
name: Workspace lib stale declarations
description: Composite workspace libs emit declarationOnly dist; rebuild after schema changes or dependents fail typecheck
---

Rule: after adding tables/exports to a composite workspace library (tsconfig `composite: true`, `emitDeclarationOnly`, outDir dist — e.g. `lib/db`), rebuild declarations with `npx tsc -b lib/<name>` before typechecking dependents.

**Why:** the package has no `build` script and its package.json exports point at `src/*.ts`, but TypeScript project references resolve types from the stale `dist/*.d.ts`, so dependents report "has no exported member" even though runtime (tsx/esbuild) works fine.

**How to apply:** whenever `@workspace/db` (or similar lib) schema changes and api-server `tsc --noEmit` shows missing exports, run `npx tsc -b lib/db` first — don't hunt for a pnpm build script; there is none.
