---
name: PowerShell Windows encoding
description: em-dash and other non-ASCII chars in .ps1 files cause parse errors on Windows
---

PowerShell on Windows reads .ps1 files using the system default encoding (Windows-1252 / CP1252), NOT UTF-8.

Any non-ASCII character in a PowerShell script -- even in a string or comment -- will corrupt on Windows:
- em-dash (U+2014) "—" renders as "â€"" and breaks the parser mid-expression
- box-drawing chars (U+2500) "─" have the same problem
- smart quotes and any other multi-byte UTF-8 chars cause similar failures

**Why:** Windows PowerShell (5.x, the default on most Windows machines) defaults to the system locale encoding, not UTF-8. PowerShell 7+ handles UTF-8 better but cannot be assumed.

**How to apply:** Write ALL .ps1 launcher scripts using 7-bit ASCII only. Replace:
- em-dash (—) with -- (double hyphen)
- box-drawing (──) with -- or plain hyphens
- smart quotes with plain quotes
- any non-ASCII in strings/comments with ASCII equivalents

This applies to every file in scripts/launcher/*.ps1. The .env and .bat files are not affected.
