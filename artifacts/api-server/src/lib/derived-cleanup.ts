import * as fs from "node:fs";
import * as path from "node:path";
import { pool } from "@workspace/db";
import { isVectorAvailable } from "./vector-capability.ts";
import { getWillardAIDir, resolveWithinRoot } from "./nas-storage.ts";

type QueryResult<T = Record<string, unknown>> = {
  rows: T[];
  rowCount?: number | null;
};

export type DerivedCleanupReport = {
  mediaIds: number[];
  mediaAiRows: number;
  faceRows: number;
  faceScanStateRows: number;
  peopleRows: number;
  cropsRemoved: number;
  cropErrors: string[];
  orphanRows: number;
  staleCropsRemoved: number;
};

type CleanupContext = {
  cropPaths: Set<string>;
  personIds: Set<number>;
  mediaIds: Set<number>;
};

type CleanupClient = {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
  release(): void;
};

function rowCount(result: QueryResult): number {
  return typeof result.rowCount === "number" ? result.rowCount : result.rows.length;
}

function emptyReport(): DerivedCleanupReport {
  return {
    mediaIds: [],
    mediaAiRows: 0,
    faceRows: 0,
    faceScanStateRows: 0,
    peopleRows: 0,
    cropsRemoved: 0,
    cropErrors: [],
    orphanRows: 0,
    staleCropsRemoved: 0,
  };
}

function createContext(): CleanupContext {
  return { cropPaths: new Set(), personIds: new Set(), mediaIds: new Set() };
}

function cropRoot(nasPath: string): string {
  return path.join(getWillardAIDir(nasPath), "cache", "faces");
}

function collectCrop(context: CleanupContext, nasPath: string, cropPath: unknown): void {
  if (typeof cropPath !== "string" || !cropPath) return;
  try {
    context.cropPaths.add(resolveWithinRoot(cropPath, getWillardAIDir(nasPath)));
  } catch {
    // A poisoned path is never removed. The row is still safe to delete.
  }
}

function collectPerson(context: CleanupContext, personId: unknown): void {
  const id = Number(personId);
  if (Number.isInteger(id) && id > 0) context.personIds.add(id);
}

async function refreshPeople(
  client: CleanupClient,
  nasPath: string,
  context: CleanupContext,
): Promise<number> {
  if (context.personIds.size === 0) return 0;
  const ids = [...context.personIds];

  if (isVectorAvailable()) {
    await client.query(
      `UPDATE people p
          SET centroid = (
                SELECT avg(fc.embedding)
                  FROM faces fc
                  JOIN media_files mf ON mf.id = fc.media_file_id
                   AND mf.nas_path = $2
                   AND (mf.last_scan_action IS NULL OR mf.last_scan_action NOT IN ('DELETED', 'RECYCLED'))
                 WHERE fc.person_id = p.id AND fc.embedding IS NOT NULL
              ),
              face_count = (
                SELECT count(*)
                  FROM faces fc
                  JOIN media_files mf ON mf.id = fc.media_file_id
                   AND mf.nas_path = $2
                   AND (mf.last_scan_action IS NULL OR mf.last_scan_action NOT IN ('DELETED', 'RECYCLED'))
                 WHERE fc.person_id = p.id
              )
        WHERE p.id = ANY($1::int[]) AND p.nas_path = $2`,
      [ids, nasPath],
    );
  } else {
    await client.query(
      `UPDATE people p
          SET face_count = (
            SELECT count(*)
              FROM faces fc
              JOIN media_files mf ON mf.id = fc.media_file_id
               AND mf.nas_path = $2
               AND (mf.last_scan_action IS NULL OR mf.last_scan_action NOT IN ('DELETED', 'RECYCLED'))
             WHERE fc.person_id = p.id
          )
        WHERE p.id = ANY($1::int[]) AND p.nas_path = $2`,
      [ids, nasPath],
    );
  }

  await client.query(
    `UPDATE people p
        SET cover_face_id = (
          SELECT fc.id
            FROM faces fc
            JOIN media_files mf ON mf.id = fc.media_file_id
             AND mf.nas_path = $2
             AND (mf.last_scan_action IS NULL OR mf.last_scan_action NOT IN ('DELETED', 'RECYCLED'))
           WHERE fc.person_id = p.id
           ORDER BY fc.score DESC, fc.id DESC
           LIMIT 1
        )
      WHERE p.id = ANY($1::int[]) AND p.nas_path = $2
        AND (p.cover_face_id IS NULL OR NOT EXISTS (
          SELECT 1
            FROM faces fc
            JOIN media_files mf ON mf.id = fc.media_file_id
             AND mf.nas_path = $2
             AND (mf.last_scan_action IS NULL OR mf.last_scan_action NOT IN ('DELETED', 'RECYCLED'))
           WHERE fc.id = p.cover_face_id AND fc.person_id = p.id
        ))`,
    [ids, nasPath],
  );

  const deleted = await client.query(
    `DELETE FROM people
      WHERE id = ANY($1::int[]) AND nas_path = $2 AND face_count = 0`,
    [ids, nasPath],
  );
  return rowCount(deleted);
}

