---
name: isScanning source must be libraryJobsTable
description: The dashboard isScanning boolean must read from library_jobs (status="RUNNING"), not scan_jobs (legacy engine). Reading from the wrong table causes permanent "Scanning…" UI freeze.
---

# isScanning authoritative source

**Rule:** Dashboard `isScanning` reads `libraryJobsTable` with `status = "RUNNING"` only.

**Why:** Two separate scan engines exist:
- `routes/scan.ts` (LEGACY) → writes to `scan_jobs`, status `"running"` (lowercase)
- `lib/library-engine/job-engine.ts` (CURRENT) → writes to `library_jobs`, status `"RUNNING"` (uppercase)

If the dashboard ever queries `scan_jobs` for `"running"` rows, any job that crashed mid-run leaves a permanent stuck row — the UI shows "Scanning…" forever because the current engine never clears the legacy table.

**How to apply:**
- `routes/dashboard.ts` GET /dashboard: `db.select().from(libraryJobsTable).where(eq(libraryJobsTable.status, "RUNNING"))`
- `recoverInterruptedJobs` in `job-engine.ts` drains `scan_jobs` `"running"` → `"failed"` at startup as a safety net for databases created before the fix
- `/api/debug/library-state` endpoint shows both tables' counts + computed isScanning for diagnostics
- `checkNasReachable` (sync, can block event loop on Windows network drives) must not be called in any hot polling path (dashboard, health, enrichment tick, face tick); use `checkNasReachableAsync` everywhere
