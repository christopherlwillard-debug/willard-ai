---
name: NAS derivative bounds
description: Durable rules for keeping rebuildable media derivatives on the NAS without unbounded scans or misleading cache accounting
---

Derivative work must remain NAS-scoped even when it is rebuildable: normal browsing should generate lazily, explicit backfills should have a finite per-job budget, publication should use cross-process claims and atomic rename, and cache accounting should include only valid durable outputs.

**Why:** A rebuildable thumbnail or preview is not permission to spill media bytes into OS temp or let a full scan create an unbounded background workload. Partial files and lock files also distort capacity diagnostics and can be mistaken for usable derivatives after restart.

**How to apply:** Add each new derivative family to the machine-readable storage inventory with a NAS path pattern, durability, and reclaim rule. Keep incomplete outputs distinguishable by name, remove only abandoned partials, preserve the last valid output during replacement, and expose pending/failure/quota state to operators.