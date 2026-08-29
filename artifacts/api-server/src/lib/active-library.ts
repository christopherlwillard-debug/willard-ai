import path from "path";
import { createHash } from "crypto";
import { db, appSettingsTable } from "@workspace/db";
import { asc, desc, isNotNull } from "drizzle-orm";

export type ActiveLibraryContext = {
  nasPath: string;
  libraryKey: string;
};

export async function getActiveAppSettings() {
  const [settings] = await db
    .select()
    .from(appSettingsTable)
    .orderBy(desc(isNotNull(appSettingsTable.passwordHash)), asc(appSettingsTable.id))
    .limit(1);
  return settings ?? null;
}

export async function getActiveLibraryContext(): Promise<ActiveLibraryContext | null> {
  const settings = await getActiveAppSettings();
  const configured = settings?.nasPath?.trim();
  if (!configured) return null;

  const resolved = path.resolve(configured);
  const identityPath = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return {
    nasPath: configured,
    libraryKey: createHash("sha256").update(identityPath).digest("hex").slice(0, 16),
  };
}

export async function getActiveNasPath(): Promise<string | null> {
  return (await getActiveLibraryContext())?.nasPath ?? null;
}