# Willard AI

Personal NAS Media & Data Center — indexes, organizes, and searches a user's local media drive with AI assistance.

Deep-dive into how the pieces fit together: **`ARCHITECTURE.md`**.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (uses the platform-assigned `PORT`)
- `pnpm --filter @workspace/willard-ai run dev` — run the web app
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string; `PORT` — server port; `SESSION_SECRET` — required in production

## Running locally (off Replit)

The server reads files directly from disk, so it can only see a user's local
drive (e.g. a Windows `Z:`) when it runs on that machine — on Replit's cloud
those paths are unreachable and the library reports "Library Offline".

- Full Windows/local setup guide: **`LOCAL_SETUP.md`** — the normal path is
  `Start Willard AI.bat`, backed by `scripts/launcher/start.ps1`. It safely
  checks for updates, repairs prerequisites, applies database migrations, starts
  both local services, waits for readiness, and retries one recoverable failure.
  `Stop`, `Repair`, and `Update` launchers remain available as advanced manual
  controls. All are Windows-only and exit immediately on Replit/non-Windows.
  Launcher logs go to the git-ignored `logs/` folder.
- The web artifact is installable as a PWA with a standalone window, shortcuts,
  and an offline static shell. A PWA cannot start PostgreSQL, the API server, or
  access a local/NAS filesystem; local users must start the native launcher first.
- Windows releases have a thin Inno Setup installer definition in
  `installer/WillardMediaCenter.iss`. The installed PowerShell launcher uses a
  bundled Node runtime and a small static/proxy web server, while PostgreSQL
  remains external and FFmpeg remains optional. Release staging is driven by
  `scripts/windows/build-release.mjs`; the Windows release workflow builds and
  publishes the versioned ZIP, checksum manifest, and Setup.exe on pushes to
  `main`. Compiling/signing and real installation validation require a Windows
  build runner.
- Copy `.env.example` → `.env` for local configuration. The API server loads the
  root `.env` automatically (via `--env-file-if-exists`); on Replit it is absent
  and the platform supplies env vars instead.
- Off Replit, the web dev server defaults to port `5000` and base path `/`, and
  all Replit-only Vite plugins are skipped. On Replit (`REPL_ID` set) the strict
  `PORT`/`BASE_PATH` requirement and Replit plugins remain in force.
- FFmpeg (`ffmpeg`/`ffprobe`) must be on PATH for thumbnails, video metadata, and
  media conversion; if missing the server logs a clear warning at startup instead
  of crashing. 7-Zip support is bundled (`7zip-bin`).
- Local browser validation on NixOS uses the `pkgs.chromium` browser from
  `replit.nix`; Playwright selects it automatically, avoiding the missing
  libraries in its downloaded Chromium. With the web app running, run
  `npx playwright test e2e/routed-workflows.spec.ts`. To use a different
  browser explicitly, set `PLAYWRIGHT_EXECUTABLE_PATH`; no `LD_LIBRARY_PATH`
  workaround is needed.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

- Willard Media Center is a desktop/web-only product. Do not propose, build, publish, or prioritize phone apps or mobile features unless the user explicitly reverses this decision.

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
