---
name: Sharp patched release compatibility
description: Sharp security patch and TypeScript package-resolution compatibility in this workspace
---

Use sharp 0.35.2 or newer when upgrading away from vulnerable pre-0.35 releases. Sharp 0.35.0 is security-patched but its package exports do not resolve the bundled declarations under this workspace's TypeScript bundler module resolution.

**Why:** The first patched 0.35.0 upgrade caused API-wide implicit-any errors even though runtime builds succeeded; 0.35.2 restored typecheck without adding an unsafe declaration shim.

**How to apply:** Prefer the newest compatible 0.35.x release and run the API typecheck after any sharp upgrade.