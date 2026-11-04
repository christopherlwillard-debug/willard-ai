import assert from "node:assert/strict";
import test from "node:test";
import { isTrashEntryExpired } from "../lib/cleanup-retention.ts";

test("trash retention fails closed when expiration metadata is missing or malformed", () => {
  const now = Date.parse("2026-11-04T12:00:00.000Z");
  assert.equal(isTrashEntryExpired(undefined, now), false);
  assert.equal(isTrashEntryExpired("", now), false);
  assert.equal(isTrashEntryExpired("not-a-date", now), false);
  assert.equal(isTrashEntryExpired("2026-11-04T13:00:00.000Z", now), false);
  assert.equal(isTrashEntryExpired("2026-11-04T11:59:59.000Z", now), true);
});
