---
name: Immich thumbnail proxy pattern
description: Server-side proxy for Immich thumbnails so the API key never reaches the browser
---

# Immich Thumbnail Proxy

## The Rule
Never include the Immich API key in URLs returned to the browser. Instead, return a proxy path and let the API server fetch the thumbnail with the key.

**Why:** A URL like `https://immich.local/api/assets/{id}/thumbnail?apiKey=secret` exposes the secret in browser network logs, referer headers, and server access logs.

**Pattern (api-server/src/routes/immich.ts):**
- Return `thumbUrl: \`/api/immich/thumbnail/asset/${id}\`` from all list endpoints
- Add `GET /api/immich/thumbnail/:type/:id` that fetches from Immich with `x-api-key` header server-side, proxies the image bytes with `Cache-Control: public, max-age=3600`
