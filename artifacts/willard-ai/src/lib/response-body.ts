/**
 * Parses a successful JSON response without treating an intentionally empty
 * success body (for example HTTP 204/205) as a failed mutation.
 */
export async function readJsonOrEmpty<T>(response: Response): Promise<T | undefined> {
  const body = await response.text();
  if (body.trim() === "") return undefined;
  return JSON.parse(body) as T;
}