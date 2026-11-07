---
name: Desktop loading readiness
description: Packaged startup must let the native launcher own readiness and open the web app
---

The packaged loading page is opened from `file://`, so it cannot be relied on to poll the local API when API CORS intentionally rejects untrusted origins. The native launcher must wait for both local services, close its owned loading window, and explicitly open the web URL.

**Why:** A file-origin polling failure leaves users on an apparently endless loading screen even when the API and web server are already healthy.

**How to apply:** Keep packaged startup readiness in the PowerShell launcher; treat the loading page as visual feedback only, and preserve explicit API/web diagnostics when either service fails.