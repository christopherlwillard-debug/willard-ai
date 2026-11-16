---
name: Post-install NAS mapping
description: The user's intended Windows NAS setup and recovery workflow.
---

Willard AI is installed and launched before the NAS is connected. The user then maps the NAS as `Z:` in Windows and configures the location through the existing Settings page. Backup and restore should use that saved setting and continue to work after the drive disconnects and reconnects; a separate restore-database environment variable is test-only, not normal setup.

**Why:** the user clarified the actual laptop workflow and asked that the existing Settings flow be tested rather than replaced.

**How to apply:** Windows lifecycle tests should install and launch with no NAS connected, then map and save `Z:` under the standard app user, verify persistence, backup/restore, and disconnect/reconnect recovery without reinstalling.
