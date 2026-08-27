import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateCapacity,
  getCapacityStatus,
  releaseCapacity,
  reserveCapacity,
  setCapacityProbeForTests,
  type CapacitySnapshot,
} from "../lib/capacity-service.ts";

const GiB = 1024 ** 3;

function snapshot(target: "local" | "nas", targetPath: string, freeBytes: number | null): CapacitySnapshot {
  return {
    target,
    path: targetPath,
    totalBytes: freeBytes === null ? null : 32 * GiB,
    freeBytes,
    known: freeBytes !== null,
    checkedAt: new Date().toISOString(),
    ...(freeBytes === null ? { error: "test probe unavailable" } : {}),
  };
}

test("admits a large operation when both filesystems have safe headroom", async () => {
  const restore = setCapacityProbeForTests(async (target, targetPath) =>
    snapshot(target, targetPath, 16 * GiB),
  );
  try {
    const result = await evaluateCapacity({
      nasPath: "/nas/library",
      operation: "Archive extraction",
      nasBytes: 2 * GiB,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.code, "OK");
    assert.equal(result.required.nasBytes, 2 * GiB);
    assert.equal(result.floors.localBytes, 4 * GiB);
  } finally {
    restore();
  }
});

test("blocks uncontrolled local writes below the 4 GiB critical floor", async () => {
  const restore = setCapacityProbeForTests(async (target, targetPath) =>
    snapshot(target, targetPath, target === "local" ? 4 * GiB - 1 : 16 * GiB),
  );
  try {
    const result = await evaluateCapacity({
      nasPath: "/nas/library",
      operation: "Thumbnail generation",
    });
    assert.equal(result.allowed, false);
    assert.equal(result.code, "LOCAL_SPACE_LOW");
    assert.match(result.message, /laptop free space is below the safe floor/);
  } finally {
    restore();
  }
});

test("fails closed when NAS capacity is unknown", async () => {
  const restore = setCapacityProbeForTests(async (target, targetPath) =>
    snapshot(target, targetPath, target === "nas" ? null : 16 * GiB),
  );
  try {
    const result = await evaluateCapacity({
      nasPath: "/nas/library",
      operation: "Conversion",
      nasBytes: 1,
    });
    assert.equal(result.allowed, false);
    assert.equal(result.code, "NAS_CAPACITY_UNKNOWN");
  } finally {
    restore();
  }
});

test("reservations consume headroom and release restores admission", async () => {
  const restore = setCapacityProbeForTests(async (target, targetPath) =>
    snapshot(target, targetPath, 10 * GiB),
  );
  let reservationId = "";
  try {
    const reservation = await reserveCapacity({
      nasPath: "/nas/library",
      operation: "Conversion staging",
      nasBytes: 5 * GiB,
    });
    reservationId = reservation.id;
    const blocked = await evaluateCapacity({
      nasPath: "/nas/library",
      operation: "Second conversion",
      nasBytes: 2 * GiB,
    });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.code, "NAS_SPACE_LOW");
    assert.equal(blocked.reserved.nasBytes, 5 * GiB);
    assert.equal(releaseCapacity(reservation.id), true);
    const admitted = await evaluateCapacity({
      nasPath: "/nas/library",
      operation: "Second conversion",
      nasBytes: 2 * GiB,
    });
    assert.equal(admitted.allowed, true);
  } finally {
    if (reservationId) releaseCapacity(reservationId);
    restore();
  }
});

test("reservation re-probes after preflight so a lost destination is rejected", async () => {
  let nasAvailable = true;
  const restore = setCapacityProbeForTests(async (target, targetPath) =>
    snapshot(target, targetPath, target === "nas" && !nasAvailable ? null : 16 * GiB),
  );
  try {
    const preflight = await evaluateCapacity({
      nasPath: "/nas/library",
      operation: "Archive extraction",
      nasBytes: 1 * GiB,
    });
    assert.equal(preflight.allowed, true);
    nasAvailable = false;
    await assert.rejects(
      reserveCapacity({
        nasPath: "/nas/library",
        operation: "Archive extraction",
        nasBytes: 1 * GiB,
      }),
      (error: unknown) => (error as { code?: string }).code === "NAS_CAPACITY_UNKNOWN",
    );
  } finally {
    restore();
  }
});

test("capacity status exposes active reservations without exposing paths", async () => {
  const restore = setCapacityProbeForTests(async (target, targetPath) =>
    snapshot(target, targetPath, 16 * GiB),
  );
  try {
    const reservation = await reserveCapacity({
      nasPath: "/nas/library",
      operation: "Status test",
      nasBytes: 1,
    });
    try {
      const status = await getCapacityStatus("/nas/library");
      assert.equal(status.reservations.length, 1);
      assert.equal(status.reservations[0]?.operation, "Status test");
      assert.equal(status.floors.localBytes, 4 * GiB);
    } finally {
      releaseCapacity(reservation.id);
    }
  } finally {
    restore();
  }
});