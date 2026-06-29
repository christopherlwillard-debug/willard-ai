# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

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

- Full Windows/local setup guide: **`LOCAL_SETUP.md`**
- Copy `.env.example` → `.env` for local configuration. The API server loads the
  root `.env` automatically (via `--env-file-if-exists`); on Replit it is absent
  and the platform supplies env vars instead.
- Off Replit, the web dev server defaults to port `5000` and base path `/`, and
  all Replit-only Vite plugins are skipped. On Replit (`REPL_ID` set) the strict
  `PORT`/`BASE_PATH` requirement and Replit plugins remain in force.
- FFmpeg (`ffmpeg`/`ffprobe`) must be on PATH for thumbnails, video metadata, and
  media conversion; if missing the server logs a clear warning at startup instead
  of crashing. 7-Zip support is bundled (`7zip-bin`).

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

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
