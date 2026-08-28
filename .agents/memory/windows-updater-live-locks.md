---
name: Windows updater live locks
description: Why developer updates must remain isolated from the running Windows source folder.
---

Prepare developer update candidates from the configured remote, not from the live checkout. Handle Windows sharing violations during package/build work, mutable-state preservation, and the final directory swap—not only during candidate preparation.

**Why:** Windows can retain handles on source, runtime data, logs, pnpm-linked dependencies, or the live directory itself. An updater that fails before swapping cannot install its own repair, so repeated retries create abandoned candidates without advancing.

**How to apply:** Build in a sibling candidate, exclude the active update log, stop only verified launcher-owned processes, wait for handle release, and retry recognized lock failures once at every filesystem boundary. Keep a clean downloadable bootstrap ZIP available when the installed updater cannot self-repair.