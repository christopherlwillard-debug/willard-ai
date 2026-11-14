import { logger } from "./logger.ts";

export type MediaHealthProgress = {
  phase: string;
  processed: number;
  total: number | null;
  message: string;
};

export type MediaHealthOutcome = {
  status?: "DONE" | "FAILED";
  summary: Record<string, unknown>;
  error?: string;
};

export interface MediaHealthJobStore {
  owns(jobId: number, token: string): Promise<boolean>;
  progress(jobId: number, token: string, progress: MediaHealthProgress): Promise<boolean>;
  complete(jobId: number, token: string, outcome: MediaHealthOutcome): Promise<boolean>;
  fail(jobId: number, token: string, message: string): Promise<boolean>;
  pause(jobId: number, token: string): Promise<boolean>;
}

export interface MediaHealthWorkerContext {
  assertOwned(): Promise<void>;
  reportProgress(progress: MediaHealthProgress): Promise<void>;
}

export type MediaHealthRunner = (context: MediaHealthWorkerContext) => Promise<MediaHealthOutcome>;
export type MediaHealthAfterComplete = (
  jobId: number,
  token: string,
  outcome: MediaHealthOutcome,
) => Promise<void>;

type ActiveWorker = {
  token: string;
  stopRequested: boolean;
  run: Promise<void>;
};

class HealthWorkerStoppedError extends Error {
  constructor() {
    super("Health worker is stopping");
    this.name = "HealthWorkerStoppedError";
  }
}

class HealthWorkerOwnershipLostError extends Error {
  constructor() {
    super("Health worker lost its durable job ownership");
    this.name = "HealthWorkerOwnershipLostError";
  }
}

export function createMediaHealthWorkerManager(
  store: MediaHealthJobStore,
  maxConcurrent = 1,
) {
  const workers = new Map<number, ActiveWorker>();

  const schedule = (
    jobId: number,
    token: string,
    runner: MediaHealthRunner,
    afterComplete?: MediaHealthAfterComplete,
  ): boolean => {
    if (workers.has(jobId) || workers.size >= maxConcurrent) return false;

    const worker: ActiveWorker = {
      token,
      stopRequested: false,
      run: Promise.resolve(),
    };
    workers.set(jobId, worker);

    const context: MediaHealthWorkerContext = {
      assertOwned: async () => {
        if (worker.stopRequested) throw new HealthWorkerStoppedError();
        if (!await store.owns(jobId, token)) throw new HealthWorkerOwnershipLostError();
      },
      reportProgress: async (progress) => {
        if (worker.stopRequested) throw new HealthWorkerStoppedError();
        if (!await store.progress(jobId, token, progress)) {
          throw new HealthWorkerOwnershipLostError();
        }
      },
    };

    worker.run = new Promise<void>((resolve) => setImmediate(resolve))
      .then(async () => {
        await context.assertOwned();
        const outcome = await runner(context);
        if (worker.stopRequested) throw new HealthWorkerStoppedError();
        const saved = await store.complete(jobId, token, outcome);
        if (!saved) throw new HealthWorkerOwnershipLostError();
        if (afterComplete) {
          try {
            await afterComplete(jobId, token, outcome);
          } catch (error) {
            logger.error({ err: error, jobId }, "Health worker follow-up action failed");
          }
        }
      })
      .catch(async (error: unknown) => {
        if (error instanceof HealthWorkerOwnershipLostError) return;
        const interrupted = error instanceof HealthWorkerStoppedError || worker.stopRequested;
        const message = interrupted
          ? "Health job paused for API shutdown; verify the library again after restart."
          : error instanceof Error
            ? error.message.slice(0, 1_000)
            : "Health worker failed";
        try {
          const saved = interrupted
            ? await store.pause(jobId, token)
            : await store.fail(jobId, token, message);
          if (!saved && !interrupted) {
            logger.warn({ jobId }, "Health worker could not persist its failure because ownership changed");
          }
        } catch (persistError) {
          logger.error({ err: persistError, jobId }, "Health worker could not persist its terminal state");
        }
        if (!interrupted && !(error instanceof HealthWorkerOwnershipLostError)) {
          logger.error({ err: error, jobId }, "Health worker failed");
        }
      })
      .finally(() => {
        if (workers.get(jobId) === worker) workers.delete(jobId);
      });

    return true;
  };

  const stopAll = async (): Promise<void> => {
    const active = [...workers.values()];
    for (const worker of active) worker.stopRequested = true;
    await Promise.allSettled(active.map((worker) => worker.run));
  };

  return {
    schedule,
    stopAll,
    get activeCount() {
      return workers.size;
    },
  };
}
