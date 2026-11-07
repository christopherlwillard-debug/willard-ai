import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseHealthCleanupEvent } from "../health-cleanup-events.ts";

test("Health Center cleanup parser reads named progress and completion events", () => {
  assert.deepEqual(
    parseHealthCleanupEvent('event: progress\ndata: {"processed":2,"total":5,"message":"Checking files"}'),
    { type: "progress", processed: 2, total: 5, message: "Checking files" },
  );
  assert.deepEqual(
    parseHealthCleanupEvent('event: done\ndata: {"ok":true,"processed":5,"total":5}'),
    { type: "done", ok: true, processed: 5, total: 5 },
  );
});

test("Health Center cleanup parser preserves named errors and rejects malformed known events", () => {
  assert.deepEqual(
    parseHealthCleanupEvent('event: error\ndata: {"message":"NAS became unavailable"}'),
    { type: "error", message: "NAS became unavailable" },
  );
  assert.throws(
    () => parseHealthCleanupEvent("event: done\ndata: {}"),
    /success status/,
  );
  assert.throws(
    () => parseHealthCleanupEvent("event: progress\ndata: not-json"),
    /invalid event data/,
  );
});

test("Health Center cleanup parser preserves partial failures and metadata worker handoff", () => {
  assert.deepEqual(
    parseHealthCleanupEvent('event: done\ndata: {"ok":false,"partial":true,"failedItems":2,"metadataJobId":42,"message":"Two thumbnails failed; metadata job #42 is running."}'),
    {
      type: "done",
      ok: false,
      partial: true,
      failedItems: 2,
      metadataJobId: 42,
      message: "Two thumbnails failed; metadata job #42 is running.",
    },
  );
  assert.throws(
    () => parseHealthCleanupEvent('event: done\ndata: {"ok":false,"partial":true,"failedItems":0}'),
    /invalid failure count/,
  );
});

test("Health Center cleanup parser ignores comments and unknown event names", () => {
  assert.equal(parseHealthCleanupEvent(": keep-alive\n\n"), null);
  assert.equal(parseHealthCleanupEvent('event: future-event\ndata: {"value":1}'), null);
  assert.deepEqual(
    parseHealthCleanupEvent('event: progress\ndata: {"message":"Working","processed":-1,"total":0}'),
    { type: "progress", processed: 0, total: 1, message: "Working" },
  );
});

test("Health Center only clears selected actions after a successful completion event", () => {
  const page = readFileSync(new URL("../../pages/health.tsx", import.meta.url), "utf8");
  assert.match(page, /parseHealthCleanupEvent/);
  assert.match(page, /if \(!completed \|\| !completion\) throw/);
  assert.ok(page.indexOf("if (!completed || !completion) throw") < page.indexOf("setSelected([])"));
  assert.match(page, /if \(completion\.ok\) \{/);
  assert.match(page, /else if \(completion\.partial\)/);
  assert.match(page, /completion\.metadataJobId/);
  assert.match(page, /role="status"/);
});


test("Health Center labels metadata rebuild as an immediate worker action", () => {
  const page = readFileSync(new URL("../../pages/health.tsx", import.meta.url), "utf8");
  assert.ok(page.includes('["rebuildMetadata", "Rebuild outdated metadata now"]'));
});
