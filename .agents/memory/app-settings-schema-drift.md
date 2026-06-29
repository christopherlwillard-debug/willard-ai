---
name: app_settings schema drift fix pattern
description: How to keep app_settings DB columns in sync with the Drizzle schema across server restarts
---

## The problem

When a new column is added to `appSettingsTable` in `lib/db/src/schema/settings.ts`, the actual Postgres table is not automatically updated. Any Drizzle `db.select().from(appSettingsTable)` call will throw PG error 42703 ("column does not exist"), which surfaces as a 500 on every auth endpoint — including login and setup.

**Why this matters:** The `getOrCreateSettings()` helper is called on every auth request. A missing column breaks auth entirely.

## The fix

Add an `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS <col> <type>` statement to the `bootstrapSessionTable()` function in `artifacts/api-server/src/app.ts`. This runs on every server start and is idempotent.

```sql
ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS logo_path text;
```

**How to apply:** Whenever you add a column to `appSettingsTable`, also add the matching `ADD COLUMN IF NOT EXISTS` line to the migration block in `bootstrapSessionTable()`.
