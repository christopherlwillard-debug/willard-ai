# Running Willard AI locally (Windows)

Willard AI's server reads files directly from disk. When it runs on Replit's
Linux cloud it can only see paths on that cloud server — it cannot reach a drive
on your own computer (e.g. a Windows `Z:` drive), so the library shows as
**Library Offline**. To point Willard at a local drive, run it on your own
machine where that drive is a real, local path.

This guide is written for **Windows**, but the same steps work on macOS/Linux
(use your platform's package manager where noted).

---

## 1. Prerequisites

Install these once:

| Tool | Why | Install |
|------|-----|---------|
| **Node.js 24+** | Runs the API server and web app | https://nodejs.org (LTS or current) |
| **pnpm** | Package manager for this monorepo | `npm install -g pnpm` |
| **PostgreSQL 14+** | The app's database | https://www.postgresql.org/download/windows/ |
| **FFmpeg** | Thumbnails, video metadata, media conversion | `winget install Gyan.FFmpeg` then restart your terminal |

> **7-Zip is bundled** — RAR/7z/ISO/CAB archive support ships with the app, so
> you don't need to install 7-Zip separately.

Verify the command-line tools are on your PATH (open a **new** terminal first):

```powershell
node --version
pnpm --version
ffmpeg -version
psql --version
```

If `ffmpeg` is not found, the app still runs, but thumbnails, video metadata,
and conversion will be unavailable until you install it and restart your
terminal.

---

## 2. Create the database

Create an empty PostgreSQL database (the app creates its own tables on first
start). Using the `psql` shell:

```sql
CREATE DATABASE willard;
```

Note the username, password, host, port, and database name — you'll put them in
the connection string next.

---

## 3. Configure environment variables

From the project root, copy the example file and edit it:

```powershell
copy .env.example .env
```

Open `.env` and set at least:

- `DATABASE_URL` — your PostgreSQL connection string, e.g.
  `postgresql://postgres:yourpassword@localhost:5432/willard`
- `PORT` — leave at `8080` (the web app proxies to this port)
- `SESSION_SECRET` — any long random string (the file shows how to generate one)

The `.env` file is git-ignored and never committed.

---

## 4. Install dependencies

From the project root:

```powershell
pnpm install
```

---

## 5. Start the app (two terminals)

**Terminal 1 — API server** (reads `.env`, listens on port 8080):

```powershell
pnpm --filter @workspace/api-server run dev
```

**Terminal 2 — web app** (defaults to http://localhost:5000):

```powershell
pnpm --filter @workspace/willard-ai run dev
```

Then open **http://localhost:5000** in your browser.

---

## 6. Point the library at your drive

1. Set an app password the first time you open the web app.
2. Go to **Settings** and set the library location to your drive, e.g. `Z:\`
   or any folder like `Z:\Media`.
3. Use **Test Connection** — it should report the library as reachable.
4. Save, then run a scan. The dashboard should show the library as
   **Connected / healthy** and the scan will index real files from that drive.

Because the server is now running on your machine, `Z:` is a real local path it
can read — exactly the path that is unreachable from the Replit cloud.

---

## Troubleshooting

- **"Library not found" or still Offline** — confirm the drive letter/path is
  correct and that the account running Node can access it. Network drives must be
  mapped and available to the current user.
- **No thumbnails / video info** — FFmpeg isn't on PATH. Install it, then open a
  new terminal and restart the API server.
- **Database connection errors** — double-check `DATABASE_URL` and that
  PostgreSQL is running and the database exists.
- **Port already in use** — change `PORT` in `.env` (API) and update the proxy
  target, or set a different `PORT` for the web terminal before starting it.
