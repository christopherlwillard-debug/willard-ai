import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { db, pool, appSettingsTable } from "@workspace/db";
import { checkNasReachable, getWillardAIDir } from "./nas-storage";
import { logger } from "./logger";

/**
 * Face Recognition Engine — privacy-first, fully local.
 *
 * For every image/video thumbnail in the library it:
 *   1. Detects faces with a local ONNX SCRFD model (insightface buffalo_s).
 *   2. Computes a 512-dim identity embedding per face (w600k MobileFaceNet,
 *      also local ONNX) — no pixels ever leave the machine.
 *   3. Clusters faces into `people` by cosine similarity against per-person
 *      centroid embeddings (incremental, order-independent enough for a
 *      personal library).
 *
 * Users then name clusters ("Grandma"); names flow through the People card
 * on the detail page and the People browse page. All face data is derived
 * and rebuildable; media_files stays the single source of truth.
 */

const TICK_MS = 25_000;
const BATCH_PER_TICK = 4;
export const FACE_VERSION = 1;

const DET_SIZE = 320;              // SCRFD input (square, letterboxed)
const DET_SCORE_THRESHOLD = 0.5;
const NMS_IOU = 0.4;
const REC_SIZE = 112;              // recognition input
const MIN_FACE_PX = 20;            // ignore tiny detections on a 400px thumb
const SAME_PERSON_COSINE = 0.42;   // w600k: >= 0.4 is confidently same identity

const MODEL_DIR = path.join(os.homedir(), ".cache", "willard-face-models");
const DETECT_URL = "https://huggingface.co/immich-app/buffalo_s/resolve/main/detection/model.onnx";
const RECOGNIZE_URL = "https://huggingface.co/immich-app/buffalo_s/resolve/main/recognition/model.onnx";

interface FaceStatus {
  running: boolean;
  modelsReady: boolean;
  scanned: number;    // files, this process lifetime
  facesFound: number; // this process lifetime
  failed: number;
  pending: number;    // as of last tick
  lastRunAt: string | null;
}

const status: FaceStatus = {
  running: false,
  modelsReady: false,
  scanned: 0,
  facesFound: 0,
  failed: 0,
  pending: 0,
  lastRunAt: null,
};

export function getFaceStatus(): FaceStatus {
  return { ...status };
}

// ── Model loading (downloaded once, cached locally) ──────────────────────────

