---
name: Drizzle push needs a TTY
description: Why drizzle-kit push fails in this environment and the safe workaround for additive columns
---

`pnpm --filter @workspace/db run push` (drizzle-kit push) throws
"Interactive prompts require a TTY terminal" whenever it hits an ambiguous
resolver step. Agent shells are non-interactive, so push cannot complete.

**Why:** drizzle-kit prompts (create vs rename, schema conflicts) need stdin/stdout
TTY, which the sandbox does not provide.

**How to apply:** For additive, non-destructive changes (new nullable column),
update the Drizzle schema file (source of truth) AND apply the change directly via
SQL: `ALTER TABLE <t> ADD COLUMN IF NOT EXISTS <col> <type>;` (run through the
executeSql sandbox callback). This mirrors the existing `bootstrapSessionTable`
pattern in artifacts/api-server/src/app.ts. For destructive/ambiguous migrations,
ask the user to run push interactively.
