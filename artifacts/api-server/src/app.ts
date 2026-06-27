import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "@workspace/db";
import router from "./routes";
import { logger } from "./lib/logger";

const PgStore = connectPgSimple(session);

const sessionSecret = process.env["SESSION_SECRET"];
if (!sessionSecret) {
  logger.warn("SESSION_SECRET env var is not set — using insecure fallback. Set it before deploying.");
}

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
    secret: sessionSecret || "willard-dev-insecure-secret-change-me",
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

app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  const publicPaths = ["/healthz", "/auth/status", "/auth/login", "/auth/setup", "/auth/logout", "/auth/recover"];
  if (publicPaths.some((p) => req.path === p || req.path.startsWith(p))) {
    return next();
  }
  const sess = req.session as any;
  if (!sess?.authenticated) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  sess.lastSeenAt = new Date().toISOString();
  next();
});

app.use("/api", router);

export default app;
