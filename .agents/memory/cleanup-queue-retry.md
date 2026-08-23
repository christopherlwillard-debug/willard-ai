---
name: Cleanup queue retry behavior
description: Staged cleanup decisions must survive unavailable NAS and zero-recycle responses.
---

Only clear the browser cleanup queue after the API reports at least one recycled file. Preserve it for 409 responses and 200 responses containing only per-file errors so users can retry when storage returns.

**Why:** Staged decisions are user work; clearing them on a transport or file-level failure forces users to reconstruct the cleanup plan.

**How to apply:** Treat `recycled > 0` as the successful-consumption signal, while keeping the queue intact for `recycled === 0`.