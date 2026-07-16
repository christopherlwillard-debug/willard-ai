# Running Willard AI on your own computer (Windows)

Willard AI's server reads files directly from disk. When it runs on Replit's
Linux cloud it can only see paths on that cloud server — it cannot reach a drive
on your own computer (e.g. a Windows `Z:` drive), so the library shows as
**Library Offline**. To point Willard at a local drive, run it on your own
machine where that drive is a real, local path.

---

## The easy way: double-click to start

Once the one-time prerequisites below are installed, running Willard AI is
three files in the project root:

| File | What it does |
|------|--------------|
| **`Start Willard AI.bat`** | Checks everything, starts the app, and opens it in your browser |
| **`Stop Willard AI.bat`** | Cleanly shuts the app down |
| **`Repair Willard AI.bat`** | Fixes common problems (reinstalls dependencies, clears stuck processes, re-checks the database) |

**To start:** double-click `Start Willard AI.bat`. It will:

1. Check that Node.js, pnpm, and PostgreSQL are installed (and tell you exactly
   what to install if something is missing).
2. Check your `.env` file exists and the database is reachable.
3. Install dependencies if needed.
4. Start the API server and web app in the background (logs go to the `logs/`
   folder).
5. Wait until the app is ready, then open **http://localhost:5000** in your
   browser.

If anything goes wrong, the window stays open and explains what to do in plain
language. Run `Repair Willard AI.bat` for automatic fixes.

**First time in the app:** set your app password, then Willard will walk you
through picking your media drive (it detects available drives for you), test
the connection, and start building your library. A checklist on the dashboard
guides you through the rest.

---

## One-time prerequisites

Install these once (the Start script checks all of them and tells you if any
are missing):

| Tool | Why | Install |
|------|-----|---------|
| **Node.js 24+** | Runs the API server and web app | https://nodejs.org (LTS or current) |
| **pnpm** | Package manager for this monorepo | `npm install -g pnpm` |
| **PostgreSQL 14+** | The app's database | https://www.postgresql.org/download/windows/ |
| **FFmpeg** | Thumbnails, video metadata, media conversion | `winget install Gyan.FFmpeg` then restart your terminal |

> **7-Zip is bundled** — RAR/7z/ISO/CAB archive support ships with the app, so
> you don't need to install 7-Zip separately.
>
> If FFmpeg is missing the app still runs; thumbnails, video metadata, and
> conversion are unavailable until you install it.

### Create the database (once)

Create an empty PostgreSQL database (the app creates its own tables on first
start). Using the `psql` shell:

```sql
CREATE DATABASE willard;
```

### Configure environment variables (once)

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

That's it — from now on, just double-click **`Start Willard AI.bat`**.

---

## The manual way (any platform, or if you prefer terminals)

The launcher scripts are Windows-only. On macOS/Linux, or if you want direct
control, run the same steps by hand after the prerequisites above:

**1. Install dependencies** (project root):

```powershell
pnpm install
```

**2. Start the app (two terminals):**

Terminal 1 — API server (reads `.env`, listens on port 8080):

```powershell
pnpm --filter @workspace/api-server run dev
```

Terminal 2 — web app (defaults to http://localhost:5000):

```powershell
pnpm --filter @workspace/willard-ai run dev
```

Then open **http://localhost:5000** in your browser.

**3. Point the library at your drive:**

1. Set an app password the first time you open the web app.
2. Willard opens straight into **Library Setup** — pick a detected drive or
   type a path like `Z:\` or `Z:\Media`, test it, and save.
3. Willard starts building your library immediately; the dashboard shows
   progress per category and a getting-started checklist.

Because the server is now running on your machine, `Z:` is a real local path it
can read — exactly the path that is unreachable from the Replit cloud.

You can change the library location any time in **Settings → Libraries**.

---

## Troubleshooting

- **Something's broken and you're not sure what** — run
  `Repair Willard AI.bat`. It clears stuck processes, re-checks your database
  connection, and reinstalls dependencies.
- **"Library not found" or still Offline** — confirm the drive letter/path is
  correct and that the account running Node can access it. Network drives must
  be mapped and available to the current user. Use **Settings → Libraries →
  Change Library** to re-test the path.
- **No thumbnails / video info** — FFmpeg isn't on PATH. Install it, then open a
  new terminal and restart the app.
- **Database connection errors** — double-check `DATABASE_URL` and that
  PostgreSQL is running and the database exists.
- **Port already in use** — the Start script detects this and names the ports.
  Stop whatever is using ports 8080/5000 (or run `Stop Willard AI.bat` to clear
  a previous Willard session), then start again.
- **Where are the logs?** — the launcher writes API and web logs to the
  `logs/` folder in the project root.
