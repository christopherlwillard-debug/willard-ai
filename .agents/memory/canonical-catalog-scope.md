---
name: Canonical catalog scope
description: Legacy-compatible file APIs must read media_files scoped by the active NAS identity.
---

Treat media_files plus the configured nas_path as the authoritative catalog. Legacy indexed_files data may only be read by an explicit, insert-only reconciliation process that validates paths and reports conflicts.

**Why:** Global legacy IDs and absolute paths can otherwise expose stale records or cross-library files.

**How to apply:** Add the active nas_path to every catalog query, resolve database paths through the shared boundary before disk access, and never mutate user files during reconciliation.