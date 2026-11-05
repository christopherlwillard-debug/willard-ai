import { and, sql, type SQL } from "drizzle-orm";

type AiExclusions = {
  aiExcludedFolders?: string[] | null;
  aiExcludedExtensions?: string[] | null;
};

function normalizeFolder(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\\/+|\\/+$/g, "").toLowerCase();
}

function normalizeExtension(value: string): string {
  return value.trim().replace(/^\\./, "").toLowerCase();
}

/**
 * SQL predicate that excludes the configured private folders and extensions
 * before any AI context is aggregated or serialized.
 */
export function buildAiMediaExclusionCondition(
  relativePathColumn: unknown,
  nameColumn: unknown,
  settings: AiExclusions | null | undefined,
): SQL {
  const folders = [...new Set((settings?.aiExcludedFolders ?? []).map(normalizeFolder).filter(Boolean))];
  const extensions = [...new Set((settings?.aiExcludedExtensions ?? []).map(normalizeExtension).filter(Boolean))];
  const conditions: SQL[] = [];

  for (const folder of folders) {
    const normalizedPath = sql`lower(replace(${relativePathColumn}, chr(92), '/'))`;
    conditions.push(sql`NOT (
      ${normalizedPath} = ${folder}
      OR left(${normalizedPath}, length(${folder}) + 1) = ${folder} || '/'
    )`);
  }

  for (const extension of extensions) {
    const suffix = `.${extension}`;
    conditions.push(sql`right(lower(${nameColumn}), length(${suffix})) <> ${suffix}`);
  }

  return conditions.length > 0 ? and(...conditions)! : sql`TRUE`;
}
