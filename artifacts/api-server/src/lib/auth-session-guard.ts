/**
 * Close the race between password verification and session creation.
 *
 * A password reset deletes all persisted sessions in its transaction. The
 * login path must therefore persist its new session before re-reading the
 * credential: if reset commits first, this check rejects the stale login;
 * if reset commits after the check, its DELETE removes the already-persisted
 * session.
 */
export async function persistSessionIfCredentialUnchanged(
  expectedPasswordHash: string,
  saveSession: () => Promise<void>,
  readCurrentPasswordHash: () => Promise<string | null>,
  destroySession: () => Promise<void>,
): Promise<boolean> {
  await saveSession();
  const currentPasswordHash = await readCurrentPasswordHash();
  if (currentPasswordHash === expectedPasswordHash) return true;
  await destroySession();
  return false;
}
