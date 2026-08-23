---
name: Recycled scan state
description: Cleanup-recycled media must remain excluded and retain its RECYCLED state across later scans.
---

Recycled files should be excluded from walking and duplicate queries, and deletion reconciliation must not downgrade a `RECYCLED` row to `DELETED`.

**Why:** A cleanup rescan can otherwise make a resolved duplicate appear active again or erase the distinction between user recycling and filesystem deletion.

**How to apply:** Preserve `RECYCLED` as a terminal cleanup marker during scan reconciliation; only a deliberate restore or reappearance policy should revive it.