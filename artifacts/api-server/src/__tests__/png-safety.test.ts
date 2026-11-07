import assert from "node:assert/strict";
import test from "node:test";
import { classifyPngForJpegConversion } from "../lib/png-safety.ts";

const safePng = {
  width: 1600,
  height: 1200,
  hasAlpha: false,
  depth: "uchar",
  pages: 1,
};

test("PNG safety allows only valid opaque static 8-bit images", () => {
  assert.deepEqual(classifyPngForJpegConversion(safePng), {
    convert: true,
    reason: "Opaque, static 8-bit PNG; JPEG conversion is permitted.",
  });
});

test("PNG safety preserves images with alpha channels", () => {
  const decision = classifyPngForJpegConversion({ ...safePng, hasAlpha: true });
  assert.equal(decision.convert, false);
  assert.match(decision.reason, /alpha-channel/);
});

test("PNG safety preserves high-bit-depth images", () => {
  const decision = classifyPngForJpegConversion({ ...safePng, depth: "ushort" });
  assert.equal(decision.convert, false);
  assert.match(decision.reason, /8-bit/);
});

test("PNG safety preserves animated PNGs", () => {
  const decision = classifyPngForJpegConversion({ ...safePng, pages: 4 });
  assert.equal(decision.convert, false);
  assert.match(decision.reason, /animated/);
});

test("PNG safety fails closed when alpha, depth, or dimensions are unavailable", () => {
  for (const metadata of [
    { ...safePng, hasAlpha: undefined },
    { ...safePng, depth: undefined },
    { ...safePng, width: undefined },
    { ...safePng, height: 0 },
  ]) {
    assert.equal(classifyPngForJpegConversion(metadata).convert, false);
  }
});

test("PNG safety rejects invalid page counts", () => {
  assert.equal(classifyPngForJpegConversion({ ...safePng, pages: 0 }).convert, false);
  assert.equal(classifyPngForJpegConversion({ ...safePng, pages: 2 }).convert, false);
});
