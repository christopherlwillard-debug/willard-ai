---
name: NixOS Playwright Chromium libs
description: Why npx playwright test fails in this Nix container and what to do instead
---

## The problem

`npx playwright install chromium` downloads a `chrome-headless-shell` binary that needs `libgbm.so.1` and `libudev.so.1` at standard library search paths (`/usr/lib`, `/lib`). NixOS does not populate those paths — all libraries live in `/nix/store/...`.

`ldd` on the binary shows only two missing libs:
```
libgbm.so.1 => not found
libudev.so.1 => not found
```

Mesa in Nix (`mesa-25.0.7`) provides `libEGL_mesa`, `libGLX_mesa`, etc., but **not** a standalone `libgbm.so.1`. `libudev.so.1` is in `/nix/store/<hash>-systemd-257.6/lib/`.

Setting `LD_LIBRARY_PATH` manually works for `libudev`, but `libgbm` has no matching file in the Nix Mesa derivation's lib directory (`gbm/` is a subdirectory of DRI drivers, not the GBM library itself).

**Why:** The Playwright-downloaded Chrome headless shell is built for standard glibc Ubuntu, not NixOS.

## What to do instead

Use the `runTest()` testing subagent — it has a pre-configured browser environment that works in this Nix container. All Playwright browser verifications should go through `runTest()`.

The spec file (`e2e/dashboard-after-scan.spec.ts`) can be committed and run in any standard CI environment (GitHub Actions, etc.). Only the in-container `npx playwright test` invocation is broken.

## Rate-limiter gotcha

The login rate limiter (5 attempts / 15-min window) is in-memory. If `npx playwright test` is attempted with `retries > 0`, each retry re-runs `beforeAll` which calls `/api/auth/login`, burning slots. Set `retries: 0` in `playwright.config.ts` to prevent exhaustion, and restart the API server to reset the limiter.
