export interface PngSafetyMetadata {
  width?: number;
  height?: number;
  hasAlpha?: boolean;
  depth?: string;
  pages?: number;
}

export interface PngSafetyDecision {
  convert: boolean;
  reason: string;
}

/**
 * JPEG cannot preserve PNG transparency, animation, or high-bit-depth samples.
 * Treat missing metadata as unsafe: conversion is allowed only when the file is
 * positively identified as a valid, opaque, static, 8-bit PNG.
 */
export function classifyPngForJpegConversion(metadata: PngSafetyMetadata): PngSafetyDecision {
  if (!Number.isSafeInteger(metadata.width) || (metadata.width ?? 0) <= 0 ||
      !Number.isSafeInteger(metadata.height) || (metadata.height ?? 0) <= 0) {
    return { convert: false, reason: "PNG dimensions could not be verified; original preserved." };
  }
  if (metadata.hasAlpha !== false) {
    return { convert: false, reason: "PNG alpha-channel status is unknown or contains transparency; JPEG cannot preserve it." };
  }
  if (metadata.depth !== "uchar") {
    return { convert: false, reason: "PNG is not confirmed 8-bit; JPEG conversion could reduce color precision." };
  }
  if (metadata.pages !== undefined && metadata.pages !== 1) {
    return { convert: false, reason: "PNG is animated or its page count is invalid; JPEG conversion would discard frames." };
  }
  return { convert: true, reason: "Opaque, static 8-bit PNG; JPEG conversion is permitted." };
}
