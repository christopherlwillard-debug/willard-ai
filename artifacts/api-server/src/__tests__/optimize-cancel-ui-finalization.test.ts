import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const pagePath = path.resolve(
  import.meta.dirname,
  "../../../../artifacts/willard-ai/src/pages/optimize.tsx",
);

test("cancelled conversion with successful staged files opens finalization choices", () => {
  const source = fs.readFileSync(pagePath, "utf8");

  // Both new-run and retry SSE summaries must prioritize staged successes,
  // even when the summary also records that the run was cancelled.
  assert.equal(
    (source.match(/setPhase\(data\.succeeded > 0 \? "awaiting_action" : "done"\);/g) ?? []).length,
    2,
  );
  assert.doesNotMatch(source, /setPhase\(!data\.cancelled && data\.succeeded > 0/);

  // A reconnect must stop polling when the server reports the actionable state.
  assert.match(source, /job\.status === "awaiting_action"/);
  assert.match(source, /setPhase\(job\.status === "awaiting_action" \? "awaiting_action" : "done"\)/);
  assert.match(source, /choose what to do with the originals/);
});

test("Optimize dialog exits running state when starting a conversion fails", () => {
  const source = fs.readFileSync(pagePath, "utf8");
  const start = source.slice(source.indexOf("async function startConversion()"), source.indexOf("async function handleFinalize"));

  assert.match(start, /if \(!resp\.ok\)[\s\S]*?setRunError\([\s\S]*?setPhase\("done"\)/);
  assert.match(start, /catch \(err: any\)[\s\S]*?setRunError\([\s\S]*?setPhase\("done"\)/);
});
