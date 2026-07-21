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
 * if the timer fires first.  The original promise is not cancelled (not possible
 * in Node), but its eventual resolution/rejection is silently discarded.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error(`operation timed out after ${ms} ms`), { code: "operation_timeout" }));
    }, ms);
    promise.then(
      v  => { clearTimeout(timer); resolve(v); },
      e  => { clearTimeout(timer); reject(e);  },
    );
  });
}
