import { Router, type IRouter, type Request, type Response } from "express";
import { db, pool, appSettingsTable } from "@workspace/db";
import { findSimilar } from "../lib/ai-search";
import { recomputeEmbedding } from "../lib/ai-enrichment";
import { logger } from "../lib/logger";

const router: IRouter = Router();

async function getNasPath(): Promise<string | null> {
  const [row] = await db.select({ nasPath: appSettingsTable.nasPath }).from(appSettingsTable).limit(1);
  const p = row?.nasPath?.trim();
  return p ? p : null;
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

const ITEM_COLS = `f.id, f.name, f.relative_path, f.media_type, f.size_bytes,
  f.date_taken, f.favorite, f.duration_seconds`;

interface RelatedItem {
  id: number;
  name: string;
  relativePath: string;
  mediaType: string;
  sizeBytes: number;
  dateTaken: string | null;
  favorite: boolean;
  durationSeconds: number | null;
}

function toItem(r: any): RelatedItem {
  return {
    id: r.id,
    name: r.name,
    relativePath: r.relative_path,
    mediaType: r.media_type,
    sizeBytes: Number(r.size_bytes),
    dateTaken: r.date_taken ? new Date(r.date_taken).toISOString() : null,
    favorite: r.favorite,
    durationSeconds: r.duration_seconds != null ? Number(r.duration_seconds) : null,
  };
}

const NOT_DELETED = `(f.last_scan_action IS NULL OR f.last_scan_action <> 'DELETED')`;

// ── Full detail for one item ─────────────────────────────────────────────────

router.get("/media/files/:id/detail", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });

    const { rows } = await pool.query(
      `SELECT f.*, a.description AS ai_description, a.tags AS ai_tags, a.objects, a.ocr_text,
              a.doc_type, a.scene, a.people, a.user_tags, a.hidden_tags,
              a.user_description, a.notes, a.analyzed_at, a.ai_version,
              (a.embedding IS NOT NULL) AS has_embedding
         FROM media_files f
         LEFT JOIN media_ai a ON a.media_file_id = f.id
        WHERE f.id = $1`,
      [id],
    );
    const r = rows[0];
    if (!r || r.last_scan_action === "DELETED") return res.status(404).json({ error: "File not found" });

    // Collections this file belongs to (events, places, manual albums).
    const { rows: colls } = await pool.query(
      `SELECT c.id, c.name, c.kind, c.auto_key,
              (SELECT count(*) FROM collection_items ci2 WHERE ci2.collection_id = c.id) AS item_count
         FROM collection_items ci
         JOIN collections c ON c.id = ci.collection_id
        WHERE ci.media_file_id = $1 AND c.removed_at IS NULL`,
      [id],
    );

    // Timeline neighbors (prev/next by capture date within the library).
    const taken = r.date_taken ?? r.modified_at;
    let prev: RelatedItem | null = null;
    let next: RelatedItem | null = null;
    if (taken) {
      const [{ rows: p }, { rows: n }] = await Promise.all([
        pool.query(
          `SELECT ${ITEM_COLS} FROM media_files f
            WHERE f.nas_path = $1 AND ${NOT_DELETED} AND f.id <> $2
              AND COALESCE(f.date_taken, f.modified_at) < $3
            ORDER BY COALESCE(f.date_taken, f.modified_at) DESC LIMIT 1`,
          [r.nas_path, id, taken],
        ),
        pool.query(
          `SELECT ${ITEM_COLS} FROM media_files f
            WHERE f.nas_path = $1 AND ${NOT_DELETED} AND f.id <> $2
              AND COALESCE(f.date_taken, f.modified_at) > $3
            ORDER BY COALESCE(f.date_taken, f.modified_at) ASC LIMIT 1`,
          [r.nas_path, id, taken],
        ),
      ]);
      prev = p[0] ? toItem(p[0]) : null;
      next = n[0] ? toItem(n[0]) : null;
    }

    const hidden = new Set(strArr(r.hidden_tags).map((t) => t.toLowerCase()));
    const aiTags = strArr(r.ai_tags);

    return res.json({
      file: {
        id: r.id,
        name: r.name,
        relativePath: r.relative_path,
        extension: r.extension,
        mimeType: r.mime_type,
        mediaType: r.media_type,
        sizeBytes: Number(r.size_bytes),
        modifiedAt: r.modified_at ? new Date(r.modified_at).toISOString() : null,
        dateCreated: r.date_created ? new Date(r.date_created).toISOString() : null,
        favorite: r.favorite,
        width: r.width, height: r.height, orientation: r.orientation,
        durationSeconds: r.duration_seconds != null ? Number(r.duration_seconds) : null,
        dateTaken: r.date_taken ? new Date(r.date_taken).toISOString() : null,
        folder: String(r.relative_path).split("/").slice(0, -1).join("/") || "/",
        exif: {
          cameraMake: r.camera_make, cameraModel: r.camera_model, lens: r.lens,
          iso: r.iso, aperture: r.aperture, exposure: r.exposure,
          focalLength: r.focal_length, flash: r.flash,
        },
        gps: r.gps_latitude != null && r.gps_longitude != null
          ? { latitude: Number(r.gps_latitude), longitude: Number(r.gps_longitude), placeName: r.place_name ?? null }
          : null,
        video: r.video_codec || r.fps || r.audio_codec
          ? { videoCodec: r.video_codec, videoBitrate: r.video_bitrate, fps: r.fps, audioCodec: r.audio_codec }
          : null,
        pdf: r.page_count != null
          ? { pageCount: r.page_count, author: r.pdf_author, title: r.pdf_title, subject: r.pdf_subject, keywords: r.pdf_keywords }
          : null,
      },
      ai: r.analyzed_at ? {
        analyzed: true,
        analyzedAt: new Date(r.analyzed_at).toISOString(),
        // Effective view (what the item "means" today)…
        description: r.user_description ?? r.ai_description,
        descriptionEdited: r.user_description != null,
        tags: [
          ...aiTags.filter((t) => !hidden.has(t.toLowerCase())).map((t) => ({ tag: t, source: "ai" as const })),
          ...strArr(r.user_tags).map((t) => ({ tag: t, source: "user" as const })),
        ],
        // …with the originals preserved underneath.
        originalDescription: r.ai_description,
        hiddenTags: strArr(r.hidden_tags),
        objects: strArr(r.objects),
        people: strArr(r.people),
        scene: r.scene,
        docType: r.doc_type,
        ocrText: r.ocr_text,
        confidence: r.has_embedding && (r.ai_description || aiTags.length) ? "high" : "medium",
      } : { analyzed: false },
      notes: r.notes ?? null,
      collections: colls.map((c: any) => ({
        id: c.id, name: c.name, kind: c.kind, autoKey: c.auto_key,
        itemCount: Number(c.item_count),
      })),
      timeline: { prev, next },
    });
  } catch (err) {
    logger.error({ err }, "media detail failed");
    return res.status(500).json({ error: "Failed to load detail" });
  }
});

