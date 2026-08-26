---
name: Per-library job claims
description: Concurrency rule for long-running library jobs across requests and API processes
---

# Per-library job claims

Runnable background work must be claimed by the database per library path; process-local active-job maps are only optimizations and cannot establish exclusivity across API processes.

**Why:** Concurrent requests or separate API processes can observe an empty in-memory map at the same time, so a check-then-insert sequence can otherwise start overlapping scans and duplicate writes.

**How to apply:** Keep the claim unique only for runnable work so paused or restart-interrupted checkpoints remain recoverable. Handle the unique-claim conflict by returning the winning existing job, and scope in-memory controls and UI progress lookups to the same library path.