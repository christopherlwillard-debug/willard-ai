import { archivesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { resolveWithinRoot } from "./nas-storage.ts";
import { getActiveNasPath } from "./active-library.ts";

export function archiveScope(nasPath: string) {
  return eq(archivesTable.nasPath, nasPath);
}

export function archiveByIdScope(id: number, nasPath: string) {
  return and(eq(archivesTable.id, id), archiveScope(nasPath));
}

/**
 * A database archive path is untrusted even when its row belongs to the
 * active library. Canonicalize it through the active root before touching disk.
 */
export function resolveActiveArchivePath(archivePath: string, nasPath: string): string {
  return resolveWithinRoot(archivePath, nasPath);
}