import * as fs from "fs";
import { sql } from "drizzle-orm";
import { db, pool, appSettingsTable } from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { checkNasReachable } from "./nas-storage";
import { logger } from "./logger";

/**
 * AI Enrichment Engine — builds the "understanding" layer on top of the
 * canonical media_files index. For every indexed file it derives (into the
 * media_ai table, one row per file, fully rebuildable):
 *
 *  - Images / video thumbnails → vision model: description, tags, objects,
 *    visible text (OCR), scene.
 *  - PDFs / documents → extracted text + classification (receipt, invoice…).
 *  - Everything → a semantic embedding (pgvector) over all textual signals,
 *    powering natural-language and similarity search.
 *
 * Runs as a low-intensity background loop; respects indexing pause and
 * library offline states. media_files stays the single source of truth —
 * media_ai is derived data keyed by media_file_id.
 */

const TICK_MS = 20_000;
const BATCH_PER_TICK = 3;
const AI_VERSION = 1;
const CHAT_MODEL = "gpt-5.4";

const MAX_DOC_TEXT = 6_000;

interface EnrichmentStatus {
  running: boolean;
  analyzed: number;   // this process lifetime
  failed: number;
  pending: number;    // as of last tick
  lastRunAt: string | null;
}

const status: EnrichmentStatus = {
  running: false,
  analyzed: 0,
  failed: 0,
  pending: 0,
  lastRunAt: null,
};

export function getEnrichmentStatus(): EnrichmentStatus {
  return { ...status };
}

// ── Vision / document analysis ────────────────────────────────────────────────

interface AiAnalysis {
  description: string | null;
  tags: string[];
  objects: string[];
  ocrText: string | null;
  docType: string | null;
  scene: string | null;
}

const VISION_PROMPT = `You are an expert photo/video analyst for a personal media library.
Analyze the image and return STRICT JSON with keys:
{"description": "one natural sentence describing the image",
 "tags": ["5-12 lowercase content/scene tags e.g. beach, sunset, snow, family"],
 "objects": ["concrete objects visible e.g. truck, dog, waterfall, receipt"],
 "ocr_text": "any readable text in the image, or null",
 "scene": "one of: outdoor, indoor, nature, city, beach, mountains, forest, water, sunset, night, document, screenshot, people, food, vehicle, other"}
Return JSON only.`;

async function analyzeImage(thumbnailPath: string): Promise<AiAnalysis> {
  const b64 = fs.readFileSync(thumbnailPath).toString("base64");
  const resp = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: VISION_PROMPT },
        { type: "image_url", image_url: { url: `data:image/webp;base64,${b64}` } },
      ],
    }],
    response_format: { type: "json_object" },
  });
  const parsed = JSON.parse(resp.choices[0]?.message?.content ?? "{}");
  return {
    description: typeof parsed.description === "string" ? parsed.description : null,
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).slice(0, 20) : [],
    objects: Array.isArray(parsed.objects) ? parsed.objects.map(String).slice(0, 20) : [],
    ocrText: typeof parsed.ocr_text === "string" && parsed.ocr_text.trim() ? parsed.ocr_text.trim() : null,
    docType: null,
    scene: typeof parsed.scene === "string" ? parsed.scene : null,
  };
}

async function extractPdfText(fullPath: string): Promise<string | null> {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const uint8 = new Uint8Array(fs.readFileSync(fullPath));
    const doc = await (pdfjsLib as any).getDocument({ data: uint8, verbosity: 0 }).promise;
    let text = "";
    const pages = Math.min(doc.numPages, 10);
    for (let i = 1; i <= pages && text.length < MAX_DOC_TEXT; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map((it: any) => it.str ?? "").join(" ") + "\n";
    }
    await doc.destroy();
    const trimmed = text.replace(/\s+/g, " ").trim();
    return trimmed ? trimmed.slice(0, MAX_DOC_TEXT) : null;
  } catch {
    return null;
  }
}

const DOC_PROMPT = `You are a document classifier for a personal file library.
Given document text and filename, return STRICT JSON:
{"description": "one sentence describing what this document is",
 "tags": ["3-8 lowercase topic tags e.g. receipt, flooring, warranty, tax"],
 "doc_type": "one of: receipt, invoice, statement, manual, contract, letter, report, form, ticket, recipe, note, other"}
Return JSON only.`;

async function analyzeDocument(name: string, text: string | null): Promise<AiAnalysis> {
  const resp = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages: [{
      role: "user",
      content: `${DOC_PROMPT}\n\nFilename: ${name}\nText:\n${text ? text.slice(0, 4000) : "(no extractable text)"}`,
    }],
    response_format: { type: "json_object" },
  });
  const parsed = JSON.parse(resp.choices[0]?.message?.content ?? "{}");
  return {
    description: typeof parsed.description === "string" ? parsed.description : null,
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).slice(0, 12) : [],
    objects: [],
    ocrText: text,
    docType: typeof parsed.doc_type === "string" ? parsed.doc_type : null,
    scene: "document",
  };
}

// ── Embeddings (local-first, privacy-respecting) ──────────────────────────────
//
// The AI proxy does not expose an embeddings endpoint, and the task calls for
// a local-first approach anyway: we run all-MiniLM-L6-v2 (384-dim) fully
// locally via transformers.js. No file content ever leaves the machine for
// semantic indexing.

let embedderPromise: Promise<(text: string) => Promise<number[]>> | null = null;

function getEmbedder(): Promise<(text: string) => Promise<number[]>> {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" });
      return async (text: string) => {
        const out = await extractor(text.slice(0, 4000), { pooling: "mean", normalize: true });
        return Array.from(out.data as Float32Array);
      };
    })();
    embedderPromise.catch(() => { embedderPromise = null; });
  }
  return embedderPromise;
}

