---
name: Expo Metro watcher compatibility
description: Watcher event-shape compatibility between Expo CLI 54 and Metro 0.83.8.
---

Expo CLI 54 listeners expect Metro's older `eventsQueue` payload, while Metro 0.83.8 emits a `changes` aggregate. Normalize both formats at the watcher boundary and retain tests for each payload shape.

**Why:** Without an adapter, the dev server can fail at startup because the newer change object is not iterable as an event queue.

**How to apply:** When updating Expo CLI or Metro, verify the watcher contract and bundle with the real Expo workflow rather than relying only on unit tests.
