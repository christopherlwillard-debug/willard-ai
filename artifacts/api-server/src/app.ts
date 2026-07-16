import { randomBytes } from "crypto";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool, db } from "@workspace/db";

import { appSettingsTable, organizationJobsTable, conversionJobsTable } from "@workspace/db";
import { eq, inArray, or, and, isNotNull } from "drizzle-orm";
import router from "./routes";
import { logger } from "./lib/logger";
import { bootstrapWillardAIDir, nasLogStream, checkNasReachable } from "./lib/nas-storage";
import { checkMediaToolsOnStartup } from "./lib/media-tools";
import { recoverInterruptedJobs } from "./lib/library-engine";
import { startLibraryMonitor } from "./lib/library-monitor";
import { startLibraryWatcher } from "./lib/library-watcher";
import { startAiEnrichment } from "./lib/ai-enrichment";

export async function bootstrapSessionTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "session" (
      "sid"    varchar      NOT NULL COLLATE "default",
      "sess"   json         NOT NULL,
      "expire" timestamp(6) NOT NULL,
      CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
    ) WITH (OIDS=FALSE);
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
  `);
  await pool.query(`
    ALTER TABLE organization_jobs
      ADD COLUMN IF NOT EXISTS conflict_policy text NOT NULL DEFAULT 'keep_existing';
    ALTER TABLE organization_jobs
      ADD COLUMN IF NOT EXISTS last_stage text;
    ALTER TABLE organization_jobs
      ADD COLUMN IF NOT EXISTS stage_updated_at timestamp;
    ALTER TABLE app_settings
      ADD COLUMN IF NOT EXISTS logo_path text;
  `);
  await pool.query(`
    ALTER TABLE app_settings
      ADD COLUMN IF NOT EXISTS logo_path text;
    ALTER TABLE app_settings
      ADD COLUMN IF NOT EXISTS scan_performance text NOT NULL DEFAULT 'BALANCED';
    ALTER TABLE media_files
      ADD COLUMN IF NOT EXISTS quick_fingerprint text;
    ALTER TABLE media_files
      ADD COLUMN IF NOT EXISTS scanner_version integer NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS media_files_fingerprint_idx ON media_files (quick_fingerprint);
    CREATE INDEX IF NOT EXISTS media_files_size_idx ON media_files (nas_path, size_bytes);
    ALTER TABLE app_settings
      ADD COLUMN IF NOT EXISTS indexing_paused boolean NOT NULL DEFAULT false;
    ALTER TABLE app_settings
      ADD COLUMN IF NOT EXISTS onboarding_dismissed_at timestamp;
    ALTER TABLE app_settings
      ADD COLUMN IF NOT EXISTS celebration_shown_at timestamp;
  `);
  await pool.query(`
    ALTER TABLE media_files
      ADD COLUMN IF NOT EXISTS favorite boolean NOT NULL DEFAULT false;
    ALTER TABLE media_files
      ADD COLUMN IF NOT EXISTS favorited_at timestamp;
    CREATE TABLE IF NOT EXISTS collections (
      id serial PRIMARY KEY,
      nas_path text NOT NULL,
      kind text NOT NULL,
      name text NOT NULL,
      description text,
      auto_key text,
      removed_at timestamp,
      rule_json jsonb,
      cover_file_id integer,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS collections_nas_auto_key_unique ON collections (nas_path, auto_key);
    CREATE INDEX IF NOT EXISTS collections_nas_kind_idx ON collections (nas_path, kind);
    CREATE TABLE IF NOT EXISTS collection_items (
      id serial PRIMARY KEY,
      collection_id integer NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      media_file_id integer NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
      added_at timestamp NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS collection_items_unique ON collection_items (collection_id, media_file_id);
    CREATE INDEX IF NOT EXISTS collection_items_file_idx ON collection_items (media_file_id);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS library_activity (
      id serial PRIMARY KEY,
      nas_path text NOT NULL,
      kind text NOT NULL,
      message text NOT NULL,
      details jsonb,
      created_at timestamp NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS library_activity_nas_path_idx ON library_activity (nas_path);
    CREATE INDEX IF NOT EXISTS library_activity_created_at_idx ON library_activity (created_at);
  `);
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE IF NOT EXISTS media_ai (
      id serial PRIMARY KEY,
      media_file_id integer NOT NULL,
      description text,
      tags jsonb,
      objects jsonb,
      ocr_text text,
      doc_type text,
      scene text,
      embedding vector(384),
      ai_version integer NOT NULL DEFAULT 1,
      analyzed_at timestamp,
      error text
    );
    CREATE UNIQUE INDEX IF NOT EXISTS media_ai_file_idx ON media_ai (media_file_id);
    CREATE TABLE IF NOT EXISTS search_history (
      id serial PRIMARY KEY,
      query text NOT NULL,
      intent_json jsonb,
      result_count integer NOT NULL DEFAULT 0,
      created_at timestamp NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS search_history_created_idx ON search_history (created_at);
    CREATE TABLE IF NOT EXISTS saved_searches (
      id serial PRIMARY KEY,
      name text NOT NULL,
      query text NOT NULL,
      intent_json jsonb,
      created_at timestamp NOT NULL DEFAULT now(),
      last_used_at timestamp
    );
  `);
}

const PgStore = connectPgSimple(session);

const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const envSecret = process.env["SESSION_SECRET"];
if (!envSecret) {
  if (process.env["NODE_ENV"] === "production") {
    throw new Error("SESSION_SECRET env var is required in production. Set it before starting the server.");
  }
  logger.warn("SESSION_SECRET not set — using a random in-memory secret. Sessions will be invalidated on server restart.");
}
const sessionSecret = envSecret ?? randomBytes(32).toString("hex");

const app: Express = express();

// Trust the reverse proxy (Replit / production) so express-rate-limit can read
// X-Forwarded-For. Skip it for a bare local run where there is no proxy in front
// of the server — otherwise express-rate-limit warns about a permissive setting.
if (process.env["REPL_ID"] || process.env["NODE_ENV"] === "production") {
  app.set("trust proxy", 1);
}

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    store: new PgStore({
      pool,
      tableName: "session",
      createTableIfMissing: false,
    }),
    name: "willard.sid",
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: process.env["NODE_ENV"] === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: "lax",
    },
  }),
);

