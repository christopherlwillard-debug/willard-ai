import app, { bootstrapSessionTable, initializeVectorCapability } from "./app";
import { logger } from "./lib/logger";
import { purgeExpiredTrashEntries, reconcileCleanupOperations } from "./lib/cleanup-recovery";
import { purgeOrphanedDerivedData } from "./lib/derived-cleanup.ts";
import { recoverInterruptedJobs } from "./lib/library-engine";
import { installShutdownHandlers } from "./lib/shutdown.ts";
import { startLibraryBackupCoordinator } from "./lib/backup-coordinator.ts";
import { markStartupDegraded } from "./lib/startup-health.ts";
import { getActiveNasPath } from "./lib/active-library.ts";
import { recoverInterruptedConversionJobs } from "./lib/conversion-recovery.ts";
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
    // Desktop installs set HOST=127.0.0.1 so the API cannot be reached
    // directly from the LAN around the localhost-only desktop web proxy.
    // Hosted deployments may explicitly set HOST=0.0.0.0 as required.
    const host = process.env["HOST"]?.trim()
      || (process.env["REPL_ID"] === undefined ? "127.0.0.1" : undefined);
    server = app.listen({ port, ...(host ? { host } : {}) }, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }
      logger.info({ port }, "Server listening");
      startLibraryBackupCoordinator();

      // Conversion recovery queries conversion_jobs and must run only after
      // startupMigrations has completed. Keep it in the background so a slow
      // NAS rollback never prevents the HTTP listener from becoming ready.
      void recoverInterruptedConversionJobs()
        .then((count) => {
          if (count > 0) {
            logger.warn(
              { count },
              "RECOVERY: Reconciled interrupted conversion operation(s); review Optimize Center before retrying or finalizing",
            );
          }
        })
        .catch((recoveryError) => {
          markStartupDegraded("conversion_recovery", "Conversion recovery did not complete.");
          logger.error({ err: recoveryError, operation: "conversion_recovery" }, "Conversion recovery did not complete");
        });

      // Health/readiness must be available as soon as the required schema
      // gate has passed. These cleanup and recovery tasks are safe to run
      // after binding and must not block the launcher's health probe.
      void (async () => {
        if (schemaReady) await initializeVectorCapability();
        await recoverInterruptedJobs();
        await reconcileCleanupOperations();
        const nasPath = await getActiveNasPath();
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
