import { db, libraryActivityTable } from "@workspace/db";
import { desc, eq, lt, sql } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Library Activity feed — friendly, plain-English records of what the live
 * library engine did: scans, catch-ups after downtime, watcher restarts,
 * bursts, offline/online transitions.
 *
 * Kinds: scan_summary | catchup | reconnected | offline | burst | watcher_restart | paused | resumed
 */

export type ActivityKind =
  | "scan_summary"
  | "catchup"
  | "reconnected"
  | "offline"
  | "burst"
  | "watcher_restart"
  | "paused"
  | "resumed";

const MAX_ACTIVITY_ROWS = 500;

export async function recordActivity(
  nasPath: string,
  kind: ActivityKind,
  message: string,
  details?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(libraryActivityTable).values({
      nasPath,
      kind,
      message,
      details: details ?? null,
    });
    // Best-effort pruning so the feed never grows unbounded.
    await db.execute(sql`
      DELETE FROM library_activity
      WHERE id IN (
        SELECT id FROM library_activity
        WHERE nas_path = ${nasPath}
        ORDER BY created_at DESC, id DESC
        OFFSET ${MAX_ACTIVITY_ROWS}
      )
    `);
  } catch (err) {
    logger.warn({ err, kind }, "Failed to record library activity");
  }
}

export interface ScanChangeCounts {
  newFiles: number;
  modifiedFiles: number;
  movedFiles: number;
  deletedFiles: number;
}

/** "17 new files, 3 updated, 2 moved, 1 deleted" — omits zero counts. */
export function describeChanges(c: ScanChangeCounts): string | null {
  const parts: string[] = [];
  if (c.newFiles > 0) parts.push(`${c.newFiles.toLocaleString()} new file${c.newFiles === 1 ? "" : "s"}`);
  if (c.modifiedFiles > 0) parts.push(`${c.modifiedFiles.toLocaleString()} updated`);
  if (c.movedFiles > 0) parts.push(`${c.movedFiles.toLocaleString()} moved`);
  if (c.deletedFiles > 0) parts.push(`${c.deletedFiles.toLocaleString()} deleted`);
  if (parts.length === 0) return null;
  return parts.join(", ");
}

export async function getRecentActivity(nasPath: string, limit = 20) {
  return db.select().from(libraryActivityTable)
    .where(eq(libraryActivityTable.nasPath, nasPath))
    .orderBy(desc(libraryActivityTable.createdAt), desc(libraryActivityTable.id))
    .limit(limit);
}
