---
name: Vite proxy for /api in development
description: Frontend dev server must proxy /api to the API server port or all calls 404 in Vite
---

# Vite API Proxy Requirement

## The Rule
In `artifacts/willard-ai/vite.config.ts`, a proxy entry must forward `/api` to the API server:

```ts
server: {
  proxy: {
    "/api": { target: "http://localhost:8080", changeOrigin: true }
  }
}
```

**Why:** The generated API client calls relative paths like `/api/dashboard`. Without the proxy, Vite serves these from its own dev server (which doesn't know the routes) and returns 404. The esbuild runtime build succeeds regardless, so there's no compile-time indicator — the failure only shows at runtime in the browser.

**How to apply:** After changing vite.config.ts, restart the `artifacts/willard-ai: web` workflow for the proxy to take effect.
