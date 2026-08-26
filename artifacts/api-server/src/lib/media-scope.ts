import { sql } from "drizzle-orm";

/**
 * A media row is discoverable only while it has not been removed from the
 * library and has not been staged in the recycle bin.
 *
 * Keep this predicate NULL-safe: a newly indexed row has a NULL action.
 */
export const activeMediaCondition = sql.raw(
  "(media_files.last_scan_action IS DISTINCT FROM 'DELETED' AND media_files.last_scan_action IS DISTINCT FROM 'RECYCLED')",
);

/**
 * Equivalent predicate for parameterized/raw SQL queries that use a table
 * alias. Aliases are internal call-site constants, never user input.
 */
export function activeMediaSql(alias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error("Invalid media table alias");
  }
  return `(${alias}.last_scan_action IS DISTINCT FROM 'DELETED' AND ${alias}.last_scan_action IS DISTINCT FROM 'RECYCLED')`;
}