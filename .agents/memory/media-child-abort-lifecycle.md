---
name: Media child abort lifecycle
description: Process cleanup and escalation when a cancellable child outlives the wrapper promise.
---

A child-process wrapper can reject on abort before the operating-system process exits. Keep termination escalation and shutdown tracking active until the child's actual close event; an abort or error callback is not proof of exit.

**Why:** A child that ignored SIGTERM survived after its escalation timer and shutdown registration were cleared too early.

**How to apply:** Use this lifecycle rule for every long-running media or worker subprocess with cancellation, timeout, or server-shutdown handling.