async function purgeMediaRows(
  client: CleanupClient,
  nasPath: string,
  mediaFileIds: number[],
  context: CleanupContext,
): Promise<DerivedCleanupReport> {
  const report = emptyReport();
  const ids = [...new Set(mediaFileIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return report;

  const faces = await client.query<{ crop_path: string | null; person_id: number | null; media_file_id: number }>(
    `SELECT fc.crop_path, fc.person_id, fc.media_file_id
       FROM faces fc
       JOIN media_files mf ON mf.id = fc.media_file_id
      WHERE fc.media_file_id = ANY($1::int[]) AND mf.nas_path = $2`,
    [ids, nasPath],
  );
  for (const face of faces.rows) {
    collectCrop(context, nasPath, face.crop_path);
    collectPerson(context, face.person_id);
    context.mediaIds.add(Number(face.media_file_id));
  }

  const ai = await client.query(
    `DELETE FROM media_ai ma
       USING media_files mf
      WHERE ma.media_file_id = ANY($1::int[])
        AND mf.id = ma.media_file_id AND mf.nas_path = $2`,
    [ids, nasPath],
  );
  const deletedFaces = await client.query(
    `DELETE FROM faces fc
       USING media_files mf
      WHERE fc.media_file_id = ANY($1::int[])
        AND mf.id = fc.media_file_id AND mf.nas_path = $2`,
    [ids, nasPath],
  );
  const scanState = await client.query(
    `DELETE FROM face_scan_state s
      WHERE s.media_file_id = ANY($1::int[])
        AND EXISTS (
          SELECT 1 FROM media_files mf
           WHERE mf.id = s.media_file_id AND mf.nas_path = $2
        )`,
    [ids, nasPath],
  );

  report.mediaIds = ids;
  report.mediaAiRows = rowCount(ai);
  report.faceRows = rowCount(deletedFaces);
  report.faceScanStateRows = rowCount(scanState);
  report.peopleRows = await refreshPeople(client, nasPath, context);
  return report;
}

async function removeCollectedCrops(nasPath: string, context: CleanupContext): Promise<{ removed: number; errors: string[] }> {
  let removed = 0;
  const errors: string[] = [];
  for (const cropPath of context.cropPaths) {
    try {
      const safePath = resolveWithinRoot(cropPath, getWillardAIDir(nasPath));
      if (!fs.existsSync(safePath)) continue;
      fs.unlinkSync(safePath);
      removed++;
    } catch (error) {
      errors.push(`${cropPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { removed, errors };
}

async function finishReport(
  nasPath: string,
  context: CleanupContext,
  report: DerivedCleanupReport,
): Promise<DerivedCleanupReport> {
  const crops = await removeCollectedCrops(nasPath, context);
  report.cropsRemoved += crops.removed;
  report.cropErrors.push(...crops.errors);
  return report;
}

/**
 * Purge all derived data for canonical media rows in one database transaction.
 * The canonical rows are deliberately not deleted here: callers choose whether
 * the row becomes RECYCLED, DELETED, or is permanently removed.
 */
export async function purgeDerivedDataForMedia(
  nasPath: string,
  mediaFileIds: number[],
): Promise<DerivedCleanupReport> {
  const client = await pool.connect() as unknown as CleanupClient;
  const context = createContext();
  try {
    await client.query("BEGIN");
    const report = await purgeMediaRows(client, nasPath, mediaFileIds, context);
    await client.query("COMMIT");
    return await finishReport(nasPath, context, report);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Repair derived rows whose canonical media row has gone away. This is global
 * only for genuinely orphaned rows; rows belonging to another NAS remain
 * untouched. Stale face crops are limited to this NAS's face-cache directory.
 */
export async function purgeOrphanedDerivedData(nasPath: string): Promise<DerivedCleanupReport> {
  const client = await pool.connect() as unknown as CleanupClient;
  const context = createContext();
  const report = emptyReport();
  try {
    await client.query("BEGIN");
    const orphanFaces = await client.query<{ crop_path: string | null; person_id: number | null }>(
      `SELECT fc.crop_path, fc.person_id
         FROM faces fc
        WHERE NOT EXISTS (SELECT 1 FROM media_files mf WHERE mf.id = fc.media_file_id)`,
    );
    for (const face of orphanFaces.rows) {
      collectCrop(context, nasPath, face.crop_path);
      collectPerson(context, face.person_id);
    }
    const orphanAi = await client.query(
      `DELETE FROM media_ai ma
        WHERE NOT EXISTS (SELECT 1 FROM media_files mf WHERE mf.id = ma.media_file_id)`,
    );
    const deletedFaces = await client.query(
      `DELETE FROM faces fc
        WHERE NOT EXISTS (SELECT 1 FROM media_files mf WHERE mf.id = fc.media_file_id)`,
    );
    const orphanState = await client.query(
      `DELETE FROM face_scan_state s
        WHERE NOT EXISTS (SELECT 1 FROM media_files mf WHERE mf.id = s.media_file_id)`,
    );
    report.mediaAiRows = rowCount(orphanAi);
    report.faceRows = rowCount(deletedFaces);
    report.faceScanStateRows = rowCount(orphanState);
    report.orphanRows = report.mediaAiRows + report.faceRows + report.faceScanStateRows;
    const people = await client.query<{ id: number }>(
      `SELECT id
         FROM people
        WHERE nas_path = $1
          AND (face_count > 0 OR NOT EXISTS (
            SELECT 1 FROM faces fc
             WHERE fc.person_id = people.id
          ))`,
      [nasPath],
    );
    for (const person of people.rows) collectPerson(context, person.id);
    report.peopleRows = await refreshPeople(client, nasPath, context);

    const referenced = await client.query<{ crop_path: string | null }>(
      `SELECT fc.crop_path
         FROM faces fc
         JOIN media_files mf ON mf.id = fc.media_file_id
        WHERE mf.nas_path = $1 AND fc.crop_path IS NOT NULL`,
      [nasPath],
    );
    const referencedCrops = new Set<string>();
    for (const row of referenced.rows) {
      try { if (row.crop_path) referencedCrops.add(resolveWithinRoot(row.crop_path, getWillardAIDir(nasPath))); } catch {}
    }
    await client.query("COMMIT");

    const root = cropRoot(nasPath);
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".webp") continue;
        const candidate = resolveWithinRoot(path.join(root, entry.name), getWillardAIDir(nasPath));
        if (referencedCrops.has(candidate)) continue;
        try { fs.unlinkSync(candidate); report.staleCropsRemoved++; } catch (error) {
          report.cropErrors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch {
      // The face cache may not exist yet; that is already a clean state.
    }
    return await finishReport(nasPath, context, report);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}