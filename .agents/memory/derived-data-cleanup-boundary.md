---
name: Derived-data cleanup boundary
description: Safety rules for purging rebuildable AI and face data during media lifecycle transitions
---

Rebuildable AI and face data must be purged transactionally before permanent canonical-row deletion, and every crop-file operation must validate the active NAS and remain inside its configured WillardAI directory.

**Why:** Originals and recycled canonical rows are the recovery source of truth, while derived data can be regenerated. Deleting derived rows before the canonical row disappears also prevents stale search/detail results and leaves recovery able to converge after interrupted filesystem work.

**How to apply:** Reuse one scoped cleanup path for delete, recycle, orphan repair, interrupted cleanup recovery, face replacement, and local-trash expiry. Treat filesystem failures as reported cleanup errors; never restore sensitive derived rows or delete paths outside the active library root.