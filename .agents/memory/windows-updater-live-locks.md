---
name: Windows updater live locks
description: Why developer updates must remain isolated from the running Windows source folder.
---

Prepare developer update candidates from the configured remote, not from the live checkout. Defer copying mutable settings, runtime data, and diagnostics until launcher-owned services have stopped, and exclude the updater's active log.

**Why:** Windows can retain handles on live source, runtime-data, and log files. Reading or mirroring those paths while the API or web process is active can make an otherwise isolated update fail with a sharing violation.

**How to apply:** Any developer updater or repair flow must build in a sibling candidate directory, stop only verified launcher-owned processes, wait briefly for handle release, then preserve mutable state immediately before the atomic directory swap.