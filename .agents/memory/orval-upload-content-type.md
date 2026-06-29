---
name: Orval binary upload in the zod target
description: How to model binary/file uploads in openapi so orval's zod client doesn't break the libs typecheck
---

This repo generates two orval targets from one openapi.yaml: `api-client-react`
(has DOM lib) and `zod` (`lib/api-zod`, node-only, `lib: es2022`, `types: []`).

For a file upload, model the request body as `multipart/form-data` referencing a
**named component schema** (e.g. `LogoUpload` with `file: {type: string, format:
binary}`), NOT an inline body.

**Why:**
- An inline multipart body makes orval emit a zod const AND a generated type with
  the same operation-derived name (`<Op>Body`) into the zod package; `index.ts`
  re-exports both via `export *` → TS2308 duplicate-export error. A named component
  gives the type a distinct name (the schema name), avoiding the clash.
- The generated zod/type code references DOM globals `File`/`Blob`, which don't
  resolve under the base `lib: ["es2022"]`. `lib/api-zod/tsconfig.json` adds
  `"dom"` to `lib` so they typecheck.

**How to apply:** When adding any binary upload endpoint, define a component schema
for the body, ref it from `multipart/form-data`, regenerate, and confirm
`pnpm -w run typecheck:libs` has no NEW errors (pre-existing
integrations-openai-ai-react react-type errors are unrelated). The react client
then builds `FormData` itself; call it as `uploadFn({ file })`.
