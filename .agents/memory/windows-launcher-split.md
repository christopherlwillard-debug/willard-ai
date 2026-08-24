---
name: Windows launcher split
description: The installed Windows launcher and developer launcher are separate startup paths.
---

The installed Windows experience is driven by `desktop/WillardMediaCenter.ps1`, while developer launches use `scripts/launcher/start.ps1`; a fix in one does not change the other.

**Why:** The first startup optimization changed only the developer path, so installed launches remained slow until the packaged launcher received the same schema gate and update behavior.

**How to apply:** For Windows startup changes, update and test both launcher scripts and ensure the release packaging includes the packaged launcher change.