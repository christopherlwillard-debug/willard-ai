import { test } from "node:test";
import * as assert from "node:assert/strict";
import { QueryClient } from "@tanstack/react-query";

import { invalidateFavoriteCaches } from "../../lib/favorite-cache.ts";

test("favoriting from an album invalidates the album, Favorites, and collection-list caches", async () => {
  const queryClient = new QueryClient();
  const keys = {
    activeCollection: ["/api/collections/42/items"],
    mediaFiles: ["/api/media/files"],
    collections: ["/api/collections"],
  };

  queryClient.setQueryData(keys.activeCollection, { files: [{ id: 7, favorite: false }] });
  queryClient.setQueryData(keys.mediaFiles, { files: [], total: 0 });
  queryClient.setQueryData(keys.collections, { collections: [], favoritesCount: 0 });

  await invalidateFavoriteCaches(queryClient, keys);

  assert.equal(queryClient.getQueryState(keys.activeCollection)?.isInvalidated, true);
  assert.equal(queryClient.getQueryState(keys.mediaFiles)?.isInvalidated, true);
  assert.equal(queryClient.getQueryState(keys.collections)?.isInvalidated, true);
});