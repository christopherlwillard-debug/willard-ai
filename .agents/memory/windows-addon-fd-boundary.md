---
name: Windows addon file-descriptor boundary
description: Safely pass verified Windows file handles from Node native addons to Node's filesystem APIs.
---

On Windows, a native addon should use libuv's `uv_open_osfhandle` when returning a numeric file descriptor for Node's `fs` APIs. Do not pass an addon-created `_open_osfhandle` descriptor across the addon/Node boundary; the two modules may use separate CRT descriptor tables. Use libuv's close APIs for cleanup of descriptors created by libuv.

**Why:** A descriptor can appear to open correctly while Node's own filesystem operations fail to close or inspect it with `EBADF`, because Node and the addon do not necessarily share the same Windows CRT state.

**How to apply:** Whenever a Windows addon converts a verified `HANDLE` into a descriptor that JavaScript will pass to `fs`, `createReadStream`, or related APIs, convert and dispose of that descriptor through Node's libuv runtime.