// ── Categorized related items ─────────────────────────────────────────────────

router.get("/media/files/:id/related", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
    const nasPath = await getNasPath();
    if (!nasPath) return res.status(409).json({ error: "No library configured" });

    const { rows } = await pool.query(
      `SELECT f.nas_path, f.date_taken, f.gps_latitude, f.gps_longitude, f.media_type,
              a.people, (a.embedding IS NOT NULL) AS has_embedding
         FROM media_files f
         LEFT JOIN media_ai a ON a.media_file_id = f.id
        WHERE f.id = $1 AND ${NOT_DELETED}`,
      [id],
    );
    const src = rows[0];
    if (!src) return res.status(404).json({ error: "File not found" });

    const LIM = 12;

    // Same event / same collection: via collection membership.
    const collsPromise = pool.query(
      `SELECT c.id AS collection_id, c.name AS collection_name, c.kind, c.auto_key, ${ITEM_COLS}
         FROM collection_items me
         JOIN collections c ON c.id = me.collection_id AND c.removed_at IS NULL
         JOIN collection_items ci ON ci.collection_id = c.id AND ci.media_file_id <> $1
         JOIN media_files f ON f.id = ci.media_file_id AND ${NOT_DELETED}
        WHERE me.media_file_id = $1
        ORDER BY c.id, f.date_taken DESC NULLS LAST`,
      [id],
    );

    // Same day.
    const sameDayPromise = src.date_taken
      ? pool.query(
          `SELECT ${ITEM_COLS} FROM media_files f
            WHERE f.nas_path = $1 AND ${NOT_DELETED} AND f.id <> $2
              AND f.date_taken::date = $3::date
            ORDER BY f.date_taken LIMIT ${LIM}`,
          [nasPath, id, src.date_taken],
        )
      : Promise.resolve({ rows: [] as any[] });

    // Same location: within ~0.05° (~5 km).
    const sameLocationPromise = src.gps_latitude != null && src.gps_longitude != null
      ? pool.query(
          `SELECT ${ITEM_COLS} FROM media_files f
            WHERE f.nas_path = $1 AND ${NOT_DELETED} AND f.id <> $2
              AND f.gps_latitude IS NOT NULL AND f.gps_longitude IS NOT NULL
              AND abs(f.gps_latitude - $3) < 0.05 AND abs(f.gps_longitude - $4) < 0.05
            ORDER BY f.date_taken DESC NULLS LAST LIMIT ${LIM}`,
          [nasPath, id, src.gps_latitude, src.gps_longitude],
        )
      : Promise.resolve({ rows: [] as any[] });

    // Same people: prefer real face identity (local face recognition); fall
    // back to AI person-descriptor overlap for items without face data yet.
    const people = strArr(src.people);
    const samePeoplePromise = (async () => {
      const { rows: myFaces } = await pool.query(
        `SELECT DISTINCT person_id FROM faces WHERE media_file_id = $1 AND person_id IS NOT NULL`, [id]);
      const personIds = myFaces.map((r: any) => Number(r.person_id));
      if (personIds.length) {
        return pool.query(
          `SELECT * FROM (
             SELECT DISTINCT ON (f.id) ${ITEM_COLS}
               FROM faces fc
               JOIN media_files f ON f.id = fc.media_file_id
              WHERE f.nas_path = $1 AND ${NOT_DELETED} AND f.id <> $2
                AND fc.person_id = ANY($3::int[])
              ORDER BY f.id
           ) sub
           ORDER BY sub.date_taken DESC NULLS LAST
           LIMIT ${LIM}`,
          [nasPath, id, personIds],
        );
      }
      if (!people.length) return { rows: [] as any[] };
      return pool.query(
        `SELECT ${ITEM_COLS} FROM media_files f
          JOIN media_ai a ON a.media_file_id = f.id
         WHERE f.nas_path = $1 AND ${NOT_DELETED} AND f.id <> $2
           AND a.people IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements_text(a.people) p
              WHERE lower(p.value) = ANY($3::text[])
           )
         ORDER BY f.date_taken DESC NULLS LAST LIMIT ${LIM}`,
        [nasPath, id, people.map((p) => p.toLowerCase())],
      );
    })();

    // Visually/semantically similar (embedding space).
    const similarPromise = src.has_embedding
      ? findSimilar(nasPath, id, LIM).catch(() => [])
      : Promise.resolve([]);

    const [colls, sameDay, sameLocation, samePeople, similar] = await Promise.all([
      collsPromise, sameDayPromise, sameLocationPromise, samePeoplePromise, similarPromise,
    ]);

    const events: { collectionId: number; name: string; items: RelatedItem[] }[] = [];
    const collections: { collectionId: number; name: string; kind: string; items: RelatedItem[] }[] = [];
    const byColl = new Map<number, any[]>();
    for (const row of colls.rows as any[]) {
      if (!byColl.has(row.collection_id)) byColl.set(row.collection_id, []);
      if (byColl.get(row.collection_id)!.length < LIM) byColl.get(row.collection_id)!.push(row);
    }
    for (const [collId, items] of byColl) {
      const first = items[0];
      const entry = { collectionId: collId, name: first.collection_name, kind: first.kind, items: items.map(toItem) };
      if (first.kind === "auto" && String(first.auto_key ?? "").startsWith("event:")) events.push(entry);
      else collections.push(entry);
    }

    return res.json({
      sameEvent: events,
      sameDay: (sameDay.rows as any[]).map(toItem),
      sameLocation: (sameLocation.rows as any[]).map(toItem),
      samePeople: (samePeople.rows as any[]).map(toItem),
      similar,
      sameCollection: collections,
    });
  } catch (err) {
    logger.error({ err }, "media related failed");
    return res.status(500).json({ error: "Failed to load related items" });
  }
});

