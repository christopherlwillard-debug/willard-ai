---
name: NAS health permission probes
description: Separate non-mutating liveness checks from explicit write probes when validating NAS roots
---

NAS health polling should verify reachability and directory enumeration without creating files; explicit settings or manual topology checks may perform a temporary create/delete probe to validate write access.

**Why:** periodic recovery checks must be safe and side-effect free, while a readable share can still be unusable for WillardAI's writable working directories.

**How to apply:** expose readable, enumerable, and writable state separately; use a real temporary write probe only at an explicit user-controlled validation boundary, and never treat readable-only as a ready library.