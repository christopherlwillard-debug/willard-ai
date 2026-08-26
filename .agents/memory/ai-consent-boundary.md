---
name: AI consent boundary
description: Durable privacy rule for cloud AI calls and local-only fallbacks.
---

Every cloud AI entry point must use the shared privacy policy before sending user or library data. Features that remain available in local-only mode should use a local fallback rather than calling the provider.

**Why:** A provider call can be hidden outside the background enrichment worker, such as natural-language search, chat context, optimization summaries, or organizer confidence review. Gating only the worker creates a false privacy promise.

**How to apply:** When adding or changing an AI feature, search all provider completion calls and verify each route has an explicit consent/local-mode gate. Keep excluded media out of provider-bound context even after cloud consent.