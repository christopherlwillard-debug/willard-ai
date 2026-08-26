---
name: Windows launcher path quoting
description: Windows PowerShell Start-Process argument handling for Willard launcher paths
---

PowerShell `Start-Process -ArgumentList` does not reliably preserve array elements containing spaces as single Windows command-line arguments. Quote every path passed as a Node argument, including `--env-file=...`, the API entrypoint, the packaged web-server entrypoint, and the web root.

**Why:** A developer folder such as `C:\New folder` can make Node receive a truncated script or env-file path. The child process then exits before `/api/healthz` is ready, even though setup and database checks succeeded.

**How to apply:** When adding a `Start-Process` child command to either the source launcher or packaged launcher, keep `-FilePath` separate and wrap each path argument with PowerShell-escaped quotes. Cover both launcher paths with static Windows contract tests.