/** Escape PostgreSQL LIKE metacharacters when a user expects literal substring matching. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
