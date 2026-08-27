---
name: Capacity admission
description: Shared headroom and reservation rules for media-producing work
---

All media-producing operations must pass the shared capacity admission service before writing. Local control-plane headroom keeps a configurable 4 GiB default floor; NAS operations require known capacity, a safety margin, and reservations that are re-probed at commit time. NAS loss never falls back to local media storage.

**Why:** Independent per-route disk checks allowed concurrent work and stale preflights to overcommit storage, while Windows package data can live on a different local volume than the install directory.

**How to apply:** Use the service for new scan, derivative, archive, conversion, AI, face, import, or export writers. Keep reservations short-lived, release them in `finally`, and preserve completed outputs/checkpoints when a later probe fails.