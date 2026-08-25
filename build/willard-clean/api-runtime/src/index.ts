import app, { bootstrapSessionTable, initializeVectorCapability } from "./app";
import { logger } from "./lib/logger";
import { reconcileCleanupOperations } from "./lib/cleanup-recovery";
import { recoverInterruptedJobs } from "./lib/library-engine";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const schemaReady = process.env["WILLARD_SCHEMA_READY"] === "1";
const startupMigrations = schemaReady ? Promise.resolve() : bootstrapSessionTable();

startupMigrations
  .then(() => {
    app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }
      logger.info({ port }, "Server listening");

      // Health/readiness must be available as soon as the required schema
      // gate has passed. These cleanup and recovery tasks are safe to run
      // after binding and must not block the launcher's health probe.
      void (async () => {
        if (schemaReady) await initializeVectorCapability();
        await recoverInterruptedJobs();
        reconcileCleanupOperations().catch((recoveryError) => {
          logger.error({ err: recoveryError }, "Cleanup operation reconciliation failed");
        });
      })().catch((recoveryError) => {
        logger.error({ err: recoveryError }, "Post-start recovery failed");
      });
    });
  })
  .catch((err) => {
    logger.error({ err }, "Failed to bootstrap session table");
    process.exit(1);
  });
