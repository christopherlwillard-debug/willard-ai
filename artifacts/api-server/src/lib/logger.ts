import pino from "pino";
import { nasLogStream } from "./nas-storage.ts";
import { redactLogArguments, redactOperationalData, redactText, REDACTED } from "./log-redaction.ts";

const isProduction = process.env.NODE_ENV === "production";

const pinoOpts: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  // Keep this list as defense in depth for objects handled by pino serializers.
  // The logMethod hook below also covers arbitrary nested application fields.
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
      "nasPath",
      "sourcePath",
      "destinationPath",
      "fullPath",
      "relativePath",
      "path",
      "filename",
      "fileName",
      "sourceHash",
      "destHash",
      "contentHash",
      "hash",
      "fingerprint",
      "query",
      "report",
      "reportJson",
      "details",
      "*.nasPath",
      "*.sourcePath",
      "*.destinationPath",
      "*.fullPath",
      "*.relativePath",
      "*.path",
      "*.filename",
      "*.fileName",
      "*.sourceHash",
      "*.destHash",
      "*.contentHash",
      "*.hash",
      "*.fingerprint",
      "*.query",
      "*.report",
      "*.reportJson",
      "*.details",
    ],
    censor: REDACTED,
  },
  serializers: {
    err: (err: unknown) => redactOperationalData(err),
  },
  hooks: {
    logMethod(inputArgs, method) {
      method.apply(this, redactLogArguments(inputArgs) as Parameters<typeof method>);
    },
  },
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
