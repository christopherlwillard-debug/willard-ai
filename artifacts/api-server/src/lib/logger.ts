import pino from "pino";
import { nasLogStream } from "./nas-storage";

const isProduction = process.env.NODE_ENV === "production";

const pinoOpts: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
};

const streams: pino.StreamEntry[] = isProduction
  ? [{ stream: process.stdout }, { stream: nasLogStream }]
  : [
      {
        stream: pino.transport({
          target: "pino-pretty",
          options: { colorize: true },
        }),
      },
      { stream: nasLogStream },
    ];

export const logger = pino(pinoOpts, pino.multistream(streams));
