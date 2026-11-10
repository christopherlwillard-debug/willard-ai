export interface SecureSessionStorage {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export interface LegacySessionStorage {
  getItem(key: string): Promise<string | null>;
  removeItem(key: string): Promise<void>;
}

export interface MigratedSession {
  cookie: string | null;
  legacyRemoved: boolean;
}

/**
 * Move an existing bearer cookie to OS-backed secure storage. Never return a
 * legacy value unless its secure copy was written and verified first.
 */
export async function migrateSessionCookie(
  secure: SecureSessionStorage,
  legacy: LegacySessionStorage,
  key: string,
): Promise<MigratedSession> {
  const secureCookie = await secure.getItemAsync(key);
  let legacyCookie: string | null;
  try {
    legacyCookie = await legacy.getItem(key);
  } catch (error) {
    // An already-secure session remains usable when the obsolete store is
    // unavailable. Never fall back to the legacy value when secure storage
    // itself could not be read.
    if (secureCookie) return { cookie: secureCookie, legacyRemoved: false };
    throw error;
  }

  if (secureCookie) {
    if (!legacyCookie) return { cookie: secureCookie, legacyRemoved: true };
    try {
      await legacy.removeItem(key);
      return { cookie: secureCookie, legacyRemoved: true };
    } catch {
      return { cookie: secureCookie, legacyRemoved: false };
    }
  }

  if (!legacyCookie) return { cookie: null, legacyRemoved: true };

  await secure.setItemAsync(key, legacyCookie);
  const verifiedCookie = await secure.getItemAsync(key);
  if (verifiedCookie !== legacyCookie) {
    throw new Error("Secure session storage did not retain the migrated session.");
  }

  try {
    await legacy.removeItem(key);
    return { cookie: verifiedCookie, legacyRemoved: true };
  } catch {
    return { cookie: verifiedCookie, legacyRemoved: false };
  }
}

export async function clearStoredSession(
  secure: SecureSessionStorage,
  legacy: LegacySessionStorage,
  key: string,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await secure.deleteItemAsync(key);
  } catch (error) {
    failures.push(error);
  }
  try {
    await legacy.removeItem(key);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Saved mobile session could not be fully cleared.");
  }
}
