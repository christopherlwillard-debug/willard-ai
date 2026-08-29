import { db, mediaFilesTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { activeMediaCondition, activeMediaSql } from "./media-scope.ts";

export type DuplicateSummary = {
  confirmedGroups: number;
  confirmedWastedBytes: number;
  unconfirmedCandidates: number;
  unconfirmedWastedBytes: number;
};

export async function getDuplicateSummary(nasPath: string): Promise<DuplicateSummary> {
  const [confirmedResult, candidateResult] = await Promise.all([
    db.execute(sql`
      SELECT COUNT(*) AS groups, COALESCE(SUM(t.wasted), 0) AS wasted FROM (
        SELECT (COUNT(*) - 1) * MAX(size_bytes) AS wasted
        FROM ${mediaFilesTable}
        WHERE nas_path = ${nasPath}
          AND content_hash IS NOT NULL
          AND ${activeMediaCondition}
        GROUP BY content_hash
        HAVING COUNT(*) > 1
      ) t
    `),
    db.execute(sql`
      SELECT COUNT(*) AS groups, COALESCE(SUM(t.wasted), 0) AS wasted FROM (
        SELECT (COUNT(*) - 1) * MAX(m.size_bytes) AS wasted
        FROM ${mediaFilesTable} m
        WHERE m.nas_path = ${nasPath}
          AND m.quick_fingerprint IS NOT NULL
          AND m.quick_fingerprint != ''
          AND ${sql.raw(activeMediaSql("m"))}
        GROUP BY m.quick_fingerprint
        HAVING COUNT(*) > 1
          AND NOT (
            COUNT(m.content_hash) = COUNT(*)
            AND COUNT(DISTINCT m.content_hash) = 1
          )
      ) t
    `),
  ]);

  const confirmed = confirmedResult.rows[0] as { groups?: string | number; wasted?: string | number } | undefined;
  const candidates = candidateResult.rows[0] as { groups?: string | number; wasted?: string | number } | undefined;
  return {
    confirmedGroups: Number(confirmed?.groups ?? 0),
    confirmedWastedBytes: Number(confirmed?.wasted ?? 0),
    unconfirmedCandidates: Number(candidates?.groups ?? 0),
    unconfirmedWastedBytes: Number(candidates?.wasted ?? 0),
  };
}