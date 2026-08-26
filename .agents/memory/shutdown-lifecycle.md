---
name: API shutdown lifecycle
description: Order and durability rules for stopping the local API safely.
---

Stop recurring producers before draining work, persist resumable or terminal job state before closing PostgreSQL, then drain HTTP/SSE and close the shared pool last. Keep the coordinator idempotent and bounded.

**Why:** NAS scans, derived jobs, and progress streams can still perform final durable writes during shutdown; closing the pool or allowing new producers first leaves restart recovery ambiguous.

**How to apply:** Route SIGTERM/SIGINT through one coordinator, have each timer-owning subsystem expose a stop-and-await hook, and use a deadline so a hung NAS or socket cannot block process termination indefinitely.