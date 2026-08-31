---
name: Windows PowerShell standard-user compatibility
description: Compatibility constraints found when running packaged launchers as a disposable standard Windows user
---

Windows PowerShell lifecycle tests can run with a reduced command/type surface and with empty optional special-folder paths. Packaged launchers should prefer self-contained .NET APIs for hashing, explicitly load assemblies needed for DPAPI, derive serialized-prefix lengths from the prefix itself, and guard special-folder defaults before passing them to path cmdlets.

**Why:** The installed lifecycle only exposed these differences under the real standard-user launcher account; developer and runner-admin smoke paths did not reproduce them.

**How to apply:** When adding Windows launcher startup, update, backup, or recovery logic, test it under a fresh standard profile with no assumed Documents folder, no reliance on optional PowerShell commands, and no implicit assembly loading.