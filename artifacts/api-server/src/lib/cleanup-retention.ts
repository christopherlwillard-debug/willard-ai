/**
 * Fail closed on absent or malformed retention metadata. Invalid dates must
 * never be interpreted as an instruction to permanently delete user media.
 */
export function isTrashEntryExpired(expiresAt: unknown, now = Date.now()): boolean {
  if (typeof expiresAt !== "string" || !expiresAt.trim()) return false;
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs < now;
}
