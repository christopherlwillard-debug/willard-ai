/**
 * Redaction shared by structured logs and operational JSON exports.
 *
 * Logs are useful for answering "what failed?" but must not become a second
 * copy of a user's library. Keep the allow-list of safe operational data
 * implicit by censoring path, identifier, content, and report fields at the
 * boundary where data is persisted.
 */

export const REDACTED = "[REDACTED]";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "passwordHash",
  "recoveryKey",
  "recoveryKeyHash",
  "sessionSecret",
  "token",
  "apiKey",
  "nasPath",
  "sourcePath",
  "destinationPath",
  "destination",
  "destDir",
  "destinations",
  "resolvedTo",
  "destinationDir",
  "thumbnailPath",
  "fullPath",
  "relativePath",
  "currentPath",
  "resolvedPath",
  "archivePath",
  "trashPath",
  "originalPath",
  "path",
  "logPath",
  "dir",
  "filename",
  "fileName",
  "sourceHash",
  "destHash",
  "contentHash",
  "sha256",
  "hash",
  "fingerprint",
  "query",
  "ocrText",
  "report",
  "reportJson",
  "details",
]);

const HASH_PATTERN = /\b(?:[a-f0-9]{40}|[a-f0-9]{64})\b/gi;
const ABSOLUTE_PATH_PATTERN = /(?:file:\/\/|[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|mnt|media|Volumes|tmp|var|opt|srv|data|workspace)(?:[\\/]))[^\r\n,;]+/gi;
const RELATIVE_PATH_PATTERN = /\b(?:[^/\s\\]+[\\/]){1,5}[^/\s\\,;]+/g;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key) || SENSITIVE_KEYS.has(key.toLowerCase());
}

/**
 * Redacts path/hash material embedded in an error or free-form message while
 * keeping the surrounding failure reason useful to an operator.
 */
export function redactText(value: string): string {
  return value
    .replace(HASH_PATTERN, REDACTED)
    .replace(ABSOLUTE_PATH_PATTERN, REDACTED)
    .replace(RELATIVE_PATH_PATTERN, REDACTED);
}

function isErrorLike(value: unknown): value is Error {
  return value instanceof Error || (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { message?: unknown }).message === "string" &&
    typeof (value as { name?: unknown }).name === "string"
  );
}

/**
 * Make a JSON-safe, recursively redacted copy. It intentionally preserves
 * object shape so diagnostics consumers still receive counts and statuses.
 */
export function redactOperationalData(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (value instanceof Date) return value.toISOString();

  if (isErrorLike(value)) {
    const error = value as Error;
    return {
      name: redactText(error.name),
      message: redactText(error.message),
      ...(error.stack ? { stack: redactText(error.stack) } : {}),
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactOperationalData(entry, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      result[key] = REDACTED;
    } else {
      result[key] = redactOperationalData(entry, seen);
    }
  }
  return result;
}

/**
 * Pino's logMethod hook sees every logger call, including calls made by
 * background workers that do not have an HTTP request context.
 */
export function redactLogArguments(args: unknown[]): unknown[] {
  return args.map((arg) => redactOperationalData(arg));
}