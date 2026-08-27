---
name: Storage-policy conformance gate
description: The release must validate one canonical cross-surface storage matrix before packaging.
---

The storage policy is maintained as one canonical matrix with executable evidence for
each pipeline and target-environment scenario. Windows release staging and final
payload validation must both fail closed when that matrix is incomplete.

**Why:** Storage behavior is distributed across server jobs, browser/mobile clients,
and two Windows launcher modes; independent checks can otherwise leave an unreviewed
local-media write path.

**How to apply:** Add new byte-producing features to the matrix and evidence list
before adding them to a release, and keep physical Windows/NAS checks explicitly
classified as target-environment validation rather than simulating them on Linux.