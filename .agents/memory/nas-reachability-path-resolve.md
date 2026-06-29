---
name: NAS reachability vs path.resolve on Linux
description: Why live path-reachability checks must reject Windows drive/UNC/relative paths before resolving
---

A live "is this storage location reachable?" check on the Linux server must reject
Windows-style and relative locations BEFORE calling `path.resolve()`.

**Why:** `path.resolve("Z:")` on Linux yields `<cwd>/Z:` (a relative folder), not an
error. If that local folder happens to exist (e.g. a previous run auto-created it via
a bootstrap step), the check returns `online: true` and the app falsely reports
Connected/Healthy for a NAS drive the server can never actually reach. This exact
false-positive shipped once: bare `nasPath="Z:"` resolved to `artifacts/api-server/Z:`
which existed in the repo.

**How to apply:** In the shared reachability helper, when `process.platform !== "win32"`,
reject `/^[A-Za-z]:/` (drive letters), `\\...` (UNC shares), and any non-absolute path
(`!startsWith("/")`) with an explicit offline message — before `path.resolve`. Also never
auto-create the app's working subdir for an unreachable path (guard both `PUT /settings`
and the startup bootstrap with the reachability check), or the created folder will mask
the offline state on the next check.
