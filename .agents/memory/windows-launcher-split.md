---
name: Windows launcher split
description: The installed Windows launcher and developer launcher are separate startup paths.
---

The installed Windows experience is driven by `desktop/WillardMediaCenter.ps1`, while developer launches use `scripts/launcher/start.ps1`; a fix in one does not change the other.

**Why:** The first startup optimization changed only the developer path, so installed launches remained slow until the packaged launcher received the same schema gate and update behavior.

**How to apply:** For Windows startup changes, update and test both launcher scripts and ensure the release packaging includes the packaged launcher change.

Both launchers must persist executable path, command line, creation identity, and a run token with tracked processes; readiness requires HTTP 200 plus expected API JSON or web HTML, and update-check timestamps should be written only after a healthy start.

**Why:** Numeric PID cleanup can terminate an unrelated reused process, permissive readiness can accept error pages, and caching before post-update health suppresses recovery retries.

**How to apply:** Treat process ownership and post-update readiness as one lifecycle contract across developer startup, packaged startup, installer upgrades, and repair flows.

PowerShell variable names are case-insensitive, so never use `$pid` for a local process identifier: it aliases the read-only automatic `$PID` variable and fails during recovery.

**Why:** Interrupted-launch recovery previously failed before validating tracked processes because assigning `$pid` raised `VariableNotWritable`.

**How to apply:** Use descriptive names such as `$trackedProcessId` in every launcher script and keep a regression assertion against `$pid =`.

Developer launchers on Windows must resolve `pnpm.cmd` or `pnpm.exe` explicitly instead of invoking the ambiguous `pnpm` command.

**Why:** Windows PowerShell can resolve `pnpm` to `pnpm.ps1`, whose native output is surfaced as `NativeCommandError` even when the underlying pnpm command succeeds.

**How to apply:** Use the executable wrapper for launcher-owned installs, builds, and long-lived web processes; keep readiness failures paired with the relevant log tail.