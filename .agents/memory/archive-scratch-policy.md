---
name: NAS archive scratch policy
description: Compressed archive inspection must receive an explicit NAS-backed scratch directory.
---

Compressed TAR inspection and decompression must use a caller-owned scratch directory under the configured NAS library; never create a fallback directory under the operating system temp path.

**Why:** Compressed archives can expand to large intermediate TAR files, and an OS-temp fallback silently violates the storage contract and can exhaust the control-plane disk.

**How to apply:** Require the scratch directory in archive helpers, allocate it through the NAS storage policy, and clean it in the caller after inspection or extraction completes.