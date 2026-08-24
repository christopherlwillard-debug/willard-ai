import * as fs from "fs";
import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { getFaceStatus, refreshPerson } from "../lib/face-recognition";
import { logger } from "../lib/logger";
import { getWillardAIDir, resolveWithinRoot } from "../lib/nas-storage";

const router: IRouter = Router();

const NOT_DELETED = `(f.last_scan_action IS NULL OR f.last_scan_action NOT IN ('DELETED', 'RECYCLED'))`;

async function getNasPath(): Promise<string | null> {
  const { rows } = await pool.query(`SELECT nas_path FROM app_settings LIMIT 1`);
  return rows[0]?.nas_path?.trim() || null;
}

function personOut(r: any) {
  return {
    id: Number(r.id),
    name: r.name ?? null,
    faceCount: Number(r.face_count),
    photoCount: Number(r.photo_count ?? 0),
    coverFaceId: r.cover_face_id != null ? Number(r.cover_face_id) : null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  };
}

// ── People (clusters) ─────────────────────────────────────────────────────────

router.get("/faces/people", async (req: Request, res: Response) => {
  const _t0 = Date.now();
  try {
    const namedOnly = String(req.query.namedOnly ?? "") === "true";
    const nasPath = await getNasPath();
    if (!nasPath) return res.json({ people: [], status: getFaceStatus() });
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.face_count, p.cover_face_id, p.created_at,
              (SELECT count(DISTINCT fc.media_file_id)
                 FROM faces fc
                 JOIN media_files f ON f.id = fc.media_file_id AND ${NOT_DELETED}
                 WHERE fc.person_id = p.id AND f.nas_path = $1) AS photo_count
         FROM people p
        WHERE p.hidden = false AND p.face_count > 0
          AND p.nas_path = $1
          AND EXISTS (
            SELECT 1 FROM faces fc JOIN media_files f ON f.id = fc.media_file_id
             WHERE fc.person_id = p.id AND f.nas_path = $1 AND ${NOT_DELETED}
          )
          ${namedOnly ? "AND p.name IS NOT NULL" : ""}
        ORDER BY (p.name IS NULL), p.face_count DESC, p.id`,
      [nasPath],
    );
    const status = getFaceStatus();
    return res.json({ people: rows.map(personOut), status });
  } catch (err: any) {
    logger.error({
      err,
      errCode: err?.code,
      queryContext: "people/list",
      elapsedMs: Date.now() - _t0,
      requestUrl: req.originalUrl,
    }, "list people failed");
    return res.status(500).json({ error: "Failed to load people" });
  }
});

router.patch("/faces/people/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
    const body = req.body ?? {};
    const hasName = typeof body.name === "string" || body.name === null;
    const hasHidden = typeof body.hidden === "boolean";
    if (!hasName && !hasHidden) return res.status(400).json({ error: "Nothing to update" });
    const nasPath = await getNasPath();
    if (!nasPath) return res.status(404).json({ error: "Person not found" });

    const sets: string[] = [];
    const params: unknown[] = [id];
    if (hasName) {
      const name = body.name === null ? null : String(body.name).trim().slice(0, 80) || null;
      params.push(name);
      sets.push(`name = $${params.length}`);
    }
    if (hasHidden) {
      params.push(body.hidden);
      sets.push(`hidden = $${params.length}`);
    }
    const { rows } = await pool.query(
       `UPDATE people SET ${sets.join(", ")} WHERE id = $1 AND nas_path = $${params.length + 1}
       RETURNING id, name, face_count, cover_face_id, created_at`,
       [...params, nasPath],
    );
    if (!rows[0]) return res.status(404).json({ error: "Person not found" });
    return res.json({ ok: true, person: personOut(rows[0]) });
  } catch (err) {
    logger.error({ err }, "rename person failed");
    return res.status(500).json({ error: "Failed to update person" });
  }
});

// Move one detected face to an existing person or a new named person.
router.post("/faces/:faceId/reassign", async (req: Request, res: Response) => {
  try {
    const faceId = Number(req.params.faceId);
    if (!Number.isInteger(faceId) || faceId <= 0) {
      return res.status(400).json({ error: "Invalid face id" });
    }

    const targetId = req.body?.personId == null ? null : Number(req.body.personId);
    const newName = typeof req.body?.newPersonName === "string"
      ? req.body.newPersonName.trim().slice(0, 80)
      : "";
    if ((targetId == null || !Number.isInteger(targetId) || targetId <= 0) && !newName) {
      return res.status(400).json({ error: "Choose an existing person or enter a new person name" });
    }
    if (targetId != null && (!Number.isInteger(targetId) || targetId <= 0)) {
      return res.status(400).json({ error: "Invalid target person id" });
    }
    if (targetId != null && newName) {
      return res.status(400).json({ error: "Choose one reassignment target" });
    }

    const nasPath = await getNasPath();
    if (!nasPath) return res.status(404).json({ error: "Face not found" });

    const { rows: faceRows } = await pool.query(
      `SELECT fc.id, fc.person_id, fc.embedding
         FROM faces fc
         JOIN media_files mf ON mf.id = fc.media_file_id
        WHERE fc.id = $1 AND mf.nas_path = $2 AND ${NOT_DELETED}`,
      [faceId, nasPath],
    );
    const face = faceRows[0];
    if (!face) return res.status(404).json({ error: "Face not found" });

    let nextPersonId = targetId;
    if (newName) {
      const { rows } = await pool.query(
        `INSERT INTO people (nas_path, name, face_count, centroid)
         VALUES ($1, $2, 0, $3::vector)
         RETURNING id`,
        [nasPath, newName, face.embedding ?? null],
      );
      nextPersonId = Number(rows[0].id);
    } else {
      const { rows } = await pool.query(
        `SELECT id FROM people WHERE id = $1 AND nas_path = $2`,
        [nextPersonId, nasPath],
      );
      if (!rows[0]) return res.status(404).json({ error: "Target person not found" });
    }

    const previousPersonId = face.person_id == null ? null : Number(face.person_id);
    if (previousPersonId === nextPersonId) {
      return res.json({ ok: true, personId: nextPersonId, previousPersonId });
    }

    await pool.query(
      `UPDATE faces SET person_id = $1, manual_assignment = true WHERE id = $2`,
      [nextPersonId, faceId],
    );
    if (previousPersonId != null) await refreshPerson(nasPath, previousPersonId);
    await refreshPerson(nasPath, nextPersonId!);
    return res.json({ ok: true, personId: nextPersonId, previousPersonId });
  } catch (err) {
    logger.error({ err }, "reassign face failed");
    return res.status(500).json({ error: "Failed to reassign face" });
  }
});

// Merge person B into person A (same real-world identity split by the clusterer).
router.post("/faces/people/:id/merge", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const fromId = Number(req.body?.fromPersonId);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(fromId) || fromId <= 0 || fromId === id) {
      return res.status(400).json({ error: "Invalid person ids" });
    }
    const nasPath = await getNasPath();
    if (!nasPath) return res.status(404).json({ error: "Person not found" });
    const { rows } = await pool.query(`SELECT id FROM people WHERE id = ANY($1::int[]) AND nas_path = $2`, [[id, fromId], nasPath]);
    if (rows.length !== 2) return res.status(404).json({ error: "Person not found" });
    await pool.query(
      `UPDATE faces fc SET person_id = $1
        FROM media_files mf
       WHERE fc.media_file_id = mf.id AND mf.nas_path = $3 AND fc.person_id = $2`,
      [id, fromId, nasPath],
    );
    await pool.query(`DELETE FROM people WHERE id = $1 AND nas_path = $2`, [fromId, nasPath]);
    await refreshPerson(nasPath, id);
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "merge people failed");
    return res.status(500).json({ error: "Failed to merge people" });
  }
});

// Files a person appears in.
router.get("/faces/people/:id/files", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
    const nasPath = await getNasPath();
    if (!nasPath) return res.status(404).json({ error: "Person not found" });
    const { rows: pRows } = await pool.query(
      `SELECT id, name, face_count, cover_face_id, created_at FROM people WHERE id = $1 AND nas_path = $2`, [id, nasPath]);
    if (!pRows[0]) return res.status(404).json({ error: "Person not found" });

    const { rows } = await pool.query(
      `SELECT DISTINCT ON (f.id)
              f.id, f.name, f.relative_path, f.media_type, f.size_bytes,
              f.date_taken, f.favorite, f.duration_seconds, fc.id AS face_id
         FROM faces fc
         JOIN media_files f ON f.id = fc.media_file_id AND ${NOT_DELETED}
         WHERE fc.person_id = $1 AND f.nas_path = $2
        ORDER BY f.id, fc.score DESC`,
      [id, nasPath],
    );
    rows.sort((a: any, b: any) => new Date(b.date_taken ?? 0).getTime() - new Date(a.date_taken ?? 0).getTime());
    return res.json({
      person: personOut(pRows[0]),
      items: rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        relativePath: r.relative_path,
        mediaType: r.media_type,
        sizeBytes: Number(r.size_bytes),
        dateTaken: r.date_taken ? new Date(r.date_taken).toISOString() : null,
        favorite: r.favorite,
        durationSeconds: r.duration_seconds != null ? Number(r.duration_seconds) : null,
        faceId: Number(r.face_id),
      })),
    });
  } catch (err) {
    logger.error({ err }, "person files failed");
    return res.status(500).json({ error: "Failed to load person files" });
  }
});

// ── Face crop image (served from the local cache dir, never a raw path from the client) ──

router.get("/faces/:faceId/crop", async (req: Request, res: Response) => {
  try {
    const faceId = Number(req.params.faceId);
    if (!Number.isInteger(faceId) || faceId <= 0) return res.status(400).json({ error: "Invalid id" });
    const nasPath = await getNasPath();
    if (!nasPath) return res.status(404).json({ error: "Crop not found" });
    const { rows } = await pool.query(
      `SELECT fc.crop_path
         FROM faces fc JOIN media_files f ON f.id = fc.media_file_id
        WHERE fc.id = $1 AND f.nas_path = $2 AND ${NOT_DELETED}`,
      [faceId, nasPath],
    );
    const cropPath = rows[0]?.crop_path;
    let safeCropPath: string;
    try { safeCropPath = resolveWithinRoot(cropPath, getWillardAIDir(nasPath)); }
    catch { return res.status(404).json({ error: "Crop not found" }); }
    if (!cropPath || !fs.existsSync(safeCropPath)) return res.status(404).json({ error: "Crop not found" });
    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Cache-Control", "private, max-age=86400");
    return fs.createReadStream(safeCropPath).pipe(res);
  } catch (err) {
    logger.error({ err }, "face crop failed");
    return res.status(500).json({ error: "Failed to load face crop" });
  }
});

// ── Faces detected in one media file ─────────────────────────────────────────

router.get("/media/files/:id/faces", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
    const nasPath = await getNasPath();
    if (!nasPath) return res.status(404).json({ error: "File not found" });
    const { rows } = await pool.query(
      `SELECT fc.id, fc.person_id, fc.box_x, fc.box_y, fc.box_w, fc.box_h, fc.score,
              (fc.crop_path IS NOT NULL) AS has_crop, p.name AS person_name
         FROM faces fc
          LEFT JOIN people p ON p.id = fc.person_id AND p.nas_path = $2
        JOIN media_files f ON f.id = fc.media_file_id
        WHERE fc.media_file_id = $1 AND f.nas_path = $2 AND ${NOT_DELETED}
        ORDER BY fc.score DESC`,
      [id, nasPath],
    );
    const { rows: state } = await pool.query(
      `SELECT scanned_at FROM face_scan_state s
         WHERE s.media_file_id = $1
           AND EXISTS (SELECT 1 FROM media_files f WHERE f.id = s.media_file_id AND f.nas_path = $2)`,
      [id, nasPath]);
    return res.json({
      scanned: !!state[0],
      faces: rows.map((r: any) => ({
        id: Number(r.id),
        personId: r.person_id != null ? Number(r.person_id) : null,
        personName: r.person_name ?? null,
        hasCrop: r.has_crop,
        score: Number(r.score),
        box: { x: Number(r.box_x), y: Number(r.box_y), w: Number(r.box_w), h: Number(r.box_h) },
      })),
    });
  } catch (err) {
    logger.error({ err }, "file faces failed");
    return res.status(500).json({ error: "Failed to load faces" });
  }
});

export default router;
