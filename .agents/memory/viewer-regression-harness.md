---
name: Viewer regression harness
description: Constraints for deterministic media-viewer browser regression runs in the Replit preview
---

Media-viewer browser tests should mock authenticated status and media endpoints, and hide the injected development banner before interacting with controls.

**Why:** Repeated preview runs can hit the login limiter, and the development banner can intercept clicks on fixed viewer controls; both create false regressions unrelated to media behavior.

**How to apply:** Keep authentication and media setup deterministic in the viewer fixture, and scope assertions to the relevant dialog/control rather than duplicate page text.