import assert from "node:assert/strict";
import test from "node:test";
import {
  STORAGE_INVENTORY,
  getStoragePolicyState,
  getStoragePolicyStatus,
  measureDirectoryBytes,
} from "../lib/storage-policy.ts";

test("storage inventory is unique and covers every supported storage class", () => {
  const ids = STORAGE_INVENTORY.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    new Set(STORAGE_INVENTORY.map((entry) => entry.storageClass)),
    new Set(["NAS_REQUIRED", "BOUNDED_LOCAL", "BROWSER_DEVICE_LOCAL", "CONTROL_PLANE_LOCAL"]),
  );
  assert.ok(STORAGE_INVENTORY.every((entry) => entry.pathPattern.length > 0));
  assert.ok(STORAGE_INVENTORY.some((entry) => entry.protected && !entry.reclaimable));
  assert.ok(STORAGE_INVENTORY.some((entry) => entry.storageClass === "NAS_REQUIRED" && entry.durability === "NAS_BACKED"));
});

test("every derivative family has an explicit NAS destination and bounded reclaim rule", () => {
  const byId = new Map(STORAGE_INVENTORY.map((entry) => [entry.id, entry]));
  for (const id of [
    "thumbnail-derivatives",
    "preview-derivatives",
    "document-derivatives",
    "transcode-derivatives",
    "archive-derived-media",
    "conversion-working-staging",
  ]) {
    const entry = byId.get(id);
    assert.ok(entry, `missing inventory entry: ${id}`);
    assert.equal(entry.storageClass, "NAS_REQUIRED");
    assert.equal(entry.destination, "NAS_LIBRARY");
    assert.equal(entry.reclaimable, true);
    assert.match(entry.pathPattern, /<LIBRARY>\/WillardAI\//);
  }
});

test("NAS-required policy has explicit safe states", () => {
  assert.equal(getStoragePolicyState({ configured: false, online: false, writable: false, message: "not configured" }), "UNCONFIGURED");
  assert.equal(getStoragePolicyState({ online: false, writable: false, message: "offline" }), "PAUSED");
  assert.equal(getStoragePolicyState({ online: true, writable: false, message: "read-only" }), "READ_ONLY");
  assert.equal(getStoragePolicyState({ online: true, writable: true, message: "ready" }), "READY");
});

test("policy report is safe and explicit when no NAS is configured", async () => {
  const report = await getStoragePolicyStatus(null, {
    configured: false,
    online: false,
    writable: false,
    message: "No library location configured at C:\\Users\\private\\Pictures",
  });
  assert.equal(report.state, "UNCONFIGURED");
  assert.equal(report.stateMessage, "No library location configured.");
  assert.doesNotMatch(report.stateMessage, /C:\\Users\\private/);
  assert.equal(report.nasConfigured, false);
  assert.equal(report.capacity.known, false);
  assert.equal(report.usage.length, STORAGE_INVENTORY.length);
  assert.ok(report.usage.every((entry) => !("path" in entry)));
});

test("directory accounting is bounded and non-destructive", async () => {
  const report = await measureDirectoryBytes("/definitely-not-a-willard-directory");
  assert.deepEqual(report, { bytes: 0, files: 0, complete: true });
});