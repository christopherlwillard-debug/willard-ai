---
name: Canonical duplicate fingerprints
description: Clean-library duplicate discovery depends on FULL scans populating media_files fingerprints for first-seen files.
---

FULL scans must populate quick fingerprints for first-seen files because media_files is authoritative for duplicate discovery. Leaving fingerprints null on the first scan makes a clean library appear to have no duplicates until a later scan.

**Why:** Legacy indexed_files hashing previously masked this gap; moving duplicate discovery to media_files exposed it in cleanup integration tests.

**How to apply:** Preserve fingerprinting for new files in FULL profiles, while QUICK profiles may continue to omit it for speed.