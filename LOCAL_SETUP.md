# Running Willard AI on your own computer (Windows)

Willard AI's server reads files directly from disk. When it runs on Replit's
Linux cloud it can only see paths on that cloud server — it cannot reach a drive
on your own computer (e.g. a Windows `Z:` drive), so the library shows as
**Library Offline**. To point Willard at a local drive, run it on your own
machine where that drive is a real, local path.

---

## The easy way: install once, then use the desktop icon

For a packaged Windows release, run the Willard Media Center installer once.
It creates a desktop shortcut and a Start Menu entry. From then on, double-click
**Willard Media Center** to start the local application; the installed native
launcher shows the looping loading screen, checks the published release, applies
a verified update when needed, starts or recovers local services, applies safe
database migrations, verifies readiness, and opens the web UI.

The installer includes the application, production API dependencies, a private
Node runtime, and the launcher. It does **not** include PostgreSQL, your media,
the database, or FFmpeg. PostgreSQL remains an external service because it owns
your library and authentication data; FFmpeg is optional.

The packaged installer is built by the Windows release pipeline. Inno Setup,
code signing, and real Windows install/upgrade validation must run on a Windows
build machine; they cannot be completed inside Replit's Linux environment.

## Developer-folder fallback: use the Willard shortcut

Once the one-time prerequisites below are installed, opening Willard Media Center
uses one normal entry point in the project root. Run **`Setup Willard AI.bat`**
once; setup creates **Willard Media Center** shortcuts on the desktop and in the
Start Menu. Those shortcuts launch `Start Willard AI.bat` with the project folder
as their working directory, so they work regardless of the folder that is
current when Windows launches them.

| File | What it does |
|------|--------------|
| **`Start Willard AI.bat`** | The underlying launcher used by the Willard Media Center shortcuts; checks the local installation, starts the app, and opens it |
| **`Stop Willard AI.bat`** | Advanced manual troubleshooting control: cleanly shuts the app down |
| **`Repair Willard AI.bat`** | Advanced manual troubleshooting control: fixes common problems |
| **`Update Willard AI.bat`** | Advanced manual troubleshooting control: forces an update outside normal startup |

**To start:** open **Willard Media Center** from the desktop or Start Menu. For
advanced troubleshooting, you can also double-click `Start Willard AI.bat`
directly from the project folder. It will:

1. Check that Node.js, pnpm, and PostgreSQL are installed (and tell you exactly
   what to install if something is missing).
2. Use the local application files without requiring GitHub or an internet connection.
3. Check your `.env` file exists and the database is reachable, then apply safe
   database migrations.
4. Start or recover the API server and web app in the background (logs go to the `logs/`
   folder).
5. Wait until both services are ready, retrying one recoverable service failure,
   then open **http://localhost:5000** in your
   browser.

If anything goes wrong, the window stays open and explains what to do in plain
language. The launcher retries safe failures automatically; use
`Repair Willard AI.bat` only for advanced manual troubleshooting.

### Installed web app (PWA)

The browser may offer **Install Willard Media Center**. The installed PWA gives
the web interface its own desktop-style window, icon, and shortcuts. It is an
offline shell only: private media and API responses are never cached, and the
PWA cannot start PostgreSQL, the API server, or access a local/NAS path. On a
local Windows install, launch the native desktop shortcut first; then open the
installed app. The PWA is the web UI, not the process manager.

**First time in the app:** set your app password, then Willard will walk you
through picking your media drive (it detects available drives for you), test
the connection, and start building your library. A checklist on the dashboard
guides you through the rest.

---

## One-time prerequisites

For the packaged installer, PostgreSQL is the only required software outside
the installer. The installer includes a private Node runtime and does not
require Node.js or pnpm on PATH. FFmpeg remains optional. The list below is for
the developer-folder fallback, where the Start script checks all of them:

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

That's it — from now on, just open **Willard Media Center** from the desktop or
Start Menu. The shortcut is separate from the browser PWA: it starts and checks
the local services first, then opens the installed PWA or browser at the local
app address.

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
  `Repair Willard AI.bat` as an advanced repair tool. The normal Start entry
  already retries recoverable failures and performs safe setup.
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
