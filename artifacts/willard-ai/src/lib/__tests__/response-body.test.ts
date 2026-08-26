import { test } from "node:test";
import * as assert from "node:assert/strict";
import { QueryClient } from "@tanstack/react-query";

import { readJsonOrEmpty } from "../response-body.ts";

test("successful JSON mutation responses retain their payload", async () => {
  const result = await readJsonOrEmpty<{ id: number }>(
    new Response(JSON.stringify({ id: 42 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );

  assert.deepEqual(result, { id: 42 });
});

test("a 204 or 205 mutation response completes UI success work and invalidates caches", async () => {
  for (const status of [204, 205]) {
    const queryClient = new QueryClient();
    const collectionKey = ["/api/collections"];
    let dialogClosed = false;
    let successToastShown = false;

    queryClient.setQueryData(collectionKey, { collections: [{ id: 42, name: "Family" }] });

    const result = await readJsonOrEmpty(new Response(null, { status }));
    queryClient.invalidateQueries({ queryKey: collectionKey });
    dialogClosed = true;
    successToastShown = result === undefined;

    assert.equal(queryClient.getQueryState(collectionKey)?.isInvalidated, true);
    assert.equal(dialogClosed, true);
    assert.equal(successToastShown, true);
  }
});