---
name: Windows release build environment
description: Required environment defaults for packaging the Vite web app in Windows CI
---

The release staging script must provide `PORT` and `BASE_PATH` while building the web artifact, even though the packaged app later supplies its own runtime configuration.

**Why:** Vite intentionally rejects builds without those variables, which fails the release before installer creation.

**How to apply:** Keep safe defaults in the release builder (`5000` and `/`) and mirror them in the workflow step environment.