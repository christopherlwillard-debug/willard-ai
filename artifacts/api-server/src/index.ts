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
  .then(async () => {
    if (schemaReady) await initializeVectorCapability();
    await recoverInterruptedJobs();
    reconcileCleanupOperations().catch((err) => {
      logger.error({ err }, "Cleanup operation reconciliation failed");
    });
    app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }
      logger.info({ port }, "Server listening");
    });
  })
  .catch((err) => {
    logger.error({ err }, "Failed to bootstrap session table");
    process.exit(1);
  });
