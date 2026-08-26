---
name: Bounded duplicate confirmation
description: Safety and performance rules for duplicate confirmation on NAS files
---

Duplicate confirmation must reject files larger than 500 MiB before opening them, enforce the same bound while streaming, and stop the stream when cancellation is requested.

**Why:** Full SHA-256 reads on multi-gigabyte or slow SMB files can stall scans and consume substantial NAS bandwidth; a quick fingerprint is evidence for review, not proof of identical content.

**How to apply:** Count only completed SHA-256 results as confirmed, expose oversized groups as `UNCONFIRMED_LARGE`, and route legacy move detection and benchmark hashing through the bounded helper too.