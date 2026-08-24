---
name: Vectorless auth bootstrap
description: Rules for optional pgvector setup and one-time recovery credentials.
---

Required database bootstrap must not reference pgvector types. Create the catalog and authentication schema first, probe the optional extension, and add embedding columns only when the capability is available.

**Why:** Windows and standalone PostgreSQL installs may not have pgvector; required schema failure otherwise leaves a partial database and prevents login.

**How to apply:** Keep standalone setup and API bootstrap capability-aware, fail atomically for required schema work, and test both vector-present and vector-absent paths.

Recovery-key password resets must consume the stored recovery hash with an atomic compare-and-set update, not merely compare and then update.

**Why:** Two concurrent recovery requests can otherwise both validate the same key and both report success.

**How to apply:** Update only when the stored hash still matches, clear it on success, and reject the losing request as already used.