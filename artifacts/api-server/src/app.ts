import { randomBytes } from "crypto";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool as dbPool, db } from "@workspace/db";

import { appSettingsTable, organizationJobsTable, conversionJobsTable } from "@workspace/db";
import { eq, inArray, or, and, isNotNull } from "drizzle-orm";
import router from "./routes";
import { logger } from "./lib/logger";
import { bootstrapWillardAIDir, nasLogStream, checkNasReachableAsync } from "./lib/nas-storage";
import { checkMediaToolsOnStartup } from "./lib/media-tools";
import { recoverInterruptedJobs, notifyUiConnected, emitStartupHealth, startThumbnailReconciliation } from "./lib/library-engine";
import { warmThumbnailCache } from "./routes/media";
import { startLibraryMonitor } from "./lib/library-monitor";
import { startLibraryWatcher } from "./lib/library-watcher";
import { startAiEnrichment } from "./lib/ai-enrichment";
import { startFaceRecognition } from "./lib/face-recognition";
import { recoverInterruptedConversionJobs, INTERRUPTED_CONVERSION_ERROR } from "./lib/conversion-recovery";
import { isVectorAvailable, setVectorAvailable } from "./lib/vector-capability";
import { withSchemaBootstrapLock, type Queryable } from "./lib/schema-bootstrap-lock";

const DEFAULT_ALLOWED_ORIGINS = new Set([
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:5000",
  "http://localhost:8080",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5000",
  "http://127.0.0.1:8080",
]);

const pool = dbPool;

function configuredAppOrigins(): Set<string> {
  const origins = new Set(DEFAULT_ALLOWED_ORIGINS);
  const addOrigin = (value: string) => {
    const candidate = value.trim();
    if (!candidate) return;
    try {
      origins.add(new URL(candidate.includes("://") ? candidate : `https://${candidate}`).origin);
    } catch {
      logger.warn({ value: candidate }, "Ignoring invalid configured app origin");
    }
  };
  for (const value of (process.env["REPLIT_DOMAINS"] ?? "").split(",")) addOrigin(value);
  if (process.env["REPLIT_DEV_DOMAIN"]) addOrigin(process.env["REPLIT_DEV_DOMAIN"]);
  if (process.env["REPLIT_EXPO_DEV_DOMAIN"]) addOrigin(process.env["REPLIT_EXPO_DEV_DOMAIN"]);
  for (const value of (process.env["WILLARD_ALLOWED_ORIGINS"] ?? "").split(",")) addOrigin(value);
  return origins;
}

