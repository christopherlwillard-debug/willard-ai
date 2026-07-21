// ── Per-operation timeout constants ──────────────────────────────────────────
// Hard deadlines for per-file operations inside processOneFile.
// Exceeding these produces a PARTIAL outcome (file indexed with nulls +
// a status column set to "timeout") rather than blocking the entire scan.
// Values are intentionally generous to avoid false positives on slow NAS
// mounts; they exist solely to prevent indefinite hangs.
export const FINGERPRINT_TIMEOUT_MS = 15_000;  // 15 s — reading a small file sample
export const META_TIMEOUT_MS        = 30_000;  // 30 s — sharp / exifr / ffprobe / pdf-parse

/**
 * Races `promise` against a timer.  Rejects with `{ code: "operation_timeout" }`
 * if the timer fires first.
 *
 * When `isCancelled` is supplied it is polled every 200 ms; if it returns true
 * the race rejects immediately with `{ code: "operation_cancelled" }`.  This
 * makes Cancel respond in ≤200 ms instead of waiting for the full timeout to
 * expire (up to 45 s across fingerprint + metadata operations).
 *
 * The original promise is not cancelled (impossible in Node), but its eventual
 * resolution/rejection is silently discarded after the race is decided.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  isCancelled?: () => boolean,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => reject(Object.assign(
        new Error(`operation timed out after ${ms} ms`),
        { code: "operation_timeout" },
      )));
    }, ms);

    let poll: ReturnType<typeof setInterval> | null = null;
    if (isCancelled) {
      poll = setInterval(() => {
        if (isCancelled()) {
          settle(() => reject(Object.assign(
            new Error("operation cancelled"),
            { code: "operation_cancelled" },
          )));
        }
      }, 200);
    }

    promise.then(
      v => settle(() => resolve(v)),
      e => settle(() => reject(e)),
    );
  });
}
