export const HEALTH_CLEANUP_ACTIONS = [
  "orphanedRecords",
  "orphanedDerivedData",
  "orphanedThumbnails",
  "missingThumbnails",
  "emptyFolders",
  "rebuildMetadata",
  "fullThumbnailRebuild",
] as const;

export type HealthCleanupAction = typeof HEALTH_CLEANUP_ACTIONS[number];

export type ParsedHealthCleanupActions =
  | { ok: true; actions: HealthCleanupAction[] }
  | { ok: false; error: string };

const allowed = new Set<string>(HEALTH_CLEANUP_ACTIONS);

export function parseHealthCleanupActions(value: unknown): ParsedHealthCleanupActions {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((action: unknown) => typeof action !== "string" || !allowed.has(action))
  ) {
    return {
      ok: false,
      error: "actions must be a non-empty array containing only supported cleanup actions",
    };
  }
  const actions = [...new Set(value as HealthCleanupAction[])];
  const requestsThumbnails = actions.includes("missingThumbnails") || actions.includes("fullThumbnailRebuild");
  if (requestsThumbnails && actions.includes("rebuildMetadata")) {
    return {
      ok: false,
      error: "Run thumbnail rebuilding or metadata refresh in separate cleanup tasks. Other selected maintenance actions can stay combined.",
    };
  }
  return { ok: true, actions };
}
