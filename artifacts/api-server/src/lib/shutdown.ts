import type { Server } from "node:http";
import { closePool, conversionJobsTable, db, organizationJobsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { stopAiEnrichment } from "./ai-enrichment.ts";
import { stopFaceRecognition } from "./face-recognition.ts";
import { stopLibraryJobs } from "./library-engine/index.ts";
import { stopLibraryMonitor } from "./library-monitor.ts";
import { stopLibraryWatcher } from "./library-watcher.ts";
import { stopThumbnailReconciliation } from "./library-engine/index.ts";
import { logger } from "./logger.ts";
import { markShuttingDown } from "./shutdown-state.ts";

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function bounded(
  name: string,
  operation: Promise<void>,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      operation,
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          logger.error({ name, timeoutMs }, "Shutdown step timed out");
          resolve();
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } catch (err) {
    logger.error({ err, name }, "Shutdown step failed");
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function closeHttpServer(server: Server | null): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    server.close((err) => {
      if (err) logger.warn({ err }, "HTTP server close reported an error");
      done();
    });
    server.closeIdleConnections?.();
  });
}

async function checkpointExternalJobs(): Promise<void> {
  const now = new Date();
  const conversion = await db.update(conversionJobsTable)
    .set({ cancelledAt: now })
    .where(eq(conversionJobsTable.status, "running"));
  const organize = await db.update(organizationJobsTable)
    .set({
      status: "failed",
      error: "Interrupted by server shutdown — partial work is recoverable",
      stageUpdatedAt: now,
    })
    .where(eq(organizationJobsTable.status, "executing"));
  logger.info({
    conversionJobs: conversion.rowCount ?? 0,
    organizeJobs: organize.rowCount ?? 0,
  }, "Checkpointed external jobs for shutdown");
}

export interface ShutdownDependencies {
  stopLibraryMonitor: () => Promise<void>;
  stopLibraryWatcher: () => Promise<void>;
  stopAiEnrichment: () => Promise<void>;
  stopFaceRecognition: () => Promise<void>;
  stopThumbnailReconciliation: () => Promise<void>;
  stopLibraryJobs: () => Promise<void>;
  checkpointExternalJobs: () => Promise<void>;
  closeHttpServer: (server: Server | null) => Promise<void>;
  closePool: () => Promise<void>;
}

const defaultShutdownDependencies: ShutdownDependencies = {
  stopLibraryMonitor,
  stopLibraryWatcher,
  stopAiEnrichment,
  stopFaceRecognition,
  stopThumbnailReconciliation,
  stopLibraryJobs,
  checkpointExternalJobs,
  closeHttpServer,
  closePool,
};

export function createShutdownCoordinator(
  dependencies: ShutdownDependencies = defaultShutdownDependencies,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
): (server: Server | null) => Promise<void> {
  let shutdownPromise: Promise<void> | null = null;

  return (server: Server | null): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      markShuttingDown();
      logger.info("Shutdown started");

      // Stop producers first so no new work is created while existing work drains.
      await Promise.all([
        bounded("library monitor", dependencies.stopLibraryMonitor(), timeoutMs),
        bounded("library watcher", dependencies.stopLibraryWatcher(), timeoutMs),
        bounded("AI enrichment", dependencies.stopAiEnrichment(), timeoutMs),
        bounded("face recognition", dependencies.stopFaceRecognition(), timeoutMs),
        bounded("thumbnail reconciliation", dependencies.stopThumbnailReconciliation(), timeoutMs),
      ]);

      // These writes must happen before the pool is closed. Library scans retain
      // their durable pause checkpoint; derived jobs receive a terminal signal.
      await bounded("job checkpoint", Promise.all([
        dependencies.checkpointExternalJobs(),
        dependencies.stopLibraryJobs(),
      ]).then(() => undefined), timeoutMs);

      // Stop accepting requests and allow active requests, including SSE, to drain.
      await bounded("HTTP drain", dependencies.closeHttpServer(server), timeoutMs);
      await bounded("database pool close", dependencies.closePool(), timeoutMs);
      logger.info("Shutdown complete");
    })();

    return shutdownPromise;
  };
}

export function installShutdownHandlers(getServer: () => Server | null): void {
  const shutdown = createShutdownCoordinator();
  const handleSignal = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, "Shutdown signal received");
    void shutdown(getServer()).then(
      () => process.exit(0),
      (err) => {
        logger.error({ err }, "Shutdown failed");
        process.exit(1);
      },
    );
  };

  process.once("SIGTERM", () => handleSignal("SIGTERM"));
  process.once("SIGINT", () => handleSignal("SIGINT"));
}