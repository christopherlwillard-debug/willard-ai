---
name: Windows updater live locks
description: Why developer updates must remain isolated from the running Windows source folder.
---

Prepare developer update candidates from the configured remote, not from the live checkout. Defer copying mutable settings, runtime data, and diagnostics until launcher-owned services have stopped, and exclude the updater's active log. If isolated package installation or building reports a Windows sharing violation, stop only launcher-owned services, wait for descendant handles to close, and retry the candidate command once.

**Why:** Windows can retain handles on live source, runtime-data, logs, and pnpm-linked build dependencies. A candidate checkout may still encounter a lock through the shared package store while the live Vite/API tree is running.

**How to apply:** Any developer updater or repair flow must build in a sibling candidate directory. Retry only recognized lock failures after verified process shutdown; fail normally for other errors, then preserve state immediately before the atomic swap.