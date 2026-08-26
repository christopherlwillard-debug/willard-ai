import { db, appSettingsTable } from "@workspace/db";

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

export function canSendToAiProvider(settings: Pick<AiPrivacySettings, "aiEnrichmentEnabled" | "aiLocalOnly">): boolean {
  return settings.aiEnrichmentEnabled && !settings.aiLocalOnly;
}

export function aiProviderBlockedReason(settings: Pick<AiPrivacySettings, "aiEnrichmentEnabled" | "aiLocalOnly">): string {
  if (!settings.aiEnrichmentEnabled) return "AI features are disabled. Enable AI in Settings before sending media or library data to the provider.";
  if (settings.aiLocalOnly) return "AI is set to local-only mode. Turn off local-only mode in Settings before using the cloud provider.";
  return "";
}

export async function getAiPrivacySettings(): Promise<AiPrivacySettings> {
  const [row] = await db.select({
    aiEnrichmentEnabled: appSettingsTable.aiEnrichmentEnabled,
    aiLocalOnly: appSettingsTable.aiLocalOnly,
    aiExcludedFolders: appSettingsTable.aiExcludedFolders,
    aiExcludedExtensions: appSettingsTable.aiExcludedExtensions,
    aiConsentAt: appSettingsTable.aiConsentAt,
    aiConsentProvider: appSettingsTable.aiConsentProvider,
    aiConsentVersion: appSettingsTable.aiConsentVersion,
  }).from(appSettingsTable).limit(1);

  return {
    ...DEFAULTS,
    ...row,
    aiExcludedFolders: row?.aiExcludedFolders ?? [],
    aiExcludedExtensions: row?.aiExcludedExtensions ?? [],
  };
}