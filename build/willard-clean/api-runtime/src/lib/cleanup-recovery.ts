import * as fs from "fs";
import * as path from "path";
import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { resolveWithinRoot } from "./nas-storage";

type PendingOperation = {
  operationId: string;
  nasPath: string;
  mediaFileId: number;
  sourcePath: string;
  trashPath: string | null;
  sizeBytes: number;
  status: string;
};

function manifestPath(nasPath: string): string {
  return path.join(nasPath, "WillardAI", "logs", "trash-manifest.jsonl");
}

/**
 * Reconcile only filesystem states that prove what happened. This is safe to
 * run repeatedly after every restart; it never removes an unknown file.
 */
export async function reconcileCleanupOperations(): Promise<void> {
  const [settings] = await db.select({ nasPath: appSettingsTable.nasPath })
    .from(appSettingsTable).limit(1);
  const nasPath = settings?.nasPath?.trim();
  if (!nasPath) return;

  const result = await db.execute(sql`
    SELECT operation_id AS "operationId", nas_path AS "nasPath",
           media_file_id AS "mediaFileId", source_path AS "sourcePath",
           trash_path AS "trashPath", size_bytes AS "sizeBytes", status
    FROM cleanup_operations
    WHERE nas_path = ${nasPath}
      AND operation_type = 'CLEANUP'
      AND status NOT IN ('RECORDED', 'FAILED', 'CONFLICT', 'NEEDS_REVIEW')
  `);

  for (const op of result.rows as unknown as PendingOperation[]) {
    try {
      const source = resolveWithinRoot(op.sourcePath, nasPath);
      const trash = op.trashPath
        ? resolveWithinRoot(op.trashPath, path.join(nasPath, "WillardAI", ".Trash"))
        : null;
      const sourceExists = fs.existsSync(source);
      const trashExists = Boolean(trash && fs.existsSync(trash));

      if (sourceExists && !trashExists) {
        await db.execute(sql`
          UPDATE cleanup_operations SET status = 'FAILED',
            error = 'Filesystem move did not complete; source remains present',
            updated_at = NOW() WHERE operation_id = ${op.operationId}
        `);
        continue;
      }
      if (sourceExists && trashExists) {
        await db.execute(sql`
          UPDATE cleanup_operations SET status = 'CONFLICT',
            error = 'Both source and trash paths exist; no automatic move performed',
            updated_at = NOW() WHERE operation_id = ${op.operationId}
        `);
        continue;
      }
      if (!trashExists) {
        await db.execute(sql`
          UPDATE cleanup_operations SET status = 'NEEDS_REVIEW',
            error = 'Neither source nor trash path exists; no file was deleted by recovery',
            updated_at = NOW() WHERE operation_id = ${op.operationId}
        `);
        continue;
      }

      const logPath = manifestPath(nasPath);
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      const existing = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
      if (!existing.split("\n").some((line) => {
        try { return JSON.parse(line).trashPath === trash; } catch { return false; }
      })) {
        fs.appendFileSync(logPath, JSON.stringify({
          ts: new Date().toISOString(),
          originalPath: source,
          trashPath: trash,
          sizeBytes: Number(op.sizeBytes ?? 0),
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          recoveredByStartup: true,
        }) + "\n");
      }
      await db.execute(sql`
        UPDATE media_files SET last_scan_action = 'RECYCLED'
        WHERE id = ${op.mediaFileId} AND nas_path = ${nasPath}
      `);
      await db.execute(sql`
        UPDATE cleanup_operations SET status = 'RECORDED',
          error = NULL, updated_at = NOW() WHERE operation_id = ${op.operationId}
      `);
    } catch (error) {
      await db.execute(sql`
        UPDATE cleanup_operations SET status = 'NEEDS_REVIEW',
          error = ${error instanceof Error ? error.message : "Unable to validate recovery paths"},
          updated_at = NOW() WHERE operation_id = ${op.operationId}
      `);
    }
  }
}