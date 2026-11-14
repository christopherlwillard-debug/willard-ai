import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AI_CONSENT_VERSION,
  AI_PROVIDER_NAME,
  aiProviderBlockedReason,
  canSendToAiProvider,
  hasCurrentAiConsent,
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

test("provider access requires enablement, cloud mode, and current provider consent", () => {
  const currentConsent = {
    aiConsentAt: new Date(),
    aiConsentProvider: AI_PROVIDER_NAME,
    aiConsentVersion: AI_CONSENT_VERSION,
  };
  const enabledCloud = { aiEnrichmentEnabled: true, aiLocalOnly: false, ...currentConsent };

  assert.equal(canSendToAiProvider({ ...enabledCloud, aiEnrichmentEnabled: false }), false);
  assert.equal(canSendToAiProvider({ ...enabledCloud, aiLocalOnly: true }), false);
  assert.equal(canSendToAiProvider({ ...enabledCloud, aiConsentVersion: "older" }), false);
  assert.equal(canSendToAiProvider({ ...enabledCloud, aiConsentProvider: "different provider" }), false);
  assert.equal(canSendToAiProvider({ ...enabledCloud, aiConsentAt: null }), false);
  assert.equal(canSendToAiProvider(enabledCloud), true);
  assert.equal(hasCurrentAiConsent(enabledCloud), true);
  assert.match(aiProviderBlockedReason({ ...enabledCloud, aiConsentVersion: "older" }), /current consent/i);
  assert.match(aiProviderBlockedReason({ ...enabledCloud, aiEnrichmentEnabled: false }), /disabled/i);
  assert.match(aiProviderBlockedReason({ ...enabledCloud, aiLocalOnly: true }), /local-only/i);
});