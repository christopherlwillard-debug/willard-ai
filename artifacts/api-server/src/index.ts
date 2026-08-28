import app, { bootstrapSessionTable, initializeVectorCapability } from "./app";
import { logger } from "./lib/logger";
import { purgeExpiredTrashEntries, reconcileCleanupOperations } from "./lib/cleanup-recovery";
import { purgeOrphanedDerivedData } from "./lib/derived-cleanup.ts";
import { recoverInterruptedJobs } from "./lib/library-engine";
import { installShutdownHandlers } from "./lib/shutdown.ts";
import { startLibraryBackupCoordinator } from "./lib/backup-coordinator.ts";
import { markStartupDegraded } from "./lib/startup-health.ts";
import type { Server } from "node:http";

let server: Server | null = null;
installShutdownHandlers(() => server);

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
    server = app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }
      logger.info({ port }, "Server listening");
      startLibraryBackupCoordinator();

      // Health/readiness must be available as soon as the required schema
      // gate has passed. These cleanup and recovery tasks are safe to run
      // after binding and must not block the launcher's health probe.
      void (async () => {
        if (schemaReady) await initializeVectorCapability();
        await recoverInterruptedJobs();
        await reconcileCleanupOperations();
        const settings = await import("@workspace/db").then(({ db, appSettingsTable }) =>
          db.select({ nasPath: appSettingsTable.nasPath }).from(appSettingsTable).limit(1),
        );
        const nasPath = settings[0]?.nasPath?.trim();
        if (nasPath) {
          purgeExpiredTrashEntries(nasPath).catch((error) =>
            (() => {
              markStartupDegraded("expired_trash_cleanup", "Expired trash cleanup did not complete.");
              logger.error({ err: error, operation: "expired_trash_cleanup" }, "Expired trash cleanup failed");
            })(),
          );
          purgeOrphanedDerivedData(nasPath).catch((error) =>
            (() => {
              markStartupDegraded("derived_data_cleanup", "Orphaned derived-data cleanup did not complete.");
              logger.error({ err: error, operation: "derived_data_cleanup" }, "Orphaned derived-data cleanup failed");
            })(),
          );
        }
      })().catch((recoveryError) => {
        markStartupDegraded("post_start_recovery", "Post-start recovery did not complete.");
        logger.error({ err: recoveryError }, "Post-start recovery failed");
      });
    });
  })
  .catch((err) => {
    logger.error(
      { err },
      "Failed to bootstrap database schema; run setup-db.cjs to inspect or repair the database before restarting",
    );
    process.exit(1);
  });
