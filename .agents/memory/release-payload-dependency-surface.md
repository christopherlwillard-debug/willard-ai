---
name: Release payload dependency surface
description: Generated Windows payloads should exclude package-manager metadata and non-runtime workspace dependency graphs.
---

Windows release payloads should contain only runtime dependencies and application files; do not ship pnpm lockfiles or package-manager metadata copied from a workspace deploy.

**Why:** Release scanners can attribute unrelated mobile/tooling advisories to the Windows artifact when workspace dependency metadata is included, and users do not need package-manager files to run the installed app.

**How to apply:** After staging and dereferencing the Windows runtime, remove lockfiles and package-manager metadata, then validate the actual payload and load critical runtime dependencies from it.