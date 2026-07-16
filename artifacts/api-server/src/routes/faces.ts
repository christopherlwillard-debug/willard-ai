import * as fs from "fs";
import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { getFaceStatus, refreshPerson } from "../lib/face-recognition";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const NOT_DELETED = `(f.last_scan_action IS NULL OR f.last_scan_action <> 'DELETED')`;

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
  try {
    const namedOnly = String(req.query.namedOnly ?? "") === "true";
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.face_count, p.cover_face_id, p.created_at,
              (SELECT count(DISTINCT fc.media_file_id)
                 FROM faces fc
                 JOIN media_files f ON f.id = fc.media_file_id AND ${NOT_DELETED}
                WHERE fc.person_id = p.id) AS photo_count
         FROM people p
        WHERE p.hidden = false AND p.face_count > 0
          ${namedOnly ? "AND p.name IS NOT NULL" : ""}
        ORDER BY (p.name IS NULL), p.face_count DESC, p.id`,
    );
    const status = getFaceStatus();
    return res.json({ people: rows.map(personOut), status });
  } catch (err) {
    logger.error({ err }, "list people failed");
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
      `UPDATE people SET ${sets.join(", ")} WHERE id = $1
       RETURNING id, name, face_count, cover_face_id, created_at`,
      params,
    );
    if (!rows[0]) return res.status(404).json({ error: "Person not found" });
    return res.json({ ok: true, person: personOut(rows[0]) });
  } catch (err) {
    logger.error({ err }, "rename person failed");
    return res.status(500).json({ error: "Failed to update person" });
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
    const { rows } = await pool.query(`SELECT id FROM people WHERE id = ANY($1::int[])`, [[id, fromId]]);
    if (rows.length !== 2) return res.status(404).json({ error: "Person not found" });
    await pool.query(`UPDATE faces SET person_id = $1 WHERE person_id = $2`, [id, fromId]);
    await pool.query(`DELETE FROM people WHERE id = $1`, [fromId]);
    await refreshPerson(id);
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
    const { rows: pRows } = await pool.query(
      `SELECT id, name, face_count, cover_face_id, created_at FROM people WHERE id = $1`, [id]);
    if (!pRows[0]) return res.status(404).json({ error: "Person not found" });

    const { rows } = await pool.query(
      `SELECT DISTINCT ON (f.id)
              f.id, f.name, f.relative_path, f.media_type, f.size_bytes,
              f.date_taken, f.favorite, f.duration_seconds, fc.id AS face_id
         FROM faces fc
         JOIN media_files f ON f.id = fc.media_file_id AND ${NOT_DELETED}
        WHERE fc.person_id = $1
        ORDER BY f.id, fc.score DESC`,
      [id],
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
    const { rows } = await pool.query(`SELECT crop_path FROM faces WHERE id = $1`, [faceId]);
    const cropPath = rows[0]?.crop_path;
    if (!cropPath || !fs.existsSync(cropPath)) return res.status(404).json({ error: "Crop not found" });
    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Cache-Control", "private, max-age=86400");
    return fs.createReadStream(cropPath).pipe(res);
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
    const { rows } = await pool.query(
      `SELECT fc.id, fc.person_id, fc.box_x, fc.box_y, fc.box_w, fc.box_h, fc.score,
              (fc.crop_path IS NOT NULL) AS has_crop, p.name AS person_name
         FROM faces fc
         LEFT JOIN people p ON p.id = fc.person_id
        WHERE fc.media_file_id = $1
        ORDER BY fc.score DESC`,
      [id],
    );
    const { rows: state } = await pool.query(
      `SELECT scanned_at FROM face_scan_state WHERE media_file_id = $1`, [id]);
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
