/**
 * Run async work with a fixed number of workers without queuing one promise per
 * item. All already-started work settles before the first error is rethrown.
 */
export async function forEachBounded<T>(
  items: readonly T[],
  concurrency: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Concurrency must be a positive integer");
  }

  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    for (;;) {
      if (failed) return;
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        await work(items[index]!, index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
        return;
      }
    }
  }));

  if (failed) throw firstError;
}

/**
 * Scale cached-file existence checks with the selected scan profile. The
 * balanced profile stays conservative; High can use up to eight parallel NAS
 * stats, matching the documented limit for typical SMB shares.
 */
export function skippedFileStatConcurrency(scanConcurrencyCeiling: number): number {
  if (!Number.isSafeInteger(scanConcurrencyCeiling) || scanConcurrencyCeiling < 1) {
    throw new RangeError("Scan concurrency ceiling must be a positive integer");
  }
  return Math.min(
    scanConcurrencyCeiling,
    Math.max(2, Math.min(8, Math.ceil(scanConcurrencyCeiling * 0.4))),
  );
}
