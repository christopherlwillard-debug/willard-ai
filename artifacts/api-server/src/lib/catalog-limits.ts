/**
 * Bounded collection and metadata policies for catalog-facing APIs.
 *
 * These are intentionally hard ceilings rather than client-controlled hints:
 * a large NAS should not turn one list or archive peek into an unbounded
 * database row, JSON response, or browser render.
 */
export const ARCHIVE_LIST_LIMIT = 100;
export const ARCHIVE_ENTRY_PAGE_LIMIT = 200;
export const ARCHIVE_PEEK_STORAGE_LIMIT = 5_000;
export const SEARCH_QUERY_MAX_LENGTH = 500;
export const SEARCH_HISTORY_RETENTION = 50;
export const SAVED_SEARCH_LIMIT = 100;

export function pageEntries(
  entries: unknown,
  totalEntries: number,
  offset: number,
  limit: number,
): { entries: unknown[]; totalEntries: number; entriesTruncated: boolean } {
  const storedEntries = Array.isArray(entries) ? entries : [];
  return {
    entries: storedEntries.slice(offset, offset + limit),
    totalEntries,
    entriesTruncated: totalEntries > storedEntries.length,
  };
}

export function storedPeekEntries<T>(entries: T[]): T[] {
  return entries.slice(0, ARCHIVE_PEEK_STORAGE_LIMIT);
}

export function responsePeekEntries<T>(entries: T[]): {
  entries: T[];
  totalEntries: number;
  entriesTruncated: boolean;
} {
  return {
    entries: entries.slice(0, ARCHIVE_ENTRY_PAGE_LIMIT),
    totalEntries: entries.length,
    entriesTruncated: entries.length > ARCHIVE_ENTRY_PAGE_LIMIT,
  };
}