async function downloadModel(url: string, dest: string): Promise<void> {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1_000_000) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.download`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Model download failed (${resp.status}) for ${url}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length < 1_000_000) throw new Error(`Model download suspiciously small (${buf.length} bytes)`);
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
}

type OrtSession = import("onnxruntime-node").InferenceSession;

let sessionsPromise: Promise<{ det: OrtSession; rec: OrtSession; ort: typeof import("onnxruntime-node") }> | null = null;

function getSessions() {
  if (!sessionsPromise) {
    sessionsPromise = (async () => {
      const detPath = path.join(MODEL_DIR, "scrfd_500m.onnx");
      const recPath = path.join(MODEL_DIR, "w600k_mbf.onnx");
      await Promise.all([downloadModel(DETECT_URL, detPath), downloadModel(RECOGNIZE_URL, recPath)]);
      const ort = await import("onnxruntime-node");
      const opts = { logSeverityLevel: 3 as const };
      const [det, rec] = await Promise.all([
        ort.InferenceSession.create(detPath, opts),
        ort.InferenceSession.create(recPath, opts),
      ]);
      status.modelsReady = true;
      return { det, rec, ort };
    })();
    sessionsPromise.catch(() => { sessionsPromise = null; });
  }
  return sessionsPromise;
}

// ── SCRFD detection ───────────────────────────────────────────────────────────

export interface DetectedFace {
  x: number; y: number; w: number; h: number; // source-image pixel coords
  score: number;
}

function iou(a: DetectedFace, b: DetectedFace): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

function nms(faces: DetectedFace[]): DetectedFace[] {
  const sorted = [...faces].sort((a, b) => b.score - a.score);
  const keep: DetectedFace[] = [];
  for (const f of sorted) {
    if (keep.every((k) => iou(f, k) < NMS_IOU)) keep.push(f);
  }
  return keep;
}

/**
 * Detect faces in an image buffer. Letterboxes to DET_SIZE, runs SCRFD,
 * decodes distance-based anchors for strides 8/16/32, NMS, and maps boxes
 * back to source pixel coordinates.
 */
export async function detectFaces(imageBuffer: Buffer): Promise<{ faces: DetectedFace[]; width: number; height: number }> {
  const sharp = (await import("sharp")).default;
  const meta = await sharp(imageBuffer).metadata();
  const srcW = meta.width ?? 0;
  const srcH = meta.height ?? 0;
  if (!srcW || !srcH) return { faces: [], width: 0, height: 0 };

  const scale = Math.min(DET_SIZE / srcW, DET_SIZE / srcH);
  const rw = Math.max(1, Math.round(srcW * scale));
  const rh = Math.max(1, Math.round(srcH * scale));

  const raw = await sharp(imageBuffer)
    .resize(rw, rh, { fit: "fill" })
    .extend({ top: 0, left: 0, right: DET_SIZE - rw, bottom: DET_SIZE - rh, background: { r: 0, g: 0, b: 0 } })
    .removeAlpha()
    .raw()
    .toBuffer();

  // HWC uint8 RGB → NCHW float32, (x - 127.5) / 128
  const n = DET_SIZE * DET_SIZE;
  const input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    input[i]         = (raw[i * 3]     - 127.5) / 128;
    input[n + i]     = (raw[i * 3 + 1] - 127.5) / 128;
    input[2 * n + i] = (raw[i * 3 + 2] - 127.5) / 128;
  }

  const { det, ort } = await getSessions();
  const feeds: Record<string, InstanceType<typeof ort.Tensor>> = {
    [det.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, DET_SIZE, DET_SIZE]),
  };
  const out = await det.run(feeds);

  // Group outputs by anchor count: for each stride s, count = (DET_SIZE/s)^2 * 2.
  // Scores have 1 value per anchor, bboxes 4, keypoints 10.
  const strides = [8, 16, 32];
  const faces: DetectedFace[] = [];
  const tensors = det.outputNames.map((name) => out[name]);
  for (const stride of strides) {
    const cells = DET_SIZE / stride;
    const count = cells * cells * 2;
    // Disambiguate by trailing dim: scores are (N,1), boxes are (N,4) —
    // matching by raw length alone confuses stride-8 scores with stride-16 boxes.
    const last = (t: { dims: readonly number[] }) => t.dims[t.dims.length - 1];
    const scoreT = tensors.find((t) => last(t) === 1 && t.data.length === count);
    const bboxT = tensors.find((t) => last(t) === 4 && t.data.length === count * 4);
    if (!scoreT || !bboxT) continue;
    const scores = scoreT.data as Float32Array;
    const bboxes = bboxT.data as Float32Array;
    for (let i = 0; i < count; i++) {
      const score = scores[i];
      if (score < DET_SCORE_THRESHOLD) continue;
      const anchorIdx = Math.floor(i / 2);
      const cx = (anchorIdx % cells) * stride;
      const cy = Math.floor(anchorIdx / cells) * stride;
      const x1 = cx - bboxes[i * 4] * stride;
      const y1 = cy - bboxes[i * 4 + 1] * stride;
      const x2 = cx + bboxes[i * 4 + 2] * stride;
      const y2 = cy + bboxes[i * 4 + 3] * stride;
      // Map back to source pixels.
      const sx = Math.max(0, x1 / scale);
      const sy = Math.max(0, y1 / scale);
      const ex = Math.min(srcW, x2 / scale);
      const ey = Math.min(srcH, y2 / scale);
      if (ex - sx < MIN_FACE_PX || ey - sy < MIN_FACE_PX) continue;
      faces.push({ x: sx, y: sy, w: ex - sx, h: ey - sy, score });
    }
  }
  return { faces: nms(faces), width: srcW, height: srcH };
}

// ── Face embedding ────────────────────────────────────────────────────────────

/** Crop a face (with margin) and compute its 512-dim identity embedding. */
export async function embedFace(imageBuffer: Buffer, face: DetectedFace, srcW: number, srcH: number): Promise<number[]> {
  const sharp = (await import("sharp")).default;
  const margin = 0.2;
  const mx = face.w * margin;
  const my = face.h * margin;
  const left = Math.max(0, Math.round(face.x - mx));
  const top = Math.max(0, Math.round(face.y - my));
  const width = Math.min(srcW - left, Math.round(face.w + 2 * mx));
  const height = Math.min(srcH - top, Math.round(face.h + 2 * my));

  const raw = await sharp(imageBuffer)
    .extract({ left, top, width, height })
    .resize(REC_SIZE, REC_SIZE, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer();

  const n = REC_SIZE * REC_SIZE;
  const input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    input[i]         = (raw[i * 3]     - 127.5) / 127.5;
    input[n + i]     = (raw[i * 3 + 1] - 127.5) / 127.5;
    input[2 * n + i] = (raw[i * 3 + 2] - 127.5) / 127.5;
  }

  const { rec, ort } = await getSessions();
  const out = await rec.run({ [rec.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, REC_SIZE, REC_SIZE]) });
  const emb = Array.from(out[rec.outputNames[0]].data as Float32Array);
  // L2 normalize so cosine similarity is a plain dot product.
  const norm = Math.sqrt(emb.reduce((s, v) => s + v * v, 0)) || 1;
  return emb.map((v) => v / norm);
}

function toVec(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

// ── Face crops on disk ────────────────────────────────────────────────────────

export function getFaceCropDir(nasPath: string): string {
  return path.join(getWillardAIDir(nasPath), "cache", "faces");
}

async function saveFaceCrop(imageBuffer: Buffer, face: DetectedFace, srcW: number, srcH: number, dest: string): Promise<void> {
  const sharp = (await import("sharp")).default;
  const margin = 0.35;
  const mx = face.w * margin;
  const my = face.h * margin;
  const left = Math.max(0, Math.round(face.x - mx));
  const top = Math.max(0, Math.round(face.y - my));
  const width = Math.min(srcW - left, Math.round(face.w + 2 * mx));
  const height = Math.min(srcH - top, Math.round(face.h + 2 * my));
  await sharp(imageBuffer)
    .extract({ left, top, width, height })
    .resize(160, 160, { fit: "cover" })
    .webp({ quality: 80 })
    .toFile(dest);
}

// ── Incremental clustering ────────────────────────────────────────────────────

/**
 * Assign an embedding to the nearest existing person (cosine similarity vs
 * per-person centroid), or create a new unnamed person cluster. Updates the
 * running-mean centroid.
 */
async function assignToPerson(embedding: number[]): Promise<number> {
  const vec = toVec(embedding);
  const { rows } = await pool.query(
    `SELECT id, face_count, 1 - (centroid <=> $1::vector) AS sim
       FROM people
      WHERE centroid IS NOT NULL
      ORDER BY centroid <=> $1::vector
      LIMIT 1`,
    [vec],
  );
  const best = rows[0];
  if (best && Number(best.sim) >= SAME_PERSON_COSINE) {
    // Caller inserts the face row and then calls refreshPerson(), which
    // recomputes centroid = avg(member embeddings) and the face count.
    return Number(best.id);
  }
  const { rows: created } = await pool.query(
    `INSERT INTO people (name, face_count, centroid) VALUES (NULL, 1, $1::vector) RETURNING id`,
    [vec],
  );
  return Number(created[0].id);
}

/** Refresh a person's centroid/count from its member faces (used after merges/deletes). */
export async function refreshPerson(personId: number): Promise<void> {
  await pool.query(
    `UPDATE people p
        SET centroid = sub.avg_emb, face_count = COALESCE(sub.cnt, 0)
       FROM (SELECT avg(embedding) AS avg_emb, count(*) AS cnt FROM faces WHERE person_id = $1 AND embedding IS NOT NULL) sub
      WHERE p.id = $1`,
    [personId],
  );
  // Repair a dangling cover face (e.g. after a rescan deleted the old row).
  await pool.query(
    `UPDATE people p
        SET cover_face_id = (SELECT id FROM faces WHERE person_id = p.id ORDER BY score DESC LIMIT 1)
      WHERE p.id = $1
        AND (p.cover_face_id IS NULL OR NOT EXISTS (SELECT 1 FROM faces WHERE id = p.cover_face_id AND person_id = p.id))`,
    [personId],
  );
  await pool.query(`DELETE FROM people WHERE id = $1 AND face_count = 0`, [personId]);
}

// ── Per-file scan ─────────────────────────────────────────────────────────────

interface PendingFile {
  id: number;
  thumbnailPath: string;
}

async function scanFile(nasPath: string, file: PendingFile): Promise<void> {
  try {
    if (!fs.existsSync(file.thumbnailPath)) {
      // Thumbnail not on disk (yet) — record as scanned-with-error so we do
      // not spin on it; thumbnail regeneration bumps will re-enter via version.
      await pool.query(
        `INSERT INTO face_scan_state (media_file_id, face_version, face_count, error)
         VALUES ($1, $2, 0, 'thumbnail missing')
         ON CONFLICT (media_file_id) DO UPDATE SET face_version = excluded.face_version, scanned_at = now(), error = excluded.error`,
        [file.id, FACE_VERSION],
      );
      return;
    }
    const buf = fs.readFileSync(file.thumbnailPath);
    const { faces, width, height } = await detectFaces(buf);

    // Rebuild this file's faces from scratch (derived data).
    const { rows: old } = await pool.query(`SELECT DISTINCT person_id FROM faces WHERE media_file_id = $1 AND person_id IS NOT NULL`, [file.id]);
    await pool.query(`DELETE FROM faces WHERE media_file_id = $1`, [file.id]);

    const cropDir = getFaceCropDir(nasPath);
    fs.mkdirSync(cropDir, { recursive: true });

    let idx = 0;
    for (const face of faces) {
      idx++;
      const embedding = await embedFace(buf, face, width, height);
      const personId = await assignToPerson(embedding);
      const cropPath = path.join(cropDir, `${file.id}-${idx}.webp`);
      try { await saveFaceCrop(buf, face, width, height, cropPath); } catch { /* crop optional */ }
      const { rows: ins } = await pool.query(
        `INSERT INTO faces (media_file_id, person_id, box_x, box_y, box_w, box_h, score, crop_path, embedding)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::vector) RETURNING id`,
        [file.id, personId, face.x, face.y, face.w, face.h, face.score, fs.existsSync(cropPath) ? cropPath : null, toVec(embedding)],
      );
      // First face of a new cluster becomes its cover; keep centroid fresh.
      await pool.query(`UPDATE people SET cover_face_id = $1 WHERE id = $2 AND cover_face_id IS NULL`, [ins[0].id, personId]);
      await refreshPerson(personId).catch(() => {});
      status.facesFound++;
    }

    // Refresh clusters that lost members from the rebuild.
    for (const r of old) {
      await refreshPerson(Number(r.person_id)).catch(() => {});
    }

    await pool.query(
      `INSERT INTO face_scan_state (media_file_id, face_version, face_count, error)
       VALUES ($1, $2, $3, NULL)
       ON CONFLICT (media_file_id) DO UPDATE SET
         face_version = excluded.face_version, face_count = excluded.face_count,
         scanned_at = now(), error = NULL`,
      [file.id, FACE_VERSION, faces.length],
    );
    status.scanned++;
  } catch (err) {
    status.failed++;
    logger.warn({ err, fileId: file.id }, "face scan failed for file");
    await pool.query(
      `INSERT INTO face_scan_state (media_file_id, face_version, face_count, error)
       VALUES ($1, $2, 0, $3)
       ON CONFLICT (media_file_id) DO UPDATE SET face_version = excluded.face_version, scanned_at = now(), error = excluded.error`,
      [file.id, FACE_VERSION, String(err instanceof Error ? err.message : err).slice(0, 500)],
    ).catch(() => {});
  }
}

// ── Background loop ───────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let ticking = false;

export async function runFaceTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  status.running = true;
  try {
    let nasPath: string | null = null;
    let paused = false;
    try {
      const [row] = await db.select({
        nasPath: appSettingsTable.nasPath,
        indexingPaused: appSettingsTable.indexingPaused,
      }).from(appSettingsTable).limit(1);
      nasPath = row?.nasPath ?? null;
      paused = row?.indexingPaused ?? false;
    } catch { return; }
    if (!nasPath || paused) return;
    const reach = checkNasReachable(nasPath);
    if (!reach.online) return;

    const { rows } = await pool.query(
      `SELECT f.id, f.thumbnail_path, count(*) OVER () AS total
         FROM media_files f
         LEFT JOIN face_scan_state s ON s.media_file_id = f.id AND s.face_version >= $2
        WHERE f.nas_path = $1
          AND (f.last_scan_action IS NULL OR f.last_scan_action <> 'DELETED')
          AND f.media_type IN ('image', 'photo', 'video')
          AND f.thumbnail_path IS NOT NULL
          AND s.media_file_id IS NULL
        ORDER BY f.id
        LIMIT $3`,
      [nasPath, FACE_VERSION, BATCH_PER_TICK],
    );
    status.pending = rows.length ? Number(rows[0].total) : 0;
    status.lastRunAt = new Date().toISOString();
    if (!rows.length) return;

    for (const r of rows) {
      await scanFile(reach.path, { id: r.id, thumbnailPath: r.thumbnail_path });
    }
    status.pending = Math.max(0, status.pending - rows.length);
  } finally {
    ticking = false;
    status.running = false;
  }
}

export function startFaceRecognition(): void {
  if (timer) return;
  setTimeout(() => { runFaceTick().catch(() => {}); }, 12_000);
  timer = setInterval(() => { runFaceTick().catch(() => {}); }, TICK_MS);
  timer.unref?.();
}
