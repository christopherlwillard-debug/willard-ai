import { randomBytes } from "crypto";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool, db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db";
import router from "./routes";
import { logger } from "./lib/logger";
import { bootstrapWillardAIDir, nasLogStream } from "./lib/nas-storage";

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
      createTableIfMissing: true,
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
    try {
      bootstrapWillardAIDir(nasPath);
    } catch { /* NAS may not be mounted yet — non-fatal */ }
    nasLogStream.setNasPath(nasPath).catch(() => {});
    logger.info({ nasPath }, "NAS storage initialized from persisted settings");
  }
}).catch(() => { /* DB not ready yet — logger will use stdout only */ });

export default app;
