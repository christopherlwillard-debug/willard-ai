---
name: Job engine stuck-scan root cause
description: Why scans hang at "indexing" forever and how the engine recovery mechanism works
---

## The bug

`resolveSkippedDirs` (job-engine.ts) is called inside `walkDone.then()` and uses `fs.statSync()` — a synchronous blocking call. This freezes the Node.js event loop:

1. `walkDone.then()` sets `state.phase = "indexing"`, then calls `resolveSkippedDirs`
2. `fs.statSync` on any slow/hung path blocks the event loop
3. `queue.close()` at the end of `.then()` is never reached
4. Workers remain stuck at `await queue.pop()` (queue never closed)
5. `await walkDone` never resolves → job stays RUNNING forever in `activeJobs`
6. All downstream jobs (Optimize, Thumbnails) are blocked; People page 500s from pool exhaustion

**Fix applied:** `fs.statSync(fullPath)` → `await fs.promises.stat(fullPath)` in `resolveSkippedDirs`.

**Why:** Inside async callbacks, always use async I/O. `statSync` inside `.then()` is the same as blocking the event loop at the top level.

## Recovery mechanism

`forceDiscardActiveJob()` (job-engine.ts) — exported and exposed as `DELETE /api/library/active-job`:
- Immediately removes the job from the in-memory `activeJobs` map
- Marks it FAILED in the DB (best-effort)
- Unblocks new jobs immediately, even if the stuck job's promise is still pending

Also wired to a "Force Discard" button in the scan banner (media.tsx) — shown at low opacity, full on hover.

## Startup recovery

`recoverInterruptedJobs()` runs at boot:
- RUNNING → FAILED ("Interrupted by server restart")
- PAUSED → INTERRUPTED_BY_RESTART

Called from library-engine initialization (already handled before this fix).

## Walk-timeout timer fix

`walkDone.then(...).catch(() => {})` → `walkDone.finally(...)` — ensures the timeout timer is always cleared even if `walkDone` rejects.
