/**
 * Process-local conversion request registry used only for graceful shutdown.
 * Database session locks remain the cross-instance ownership authority.
 */
import { logger } from "./logger.ts";
import { stopActiveMediaTools } from "./media-tools.ts";

const activeConversionRequests = new Map<number, number>();
const activeConversionWaiters = new Set<() => void>();

function notifyWhenDrained(): void {
  if (activeConversionRequests.size !== 0) return;
  for (const resolve of [...activeConversionWaiters]) resolve();
}

export function trackConversionRequest(jobId: number): () => void {
  activeConversionRequests.set(jobId, (activeConversionRequests.get(jobId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = activeConversionRequests.get(jobId) ?? 0;
    if (count <= 1) activeConversionRequests.delete(jobId);
    else activeConversionRequests.set(jobId, count - 1);
    notifyWhenDrained();
  };
}

export async function stopActiveConversionJobs(timeoutMs = 8_000): Promise<void> {
  // Also terminate thumbnail FFmpeg children; this is the shared shutdown hook.
  await stopActiveMediaTools(Math.min(timeoutMs, 2_000));
  if (activeConversionRequests.size === 0) return;
  await new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      activeConversionWaiters.delete(finish);
      resolve();
    };
    activeConversionWaiters.add(finish);
    timer = setTimeout(finish, timeoutMs);
    if (activeConversionRequests.size === 0) finish();
  });
  if (activeConversionRequests.size > 0) {
    logger.warn({
      jobIds: [...activeConversionRequests.keys()],
      timeoutMs,
    }, "Some local conversion jobs did not finish before shutdown; their session locks will expire for recovery");
  }
}
