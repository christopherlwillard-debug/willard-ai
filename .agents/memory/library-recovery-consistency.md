---
name: Library recovery consistency
description: Safety requirements for database backups that recover NAS-backed library knowledge.
---

Library-bound database backups must obtain the dump, schema/count facts, active NAS root, and canonical hash inventory from one exported PostgreSQL snapshot. Recovery must verify every cataloged original hash before activating remapped paths.

**Why:** Separate post-dump reads can authenticate a newer library path against an older dump, while marker-only or sampled checks can accept an incomplete copied library.

**How to apply:** Keep the snapshot holder alive through `pg_dump`; bind resumable recovery to an HMAC-authenticated target identity; treat optional caches as rebuildable only after full original-media verification succeeds.