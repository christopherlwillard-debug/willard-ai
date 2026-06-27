---
name: SHA-256 verification testability
description: How to test verifiedMove's mismatch-throw path without mocking the filesystem
---

## Rule
`verifiedMove(from, to, { afterMoveHook })` accepts an optional callback that fires between
the `moveFile()` call and the post-move `sha256File(to)` call.  This is the only seam that
allows a test to corrupt the destination and trigger the mismatch-throw path for real.

**Why:** The mismatch detection runs synchronously inside `verifiedMove`.  There is no pause
between the move and the post-hash where external code could inject corruption without a hook.
Mocking the hash function would test mock behavior, not real I/O.

**How to apply:** In any test that needs to assert the mismatch throw:

```typescript
await assert.rejects(
  () => verifiedMove(src, dest, {
    afterMoveHook: (to) => { fs.writeFileSync(to, randomBytes(128)); },
  }),
  /SHA-256 mismatch/,
);
```

Do NOT mock `sha256File` directly — keep the real I/O, just corrupt the file in the hook.

## Related
- `organize-helpers.ts` — `verifiedMove` implementation
- `organize-helpers.test.ts` — test #10 "throws on destination hash mismatch"
