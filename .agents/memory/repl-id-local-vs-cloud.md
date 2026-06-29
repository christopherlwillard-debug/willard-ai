---
name: REPL_ID gates Replit-vs-local behavior
description: How Willard AI distinguishes a Replit cloud run from a bare local run, across vite.config and the API server
---

# REPL_ID is the Replit-vs-local signal

`process.env.REPL_ID !== undefined` is the canonical check for "running on
Replit" used across the codebase. Use it (not NODE_ENV) to gate any
Replit-only behavior.

**Why:** Willard AI must run both on Replit's cloud AND locally on a user's
Windows machine (the server reads files from disk, so a local `Z:` drive is
only reachable when it runs locally — on the cloud it's "Library Offline").
NODE_ENV can't distinguish these because a local run is also "development".

**How to apply:**
- `artifacts/willard-ai/vite.config.ts`: on Replit, `PORT`/`BASE_PATH` are
  strictly required and Replit-only plugins (runtimeErrorOverlay, cartographer,
  dev-banner) load. Off Replit, default `PORT=5000` / `BASE_PATH="/"` and skip
  ALL those plugins.
- `artifacts/api-server/src/app.ts`: `app.set("trust proxy", 1)` only when
  REPL_ID set or NODE_ENV=production — otherwise express-rate-limit warns about
  a permissive trust-proxy setting on a bare local run.
- API `start` script loads the root `.env` via Node's
  `--env-file-if-exists=../../.env` (Node 24+). On Replit there is no root
  `.env`, so platform env vars apply unchanged; locally users copy
  `.env.example` → `.env`. Web app does NOT read this `.env` (it would grab the
  API's PORT=8080 and collide) — it uses local defaults instead.
- Local topology: API on 8080, web dev server on 5000 proxying `/api` → 8080.
  ffmpeg/ffprobe must be on PATH (warn-only startup probe in `lib/media-tools.ts`,
  does not crash); 7zip is bundled via `7zip-bin`. See `LOCAL_SETUP.md`.