const allowedAppOrigins = configuredAppOrigins();
function isAllowedAppOrigin(origin: string): boolean {
  try {
    return allowedAppOrigins.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

export async function initializeVectorCapability(queryable: Queryable = pool): Promise<void> {
  try {
    await queryable.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await queryable.query(`
      ALTER TABLE media_ai ADD COLUMN IF NOT EXISTS embedding vector(384);
      ALTER TABLE people    ADD COLUMN IF NOT EXISTS centroid  vector(512);
      ALTER TABLE faces     ADD COLUMN IF NOT EXISTS embedding vector(512);
    `);
    setVectorAvailable(true);
  } catch {
    setVectorAvailable(false);
    logger.warn("pgvector extension not available — AI similarity search and face recognition embeddings are disabled. Install pgvector to enable them.");
  }
  if (isVectorAvailable()) {
    try {
      await queryable.query(`
        CREATE INDEX IF NOT EXISTS media_ai_embedding_hnsw_idx
          ON media_ai USING hnsw (embedding vector_cosine_ops);
      `);
    } catch {
      logger.warn("Unable to create the pgvector HNSW index — AI similarity search will use exact scans.");
    }
  }
}

export async function bootstrapSessionTable(): Promise<void> {
  await withSchemaBootstrapLock(dbPool, async (client) => {
    const pool = client;
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
    DELETE FROM app_settings
    WHERE id NOT IN (
      SELECT id FROM app_settings
      ORDER BY (password_hash IS NOT NULL) DESC, id ASC
      LIMIT 1
    );
    CREATE UNIQUE INDEX IF NOT EXISTS app_settings_singleton_idx
      ON app_settings ((1));
  `);
  await pool.query(`
    ALTER TABLE organization_jobs
      ADD COLUMN IF NOT EXISTS conflict_policy text NOT NULL DEFAULT 'keep_existing';
    ALTER TABLE organization_jobs
      ADD COLUMN IF NOT EXISTS last_stage text;
    ALTER TABLE organization_jobs
      ADD COLUMN IF NOT EXISTS stage_updated_at timestamp;
    ALTER TABLE organization_jobs
      ADD COLUMN IF NOT EXISTS nas_path text;
    ALTER TABLE app_settings
      ADD COLUMN IF NOT EXISTS logo_path text;
    ALTER TABLE conversion_jobs
      ADD COLUMN IF NOT EXISTS cancelled_at timestamp;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cleanup_operations (
      operation_id text PRIMARY KEY,
      nas_path text NOT NULL,
      media_file_id integer NOT NULL,
      operation_type text NOT NULL DEFAULT 'CLEANUP',
      source_path text NOT NULL,
      trash_path text,
      size_bytes bigint NOT NULL DEFAULT 0,
      status text NOT NULL,
      error text,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS cleanup_operations_status_idx
      ON cleanup_operations (nas_path, status);
    ALTER TABLE cleanup_operations
      ADD COLUMN IF NOT EXISTS operation_type text NOT NULL DEFAULT 'CLEANUP';
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
    ALTER TABLE app_settings
      ADD COLUMN IF NOT EXISTS optimize_profile text NOT NULL DEFAULT 'ARCHIVE';
    ALTER TABLE app_settings
      ADD COLUMN IF NOT EXISTS raw_conversion_enabled boolean NOT NULL DEFAULT false;
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
    CREATE TABLE IF NOT EXISTS media_tags (
      id serial PRIMARY KEY,
      nas_path text NOT NULL,
      name text NOT NULL,
      created_at timestamp NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS media_tags_nas_name_unique ON media_tags (nas_path, name);
    CREATE INDEX IF NOT EXISTS media_tags_nas_path_idx ON media_tags (nas_path);
    CREATE TABLE IF NOT EXISTS media_file_tags (
      media_file_id integer NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
      tag_id integer NOT NULL REFERENCES media_tags(id) ON DELETE CASCADE,
      created_at timestamp NOT NULL DEFAULT now(),
      PRIMARY KEY (media_file_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS media_file_tags_tag_idx ON media_file_tags (tag_id);
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
  // Base tables — no vector dependency
  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_ai (
      id serial PRIMARY KEY,
      media_file_id integer NOT NULL,
      description text,
      tags jsonb,
      objects jsonb,
      ocr_text text,
      doc_type text,
      scene text,
      ai_version integer NOT NULL DEFAULT 1,
      analyzed_at timestamp,
      error text
    );
    CREATE UNIQUE INDEX IF NOT EXISTS media_ai_file_idx ON media_ai (media_file_id);
    ALTER TABLE media_ai ADD COLUMN IF NOT EXISTS people jsonb;
    ALTER TABLE media_ai ADD COLUMN IF NOT EXISTS user_tags jsonb;
    ALTER TABLE media_ai ADD COLUMN IF NOT EXISTS hidden_tags jsonb;
    ALTER TABLE media_ai ADD COLUMN IF NOT EXISTS user_description text;
    ALTER TABLE media_ai ADD COLUMN IF NOT EXISTS notes text;
    ALTER TABLE media_files ADD COLUMN IF NOT EXISTS place_name text;
    CREATE TABLE IF NOT EXISTS geo_place_cache (
      lat10 integer NOT NULL,
      lon10 integer NOT NULL,
      name text NOT NULL,
      resolved_at timestamp NOT NULL DEFAULT now(),
      PRIMARY KEY (lat10, lon10)
    );
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
    CREATE TABLE IF NOT EXISTS people (
      id serial PRIMARY KEY,
      nas_path text,
      name text,
      cover_face_id integer,
      face_count integer NOT NULL DEFAULT 0,
      hidden boolean NOT NULL DEFAULT false,
      created_at timestamp NOT NULL DEFAULT now()
    );
    ALTER TABLE people ADD COLUMN IF NOT EXISTS nas_path text;
    CREATE INDEX IF NOT EXISTS people_nas_path_idx ON people (nas_path);
    CREATE TABLE IF NOT EXISTS faces (
      id serial PRIMARY KEY,
      media_file_id integer NOT NULL,
      person_id integer,
      manual_assignment boolean NOT NULL DEFAULT false,
      box_x real NOT NULL,
      box_y real NOT NULL,
      box_w real NOT NULL,
      box_h real NOT NULL,
      score real NOT NULL,
      crop_path text,
      created_at timestamp NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS faces_file_idx ON faces (media_file_id);
    CREATE INDEX IF NOT EXISTS faces_person_idx ON faces (person_id);
    ALTER TABLE faces ADD COLUMN IF NOT EXISTS manual_assignment boolean NOT NULL DEFAULT false;
    CREATE TABLE IF NOT EXISTS face_scan_state (
      media_file_id integer PRIMARY KEY,
      face_version integer NOT NULL DEFAULT 1,
      face_count integer NOT NULL DEFAULT 0,
      scanned_at timestamp NOT NULL DEFAULT now(),
      error text
    );
  `);

  // pgvector is optional; probe it after the base schema exists.
  await initializeVectorCapability(client);
  await pool.query(`
    ALTER TABLE app_settings
      ADD COLUMN IF NOT EXISTS thumbnail_quality text NOT NULL DEFAULT 'BALANCED';
  `);
  await pool.query(`
    ALTER TABLE app_settings
      ADD COLUMN IF NOT EXISTS ignored_folders    text[]  NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS ignored_extensions text[]  NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS ignore_hidden_files  boolean NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS ignore_system_files  boolean NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS ignore_temp_files    boolean NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS ignore_sidecar_files boolean NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS ignore_empty_folders boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS follow_symlinks      boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS index_other_files    boolean NOT NULL DEFAULT true;
  `);
  await pool.query(`
    DELETE FROM media_files
    WHERE
      LOWER(name) IN (
        'thumbs.db','thumbs.db:encryptable','ehthumbs.db','ehthumbs_vista.db',
        'desktop.ini','autorun.inf','.ds_store','.localized','.appledouble','.appledesktop'
      )
      OR extension = 'thm'
      OR name LIKE '._%'
      OR name LIKE '~$%';
  `);
  await pool.query(`
    ALTER TABLE library_jobs
      ADD COLUMN IF NOT EXISTS diagnostics jsonb;
  `);
  await pool.query(`
    ALTER TABLE app_settings
      ADD COLUMN IF NOT EXISTS watcher_poll_interval_seconds integer NOT NULL DEFAULT 60;
  `);
  await pool.query(`
    ALTER TABLE media_files
      ADD COLUMN IF NOT EXISTS fingerprint_status text;
    ALTER TABLE media_files
      ADD COLUMN IF NOT EXISTS metadata_status text;
  `);
  });
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
app.use(cors({
  credentials: true,
  origin: (origin, callback) => {
    // Requests without an Origin header are not browser cross-site requests.
    callback(null, !origin || isAllowedAppOrigin(origin));
  },
}));
app.use((req: Request, res: Response, next: NextFunction) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin && !isAllowedAppOrigin(origin)) {
      res.status(403).json({ error: "Untrusted request origin." });
      return;
    }
  }
  next();
});
app.use(express.json({ limit: "32kb" }));
app.use(express.urlencoded({ extended: true, limit: "16kb" }));

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

// Fire the startup gate on the very first authenticated API request.
// Trips at most once per process; subsequent calls to notifyUiConnected() are no-ops.
let _firstAuthSeen = false;

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
  if (!_firstAuthSeen) {
    _firstAuthSeen = true;
    notifyUiConnected();
  }
  sess.lastSeenAt = new Date().toISOString();
  next();
});

app.use("/api", router);

// Initialize NAS log stream from persisted settings on startup
db.select().from(appSettingsTable).limit(1).then(async (rows) => {
  const nasPath = rows[0]?.nasPath;
  if (nasPath) {
    // Only bootstrap/attach logging when the location is actually reachable.
    // Bootstrapping an unreachable path (e.g. a Windows "Z:" drive) would
    // create a fake local folder that later masks the offline state.
    // Uses async check so Windows network-drive probing never blocks startup.
    const reach = await checkNasReachableAsync(nasPath);
    if (reach.online) {
      try {
        bootstrapWillardAIDir(nasPath);
      } catch { /* NAS may not be mounted yet — non-fatal */ }
      nasLogStream.setNasPath(nasPath).catch(() => {});
      logger.info({ nasPath }, "NAS storage initialized from persisted settings");
      // Emit startup health after a brief delay so DB queries complete cleanly
      setTimeout(() => emitStartupHealth(nasPath).catch(() => {}), 2_000);
      // Background reconciliation: verifies thumbnailPath rows against disk,
      // resets NULL for any whose .webp is missing so the thumb job picks them up.
      startThumbnailReconciliation(nasPath);
    } else {
      logger.warn({ nasPath, reason: reach.message }, "Library Offline — NAS storage not initialized (location unreachable)");
    }
  }
}).catch(() => { /* DB not ready yet — logger will use stdout only */ });

// Warn (don't crash) if ffmpeg/ffprobe are missing — important for local installs
checkMediaToolsOnStartup();

// Pre-populate thumbnail cache so the first page-load hits zero NAS stat calls
warmThumbnailCache().catch(() => {});

// Smart Library Health: watch reachability, auto-pause on offline,
// auto-rescan (incremental) on reconnect
startLibraryMonitor();

// Continuous Library Watcher: native fs events + sweep fallback, burst
// batching, auto-recovery — keeps the index live without manual rescans.
startLibraryWatcher();
startAiEnrichment();
startFaceRecognition();

// Detect conversion jobs interrupted mid-run (server died while status was "running").
// Mark them failed immediately so the UI can offer a retry instead of showing a stuck job.
recoverInterruptedConversionJobs()
  .then((count) => {
    if (count > 0) {
      logger.warn(
        { count, error: INTERRUPTED_CONVERSION_ERROR },
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
