---
name: TAR parser safety
description: Safety and compression constraints when extracting TAR archives with tar 7
---

The tar 7 parser can let exceptions thrown from entry callbacks escape asynchronously instead of rejecting the returned promise. Capture validation failures in a non-throwing `filter`, skip the unsafe entry, and throw after the list/extract promise settles. Its parser handles gzip but not bzip2 or xz, so those inputs need explicit, argument-array decompression into controlled scratch space.

**Why:** A traversal test initially produced an uncaught process-level exception, and compressed TAR formats otherwise appeared unreadable even though the application advertised them.

**How to apply:** Keep raw path validation enabled with `preservePaths: true`; never rely on tar's default path sanitization as the security check. Use strict parsing and clean temporary decompression output on both success and failure.