// ── User corrections & notes (write back to the canonical record) ────────────

router.patch("/media/files/:id/ai", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });

    const body = req.body ?? {};
    const clean = (v: unknown) => String(v).trim().toLowerCase().slice(0, 60);
    const addTags = Array.isArray(body.addTags) ? body.addTags.map(clean).filter(Boolean).slice(0, 20) : [];
    const removeTags = Array.isArray(body.removeTags) ? body.removeTags.map(clean).filter(Boolean).slice(0, 40) : [];
    const hasDescription = typeof body.description === "string" || body.description === null;
    const hasNotes = typeof body.notes === "string" || body.notes === null;
    if (!addTags.length && !removeTags.length && !hasDescription && !hasNotes) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    const { rows: fileRows } = await pool.query(
      `SELECT id FROM media_files f WHERE f.id = $1 AND ${NOT_DELETED}`, [id]);
    if (!fileRows[0]) return res.status(404).json({ error: "File not found" });

    // Ensure a media_ai row exists (users may annotate before AI runs).
    await pool.query(
      `INSERT INTO media_ai (media_file_id, ai_version) VALUES ($1, 0)
       ON CONFLICT (media_file_id) DO NOTHING`, [id]);

    const { rows: aiRows } = await pool.query(
      `SELECT tags, user_tags, hidden_tags FROM media_ai WHERE media_file_id = $1`, [id]);
    const cur = aiRows[0];
    const aiTags = new Set(strArr(cur.tags).map((t) => t.toLowerCase()));
    let userTags = strArr(cur.user_tags).map((t) => t.toLowerCase());
    let hiddenTags = strArr(cur.hidden_tags).map((t) => t.toLowerCase());

    for (const t of removeTags) {
      userTags = userTags.filter((x) => x !== t);
      if (aiTags.has(t) && !hiddenTags.includes(t)) hiddenTags.push(t); // original AI tag preserved, just hidden
    }
    for (const t of addTags) {
      hiddenTags = hiddenTags.filter((x) => x !== t); // re-adding an AI tag un-hides it
      if (!aiTags.has(t) && !userTags.includes(t)) userTags.push(t);
    }

    const sets: string[] = [`user_tags = $2`, `hidden_tags = $3`];
    const params: unknown[] = [id, JSON.stringify(userTags), JSON.stringify(hiddenTags)];
    if (hasDescription) {
      params.push(body.description === null ? null : String(body.description).trim().slice(0, 1000) || null);
      sets.push(`user_description = $${params.length}`);
    }
    if (hasNotes) {
      params.push(body.notes === null ? null : String(body.notes).trim().slice(0, 5000) || null);
      sets.push(`notes = $${params.length}`);
    }
    await pool.query(`UPDATE media_ai SET ${sets.join(", ")} WHERE media_file_id = $1`, params);

    // Search must reflect the correction immediately: recompute the local
    // embedding from the merged (AI + user) record.
    try {
      await recomputeEmbedding(id);
    } catch (err) {
      logger.warn({ err, id }, "Re-embedding after correction failed (keyword search still reflects it)");
    }

    const { rows: out } = await pool.query(
      `SELECT description, tags, user_tags, hidden_tags, user_description, notes
         FROM media_ai WHERE media_file_id = $1`, [id]);
    const o = out[0];
    const hidden = new Set(strArr(o.hidden_tags).map((t: string) => t.toLowerCase()));
    return res.json({
      ok: true,
      description: o.user_description ?? o.description,
      descriptionEdited: o.user_description != null,
      tags: [
        ...strArr(o.tags).filter((t) => !hidden.has(t.toLowerCase())).map((t) => ({ tag: t, source: "ai" })),
        ...strArr(o.user_tags).map((t) => ({ tag: t, source: "user" })),
      ],
      hiddenTags: strArr(o.hidden_tags),
      notes: o.notes ?? null,
    });
  } catch (err) {
    logger.error({ err }, "media ai patch failed");
    return res.status(500).json({ error: "Failed to save changes" });
  }
});

export default router;
