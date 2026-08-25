---
name: Loading loop cleanup
description: Reliable cleanup approach for the cinematic loading animation's baked-in labels and icons
---

When removing baked-in lettering from the loading animation, use a carefully chosen crop that excludes the lower text/icon band and any corner badge while preserving the central Willard AI title. Do not use a large opaque block or FFmpeg delogo masks on this footage.

**Why:** The moving floor and glow pattern make large masks visibly artificial, while delogo interpolation produces vertical smearing across the animated icons and typography.

**How to apply:** Re-check a representative frame after every crop adjustment and preserve the original 16:9 output dimensions by scaling the clean crop to the app viewport.