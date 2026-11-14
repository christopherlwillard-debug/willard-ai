import { getActiveAppSettings } from "./active-library.ts";

export const AI_CONSENT_VERSION = "2026-08-26.v1";
export const AI_PROVIDER_NAME = "OpenAI via the configured Replit AI Integration";

export interface AiPrivacySettings {
  aiEnrichmentEnabled: boolean;
  aiLocalOnly: boolean;
  aiExcludedFolders: string[];
  aiExcludedExtensions: string[];
  aiConsentAt: Date | string | null;
  aiConsentProvider: string | null;
  aiConsentVersion: string | null;
}

const DEFAULTS: AiPrivacySettings = {
  aiEnrichmentEnabled: false,
  aiLocalOnly: true,
  aiExcludedFolders: [],
  aiExcludedExtensions: [],
  aiConsentAt: null,
  aiConsentProvider: null,
  aiConsentVersion: null,
};

function normalizeFolder(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "").toLowerCase();
}

function normalizeExtension(value: string): string {
  return value.trim().replace(/^\./, "").toLowerCase();
}

export function normalizeAiExclusions(settings: Pick<AiPrivacySettings, "aiExcludedFolders" | "aiExcludedExtensions">) {
  return {
    folders: [...new Set(settings.aiExcludedFolders.map(normalizeFolder).filter(Boolean))],
    extensions: [...new Set(settings.aiExcludedExtensions.map(normalizeExtension).filter(Boolean))],
  };
}

export function isMediaExcluded(
  relativePath: string,
  name: string,
  settings: Pick<AiPrivacySettings, "aiExcludedFolders" | "aiExcludedExtensions">,
): boolean {
  const exclusions = normalizeAiExclusions(settings);
  const normalizedPath = relativePath.replaceAll("\\", "/").replace(/^\/+/, "").toLowerCase();
  const normalizedName = name.toLowerCase();
  const extension = normalizedName.includes(".")
    ? normalizedName.slice(normalizedName.lastIndexOf(".") + 1)
    : "";

  return exclusions.folders.some((folder) =>
    normalizedPath === folder || normalizedPath.startsWith(`${folder}/`),
  ) || exclusions.extensions.includes(extension);
}

export function hasCurrentAiConsent(
  settings: Pick<AiPrivacySettings, "aiConsentAt" | "aiConsentProvider" | "aiConsentVersion">,
): boolean {
  if (
    !settings.aiConsentAt ||
    settings.aiConsentProvider !== AI_PROVIDER_NAME ||
    settings.aiConsentVersion !== AI_CONSENT_VERSION
  ) {
    return false;
  }
  const consentTime = settings.aiConsentAt instanceof Date
    ? settings.aiConsentAt.getTime()
    : Date.parse(settings.aiConsentAt);
  return Number.isFinite(consentTime) && consentTime > 0 && consentTime <= Date.now() + 5 * 60 * 1000;
}

type AiProviderGateSettings = Pick<
  AiPrivacySettings,
  "aiEnrichmentEnabled" | "aiLocalOnly" | "aiConsentAt" | "aiConsentProvider" | "aiConsentVersion"
>;

export function canSendToAiProvider(settings: AiProviderGateSettings): boolean {
  return settings.aiEnrichmentEnabled && !settings.aiLocalOnly && hasCurrentAiConsent(settings);
}

export function aiProviderBlockedReason(settings: AiProviderGateSettings): string {
  if (!settings.aiEnrichmentEnabled) return "AI features are disabled. Enable AI in Settings before sending media or library data to the provider.";
  if (settings.aiLocalOnly) return "AI is set to local-only mode. Turn off local-only mode in Settings before using the cloud provider.";
  if (!hasCurrentAiConsent(settings)) return "Cloud AI needs current consent for this provider and disclosure version. Review and confirm the current AI disclosure in Settings.";
  return "";
}

export async function getAiPrivacySettings(): Promise<AiPrivacySettings> {
  const settings = await getActiveAppSettings();
  const row = settings ? {
    aiEnrichmentEnabled: settings.aiEnrichmentEnabled,
    aiLocalOnly: settings.aiLocalOnly,
    aiExcludedFolders: settings.aiExcludedFolders,
    aiExcludedExtensions: settings.aiExcludedExtensions,
    aiConsentAt: settings.aiConsentAt,
    aiConsentProvider: settings.aiConsentProvider,
    aiConsentVersion: settings.aiConsentVersion,
  } : null;

  return {
    ...DEFAULTS,
    ...row,
    aiExcludedFolders: row?.aiExcludedFolders ?? [],
    aiExcludedExtensions: row?.aiExcludedExtensions ?? [],
  };
}