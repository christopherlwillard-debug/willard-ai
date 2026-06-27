---
name: Drizzle onConflictDoUpdate per-row values
description: How to correctly reference excluded row values in Drizzle upserts so each conflicting row gets its own new values
---

# Drizzle onConflictDoUpdate — use sql`excluded.*`

## The Rule
In Drizzle's `.onConflictDoUpdate({ set: { ... } })`, the `set` object values must use `sql\`excluded.column_name\`` to reference the would-be-inserted row's values. Using a JS variable (e.g. `fileBatch[0].sizeBytes`) applies the **first batch row's value to every conflicting row**, silently corrupting data.

**Why:** Drizzle doesn't automatically bind excluded values per-row unless you use the `sql` template literal with the Postgres `EXCLUDED` pseudo-table.

**How to apply:**
```typescript
await db.insert(table).values(batch).onConflictDoUpdate({
  target: table.path,
  set: {
    sizeBytes: sql`excluded.size_bytes`,
    modifiedAt: sql`excluded.modified_at`,
    indexedAt: sql`NOW()`,
  },
});
```

Column names in `excluded.*` must use the **snake_case SQL column name**, not the camelCase TS field name.
