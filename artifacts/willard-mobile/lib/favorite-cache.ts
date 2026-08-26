import type { QueryClient, QueryKey } from "@tanstack/react-query";

export type FavoriteCacheKeys = {
  activeCollection: QueryKey;
  mediaFiles: QueryKey;
  collections: QueryKey;
};

export async function invalidateFavoriteCaches(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  keys: FavoriteCacheKeys,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.activeCollection }),
    queryClient.invalidateQueries({ queryKey: keys.mediaFiles }),
    queryClient.invalidateQueries({ queryKey: keys.collections }),
  ]);
}