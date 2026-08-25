import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  calculateLetterbox,
  detectFaces,
  embedFace,
  mapBoxToSource,
  nms,
  selectScrfdOutputs,
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

test("checked-in portrait fixtures detect faces and cluster duplicate portraits", {
  skip: !process.env.WILLARD_RUN_FACE_INTEGRATION,
}, async () => {
  const fixtureDir = path.resolve(import.meta.dirname, "../../../../test-media/Photos");
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