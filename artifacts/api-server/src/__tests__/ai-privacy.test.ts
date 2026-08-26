import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aiProviderBlockedReason,
  canSendToAiProvider,
  isMediaExcluded,
  normalizeAiExclusions,
} from "../lib/ai-privacy.ts";

test("normalizes AI exclusions across Windows paths and dotted extensions", () => {
  assert.deepEqual(normalizeAiExclusions({
    aiExcludedFolders: ["\\Private\\", "private", " Family/Photos "],
    aiExcludedExtensions: [".PDF", "pdf", " jpg "],
  }), {
    folders: ["private", "family/photos"],
    extensions: ["pdf", "jpg"],
  });
});

test("excludes folders recursively and matches extensions case-insensitively", () => {
  const settings = {
    aiExcludedFolders: ["Private/Tax"],
    aiExcludedExtensions: ["pdf"],
  };
  assert.equal(isMediaExcluded("Private/Tax/2026/return.pdf", "return.pdf", settings), true);
  assert.equal(isMediaExcluded("Private/Tax-not-included", "photo.jpg", settings), false);
  assert.equal(isMediaExcluded("Family/photo.JPG", "photo.JPG", settings), false);
  assert.equal(isMediaExcluded("Family/document.PDF", "document.PDF", settings), true);
});

test("provider access requires both explicit enablement and cloud mode", () => {
  assert.equal(canSendToAiProvider({ aiEnrichmentEnabled: false, aiLocalOnly: false }), false);
  assert.equal(canSendToAiProvider({ aiEnrichmentEnabled: true, aiLocalOnly: true }), false);
  assert.equal(canSendToAiProvider({ aiEnrichmentEnabled: true, aiLocalOnly: false }), true);
  assert.match(aiProviderBlockedReason({ aiEnrichmentEnabled: false, aiLocalOnly: false }), /disabled/i);
  assert.match(aiProviderBlockedReason({ aiEnrichmentEnabled: true, aiLocalOnly: true }), /local-only/i);
});