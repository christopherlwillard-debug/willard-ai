---
name: Windows PostgreSQL provisioning
description: CI behavior to account for when provisioning PostgreSQL on hosted Windows release runners
---

Hosted Windows release runners can stall during a remote Chocolatey PostgreSQL package install after the package-download message, producing no useful installer error before the workflow timeout.

**Why:** The release job can fail before any application, backend, browser, packaging, or installer gate runs, so the result is a CI provisioning blocker rather than evidence of a Media Center defect.

**How to apply:** Keep PostgreSQL provisioning bounded and observable, with retries or a stable cached/preinstalled path and diagnostic output before treating downstream release gates as unvalidated.