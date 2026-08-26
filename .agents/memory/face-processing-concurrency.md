---
name: Face processing concurrency
description: Durable safety rules for local face clustering and model cache publication
---

Face clustering must serialize the complete derived-data tick per library across API processes, while model downloads must verify the full payload before atomic publication.

**Why:** Process-local tick flags do not prevent duplicate person creation or centroid races across workers, and a shared fixed download temp file can expose or publish partial model bytes.

**How to apply:** Keep retryable face failures eligible for a later tick, hold the library lock on a dedicated database session, use process-unique temp files, and validate the expected digest before session creation.