export async function embedText(text: string): Promise<number[]> {
  const embed = await getEmbedder();
  return embed(text);
}

export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

function buildEmbeddingText(file: PendingFile, a: AiAnalysis): string {
  const parts = [
    file.name,
    file.relativePath.split("/").slice(0, -1).join(" "),
    a.description,
    a.tags.join(" "),
    a.objects.join(" "),
    a.scene,
    a.docType,
    a.ocrText ? a.ocrText.slice(0, 2000) : null,
    file.cameraMake, file.cameraModel,
    file.dateTaken ? new Date(file.dateTaken).toISOString().slice(0, 10) : null,
  ];
  return parts.filter(Boolean).join("\n");
}

// ── Work selection ────────────────────────────────────────────────────────────

interface PendingFile {
  id: number;
  name: string;
  relativePath: string;
  mediaType: string;
  thumbnailPath: string | null;
  fullPath: string;
  cameraMake: string | null;
  cameraModel: string | null;
  dateTaken: string | null;
}

async function fetchPending(nasPath: string, limit: number): Promise<{ rows: PendingFile[]; total: number }> {
  const { rows } = await pool.query(
    `SELECT f.id, f.name, f.relative_path, f.media_type, f.thumbnail_path,
            f.camera_make, f.camera_model, f.date_taken,
            count(*) OVER () AS total
       FROM media_files f
       LEFT JOIN media_ai a ON a.media_file_id = f.id AND a.ai_version >= $2
      WHERE f.nas_path = $1
        AND (f.last_scan_action IS NULL OR f.last_scan_action <> 'DELETED')
        AND a.id IS NULL
      ORDER BY f.id
      LIMIT $3`,
    [nasPath, AI_VERSION, limit],
  );
  const path = await import("path");
  return {
    total: rows.length ? Number(rows[0].total) : 0,
    rows: rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      relativePath: r.relative_path,
      mediaType: r.media_type,
      thumbnailPath: r.thumbnail_path,
      fullPath: path.join(nasPath, r.relative_path),
      cameraMake: r.camera_make,
      cameraModel: r.camera_model,
      dateTaken: r.date_taken,
    })),
  };
}

// ── Enrichment of one file ───────────────────────────────────────────────────

async function enrichOne(file: PendingFile): Promise<void> {
  let analysis: AiAnalysis;
  try {
    if ((file.mediaType === "image" || file.mediaType === "photo" || file.mediaType === "video") &&
        file.thumbnailPath && fs.existsSync(file.thumbnailPath)) {
      analysis = await analyzeImage(file.thumbnailPath);
    } else if (file.mediaType === "document") {
      const text = file.fullPath.toLowerCase().endsWith(".pdf")
        ? await extractPdfText(file.fullPath)
        : readPlainText(file.fullPath);
      analysis = await analyzeDocument(file.name, text);
    } else {
      // No visual/text content available (yet) — index name & metadata only.
      analysis = { description: null, tags: [], objects: [], ocrText: null, docType: null, scene: null };
    }

    const embedding = await embedText(buildEmbeddingText(file, analysis));
    await pool.query(
      `INSERT INTO media_ai (media_file_id, description, tags, objects, ocr_text, doc_type, scene, embedding, ai_version, analyzed_at, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),NULL)
       ON CONFLICT (media_file_id) DO UPDATE SET
         description = excluded.description,
         tags        = excluded.tags,
         objects     = excluded.objects,
         ocr_text    = excluded.ocr_text,
         doc_type    = excluded.doc_type,
         scene       = excluded.scene,
         embedding   = excluded.embedding,
         ai_version  = excluded.ai_version,
         analyzed_at = now(),
         error       = NULL`,
      [
        file.id, analysis.description,
        JSON.stringify(analysis.tags), JSON.stringify(analysis.objects),
        analysis.ocrText, analysis.docType, analysis.scene,
        embedding.length ? toVectorLiteral(embedding) : null,
        AI_VERSION,
      ],
    );
    status.analyzed++;
  } catch (err) {
    status.failed++;
    logger.warn({ err, fileId: file.id, name: file.name }, "AI enrichment failed for file");
    await pool.query(
      `INSERT INTO media_ai (media_file_id, ai_version, error)
       VALUES ($1, 0, $2)
       ON CONFLICT (media_file_id) DO UPDATE SET error = excluded.error`,
      [file.id, String(err instanceof Error ? err.message : err).slice(0, 500)],
    ).catch(() => {});
  }
}

function readPlainText(fullPath: string): string | null {
  try {
    const ext = fullPath.toLowerCase();
    if (!/\.(txt|md|csv|log|json)$/.test(ext)) return null;
    return fs.readFileSync(fullPath, "utf8").slice(0, MAX_DOC_TEXT);
  } catch {
    return null;
  }
}

// ── Background loop ───────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let ticking = false;

export async function runEnrichmentTick(): Promise<void> {
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

    const { rows, total } = await fetchPending(reach.path, BATCH_PER_TICK);
    status.pending = total;
    status.lastRunAt = new Date().toISOString();
    for (const file of rows) {
      await enrichOne(file);
    }
    if (rows.length) status.pending = Math.max(0, total - rows.length);
  } finally {
    ticking = false;
    status.running = false;
  }
}

export function startAiEnrichment(): void {
  if (timer) return;
  setTimeout(() => { runEnrichmentTick().catch(() => {}); }, 8_000);
  timer = setInterval(() => { runEnrichmentTick().catch(() => {}); }, TICK_MS);
  timer.unref?.();
}
