---
name: Routed workflow readiness
description: Replit workflow tasks can launch artifact services before their routed host is ready.
---

The browser command must perform an explicit readiness check against both the routed web URL and its API health URL before starting Playwright.

**Why:** Starting artifact workflows sequentially does not guarantee that the externally routed host is serving when the following shell task begins.

**How to apply:** Keep readiness checks service-specific and report the URL, service name, and last observed failure so startup problems are distinguishable from browser assertion failures.