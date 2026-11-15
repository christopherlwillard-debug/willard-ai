---
name: Post-install NAS setup
description: Willard AI's expected Windows mapped-drive setup and recovery lifecycle
---

Willard AI is installed and first launched before the NAS is connected. The user maps the NAS as `Z:` afterward and saves `Z:\` through the existing Settings page. That saved path must persist across restarts; backup and restore use it; disconnection must fail safely, and reconnection must recover without reinstalling or editing the database.

`WILLARD_RESTORE_DATABASE_URL` is only a test PostgreSQL target. It must not replace the Settings-based NAS path as the application's normal configuration.

**Why:** The user clarified that this is their actual setup and that NAS configuration already exists in Settings.

**How to apply:** Test the installed app under the same standard Windows user that owns the mapped drive. Distinguish a simulated drive-letter test from validation against a real SMB/NAS share.
