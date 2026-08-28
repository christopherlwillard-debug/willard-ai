import { randomBytes, randomUUID } from "crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { isShuttingDown } from "./lib/shutdown-state.ts";
import { apiErrorHandler, apiNotFoundHandler } from "./lib/api-errors.ts";
import { markStartupDegraded } from "./lib/startup-health.ts";

const DEFAULT_ALLOWED_ORIGINS = new Set([
  "http://localhost",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:5000",
  "http://localhost:8080",
  "http://127.0.0.1",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5000",
  "http://127.0.0.1:8080",
]);

const pool = dbPool;

type RequiredSchemaBootstrap = {
  runRequiredSchema: (
    client: Queryable,
    options?: { log?: boolean },
  ) => Promise<void>;
};

function loadRequiredSchemaBootstrap(): RequiredSchemaBootstrap {
  const currentFile = fileURLToPath(import.meta.url);
  const candidates = [
    process.env["WILLARD_SCHEMA_SCRIPT"],
    path.resolve(process.cwd(), "setup-db.cjs"),
    path.resolve(process.cwd(), "../../setup-db.cjs"),
    path.resolve(path.dirname(currentFile), "../setup-db.cjs"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const bootstrap = createRequire(import.meta.url)(candidate) as Partial<RequiredSchemaBootstrap>;
      if (typeof bootstrap.runRequiredSchema !== "function") {
        throw new Error("setup-db.cjs does not export runRequiredSchema");
      }
      return bootstrap as RequiredSchemaBootstrap;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Database schema bootstrap could not load ${candidate}: ${detail}`,
        { cause: error },
      );
    }
  }

  throw new Error(
    "Database schema bootstrap is unavailable. Run setup-db.cjs or set WILLARD_SCHEMA_SCRIPT before starting the API.",
  );
}

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
    const { runRequiredSchema } = loadRequiredSchemaBootstrap();
    await runRequiredSchema(client, { log: false });
    await client.query(`
      ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS backup_enabled boolean NOT NULL DEFAULT true;
      ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS backup_schedule_hours integer NOT NULL DEFAULT 24;
      ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS backup_status text NOT NULL DEFAULT 'NEVER_CONFIGURED';
      ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS backup_last_attempt_at timestamp;
      ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS backup_last_success_at timestamp;
      ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS backup_last_verified_at timestamp;
      ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS backup_last_error text;
    `);
    // pgvector is optional; probe it only after all required tables exist.
    await initializeVectorCapability(client);
  });
}

const PgStore = connectPgSimple(session);

const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function destroySession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.destroy((error) => (error ? reject(error) : resolve()));
  });
}

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
    // Generate a server-owned correlation id for every request. Do not reuse
    // a client-supplied value because it can be attacker-controlled and would
    // make cross-request log searches ambiguous.
    genReqId: () => randomUUID(),
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
app.use((req: Request, res: Response, next: NextFunction) => {
  // The id is useful to support without exposing cookies, paths, or request
  // bodies in logs. It also lets a user connect a UI failure to server logs.
  res.setHeader("X-Request-Id", String(req.id));
  next();
});
app.use((req: Request, res: Response, next: NextFunction) => {
  if (isShuttingDown()) {
    res.status(503).json({ error: "Server is shutting down." });
    return;
  }
  next();
});
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
    const fetchSite = req.headers["sec-fetch-site"];
    if (typeof fetchSite === "string" && fetchSite.toLowerCase() === "cross-site") {
      res.status(403).json({ error: "Cross-site requests cannot change library state." });
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

app.use("/api", async (req: Request, res: Response, next: NextFunction) => {
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
      try {
        await destroySession(req);
      } catch (error) {
        req.log.warn({ err: error }, "Unable to destroy expired session");
      }
      res.clearCookie("willard.sid");
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
app.use(apiNotFoundHandler);
app.use(apiErrorHandler);

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
      let bootstrapped = false;
      try {
        bootstrapWillardAIDir(nasPath);
        bootstrapped = true;
      } catch (err) {
        logger.warn({ err, nasPath, reason: reach.message },
          "NAS is readable but WillardAI storage could not be initialized");
      }
      nasLogStream.setNasPath(nasPath).catch((err) => {
        markStartupDegraded("nas_log_stream", "NAS log storage could not be attached.");
        logger.error({ err, operation: "nas_log_stream" }, "NAS log storage could not be attached");
      });
      if (bootstrapped) {
        logger.info({ nasPath }, "NAS storage initialized from persisted settings");
      }
      // Emit startup health after a brief delay so DB queries complete cleanly
      setTimeout(() => emitStartupHealth(nasPath).catch((err) => {
        markStartupDegraded("startup_health", "Startup health collection did not complete.");
        logger.error({ err, operation: "startup_health" }, "Startup health collection did not complete");
      }), 2_000);
      // Background reconciliation: verifies thumbnailPath rows against disk,
      // resets NULL for any whose .webp is missing so the thumb job picks them up.
      startThumbnailReconciliation(nasPath);
    } else {
      logger.warn({ nasPath, reason: reach.message }, "Library Offline — NAS storage not initialized (location unreachable)");
    }
  }
}).catch((err) => {
  markStartupDegraded("nas_startup", "NAS startup initialization did not complete.");
  logger.error({ err, operation: "nas_startup" }, "NAS startup initialization did not complete");
});

// Warn (don't crash) if ffmpeg/ffprobe are missing — important for local installs
checkMediaToolsOnStartup();

// Pre-populate thumbnail cache so the first page-load hits zero NAS stat calls
warmThumbnailCache().catch((err) => {
  markStartupDegraded("thumbnail_cache", "Thumbnail cache initialization did not complete.");
  logger.error({ err, operation: "thumbnail_cache" }, "Thumbnail cache initialization did not complete");
});

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
  .catch((err) => {
    markStartupDegraded("conversion_recovery", "Conversion recovery did not complete.");
    logger.error({ err, operation: "conversion_recovery" }, "Conversion recovery did not complete");
  });

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
  .catch((err) => {
    markStartupDegraded("organize_recovery", "Organization recovery inspection did not complete.");
    logger.error({ err, operation: "organize_recovery" }, "Organization recovery inspection did not complete");
  });

export default app;
