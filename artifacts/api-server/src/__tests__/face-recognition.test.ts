import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  calculateLetterbox,
  detectFaces,
  embedFace,
  mapBoxToSource,
  nms,
  selectScrfdOutputs,
  downloadModel,
  withFaceLibraryLock,
  type DetectedFace,
} from "../lib/face-recognition.ts";

test("selects SCRFD score and box tensors by trailing dimension and anchor count", () => {
  const tensors = [
    { dims: [1, 3200, 4], data: new Float32Array(12_800) },
    { dims: [1, 168, 1], data: new Float32Array(168) },
    { dims: [1, 168, 4], data: new Float32Array(672) },
    { dims: [1, 3200, 1], data: new Float32Array(3200) },
  ];
  const selected = selectScrfdOutputs(tensors, 3200);
  assert.equal(selected?.scores, tensors[3]);
  assert.equal(selected?.boxes, tensors[0]);
  assert.equal(selectScrfdOutputs(tensors, 80), null);
});

test("letterbox geometry maps padded detector coordinates back to source pixels", () => {
  const geometry = calculateLetterbox(640, 320);
  assert.deepEqual(geometry, {
    scale: 0.5,
    resizedWidth: 320,
    resizedHeight: 160,
    padRight: 0,
    padBottom: 160,
  });
  assert.deepEqual(
    mapBoxToSource({ x1: 40, y1: 20, x2: 280, y2: 140 }, geometry, 640, 320),
    { x: 80, y: 40, w: 480, h: 240, score: 0 },
  );
});

test("NMS keeps the highest-confidence overlapping face and separate faces", () => {
  const faces: DetectedFace[] = [
    { x: 10, y: 10, w: 100, h: 100, score: 0.91 },
    { x: 20, y: 20, w: 100, h: 100, score: 0.81 },
    { x: 250, y: 20, w: 80, h: 80, score: 0.76 },
  ];
  assert.deepEqual(nms(faces).map((face) => face.score), [0.91, 0.76]);
});

test("model downloads retry after interruption and publish only checksum-verified files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "willard-face-model-test-"));
  const dest = path.join(dir, "model.onnx");
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => ({
      ok: true,
      arrayBuffer: async () => { throw new Error("interrupted response"); },
    })) as unknown as typeof fetch;
    await assert.rejects(
      downloadModel("https://example.invalid/model.onnx", dest, "a".repeat(64)),
      /interrupted response/,
    );
    assert.equal(fs.existsSync(dest), false, "an interrupted response must not publish a model");
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")),
      [],
      "failed downloads must not leave temp files behind",
    );

    const payload = Buffer.alloc(1_000_001, 7);
    const expectedSha256 = (await import("node:crypto")).createHash("sha256").update(payload).digest("hex");
    globalThis.fetch = (async () => new Response(payload)) as typeof fetch;
    await assert.rejects(
      downloadModel("https://example.invalid/model.onnx", dest, "b".repeat(64)),
      /checksum mismatch/,
    );
    assert.equal(fs.existsSync(dest), false, "a checksum mismatch must not publish a model");

    await downloadModel("https://example.invalid/model.onnx", dest, expectedSha256);
    assert.equal(fs.statSync(dest).size, payload.length);
    assert.equal(
      (await import("node:crypto")).createHash("sha256").update(fs.readFileSync(dest)).digest("hex"),
      expectedSha256,
    );
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("face library advisory lock excludes another client and releases after failure", async (t) => {
  const reachable = await (async () => {
    try {
      const { pool } = await import("@workspace/db");
      await pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  })();
  if (!reachable) {
    t.skip("requires the configured PostgreSQL test database");
    return;
  }

  const nasPath = path.join(os.tmpdir(), `willard-face-lock-${Date.now()}-${Math.random()}`);
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });

  const first = withFaceLibraryLock(nasPath, async () => {
    entered();
    await releasePromise;
    return "first";
  });
  await enteredPromise;
  assert.equal(
    await withFaceLibraryLock(nasPath, async () => "second"),
    null,
    "a second API client must skip a library already being processed",
  );
  release();
  assert.equal(await first, "first");

  await assert.rejects(
    withFaceLibraryLock(nasPath, async () => { throw new Error("worker failed"); }),
    /worker failed/,
  );
  assert.equal(
    await withFaceLibraryLock(nasPath, async () => "after-failure"),
    "after-failure",
    "a failed worker must release the library lock for retry",
  );
});

test("checked-in portrait fixtures detect faces and cluster duplicate portraits", {
  skip: !process.env.WILLARD_RUN_FACE_INTEGRATION,
}, async () => {
  const fixtureDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../test-media/Photos",
  );
  const first = fs.readFileSync(path.join(fixtureDir, "portrait_a.jpg"));
  const duplicate = fs.readFileSync(path.join(fixtureDir, "portrait_a_copy.jpg"));
  const detected = await Promise.all([detectFaces(first), detectFaces(duplicate)]);

  assert.ok(detected[0].faces.length >= 1);
  assert.ok(detected[1].faces.length >= 1);

  const embeddings = await Promise.all([
    embedFace(first, detected[0].faces[0], detected[0].width, detected[0].height),
    embedFace(duplicate, detected[1].faces[0], detected[1].width, detected[1].height),
  ]);
  const similarity = embeddings[0].reduce((sum, value, i) => sum + value * embeddings[1][i], 0);
  assert.ok(similarity >= 0.42, `duplicate portraits should cluster (cosine=${similarity})`);
});