const PUBLIC_PATHS = new Set([
  "/healthz",
  "/auth/status",
  "/auth/login",
  "/auth/setup",
  "/auth/logout",
  "/auth/recover",
]);

app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  if (PUBLIC_PATHS.has(req.path)) {
    return next();
  }
  const sess = req.session as any;
  if (!sess?.authenticated) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (sess.lastSeenAt) {
    const elapsed = Date.now() - new Date(sess.lastSeenAt as string).getTime();
    if (elapsed > INACTIVITY_TIMEOUT_MS) {
      req.session.destroy(() => {});
      res.status(401).json({ error: "Session expired due to inactivity. Please log in again." });
      return;
    }
  }
  sess.lastSeenAt = new Date().toISOString();
  next();
});

app.use("/api", router);

// Initialize NAS log stream from persisted settings on startup
db.select().from(appSettingsTable).limit(1).then((rows) => {
  const nasPath = rows[0]?.nasPath;
  if (nasPath) {
    // Only bootstrap/attach logging when the location is actually reachable.
    // Bootstrapping an unreachable path (e.g. a Windows "Z:" drive) would
    // create a fake local folder that later masks the offline state.
    const reach = checkNasReachable(nasPath);
    if (reach.online) {
      try {
        bootstrapWillardAIDir(nasPath);
      } catch { /* NAS may not be mounted yet — non-fatal */ }
      nasLogStream.setNasPath(nasPath).catch(() => {});
      logger.info({ nasPath }, "NAS storage initialized from persisted settings");
    } else {
      logger.warn({ nasPath, reason: reach.message }, "Library Offline — NAS storage not initialized (location unreachable)");
    }
  }
}).catch(() => { /* DB not ready yet — logger will use stdout only */ });

// Warn (don't crash) if ffmpeg/ffprobe are missing — important for local installs
checkMediaToolsOnStartup();

// Recover library jobs interrupted mid-run
recoverInterruptedJobs().catch(() => {});

// Smart Library Health: watch reachability, auto-pause on offline,
// auto-rescan (incremental) on reconnect
startLibraryMonitor();

// Continuous Library Watcher: native fs events + sweep fallback, burst
// batching, auto-recovery — keeps the index live without manual rescans.
startLibraryWatcher();
startAiEnrichment();

// Detect conversion jobs interrupted mid-run (server died while status was "running").
// Mark them failed immediately so the UI can offer a retry instead of showing a stuck job.
db.update(conversionJobsTable)
  .set({ status: "failed", error: "Interrupted by server restart — partial backup preserved" })
  .where(eq(conversionJobsTable.status, "running"))
  .then(({ rowCount }) => {
    if (rowCount && rowCount > 0) {
      logger.warn(
        { count: rowCount },
        "RECOVERY: Marked interrupted conversion job(s) as failed — visit Optimize Center to retry",
      );
    }
  })
  .catch(() => {});

// Detect organize jobs interrupted mid-execution: "executing" status (server died) or
// "failed" jobs that have a lastStage set (meaning they failed during execute, not during analyze).
// Non-execution failures (e.g. analyze step) have null lastStage and are excluded.
db.select({ id: organizationJobsTable.id, sourcePath: organizationJobsTable.sourcePath, status: organizationJobsTable.status })
  .from(organizationJobsTable)
  .where(
    or(
      eq(organizationJobsTable.status, "executing"),
      and(
        eq(organizationJobsTable.status, "failed"),
        isNotNull(organizationJobsTable.lastStage),
      )
    )
  )
  .then((rows) => {
    if (rows.length > 0) {
      logger.warn(
        { count: rows.length, ids: rows.map(r => r.id), statuses: rows.map(r => r.status) },
        "RECOVERY: Found interrupted organize job(s) from previous session — visit Recovery Center to resume or roll back",
      );
    }
  })
  .catch(() => {});

export default app;
