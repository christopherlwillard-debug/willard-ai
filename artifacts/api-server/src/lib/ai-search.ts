import { pool } from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { embedText, toVectorLiteral } from "./ai-enrichment";
import { logger } from "./logger";

/**
 * AI Search — natural-language hybrid search over the canonical library index.
 *
 * One query combines every available signal: file/folder names, EXIF metadata,
 * dates, GPS, favorites, document text (OCR), AI image understanding (tags,
 * objects, scene, description) and semantic embeddings. A small LLM pass turns
 * the user's plain-English query into a structured intent; refinements merge
 * into the previous intent instead of restarting. Results carry human-readable
 * match reasons and confidence labels.
 */

const CHAT_MODEL = "gpt-5.4";

// ── Intent ────────────────────────────────────────────────────────────────────

export interface SearchIntent {
  semanticQuery: string | null;   // what to embed for meaning-based matching
  keywords: string[];             // literal terms to match names / text
  mediaTypes: string[];           // image | video | document | audio | archive | other
  dateFrom: string | null;        // ISO date
  dateTo: string | null;
  objects: string[];              // things that should appear (truck, waterfall…)
  exclude: string[];              // terms to exclude (screenshot…)
  favoriteOnly: boolean;
  docTypes: string[];             // receipt, invoice…
  location: string | null;        // place words (matched against text signals)
}

export function emptyIntent(): SearchIntent {
  return {
    semanticQuery: null, keywords: [], mediaTypes: [], dateFrom: null, dateTo: null,
    objects: [], exclude: [], favoriteOnly: false, docTypes: [], location: null,
  };
}

const INTENT_PROMPT = `You convert plain-English media library searches into structured JSON.
Today's date: {TODAY}.
The library contains photos, videos and documents with: names, folders, dates taken, GPS, camera info, favorites, AI-detected objects/tags/scenes, OCR/document text.

Return STRICT JSON:
{"semanticQuery": "short phrase capturing the visual/semantic meaning, or null",
 "keywords": ["literal words worth matching in file names or text"],
 "mediaTypes": ["image"|"video"|"document"|"audio"|"archive"],
 "dateFrom": "YYYY-MM-DD or null", "dateTo": "YYYY-MM-DD or null",
 "objects": ["concrete things that must appear, lowercase"],
 "exclude": ["terms the user excluded"],
 "favoriteOnly": false,
 "docTypes": ["receipt"|"invoice"|"statement"|"manual"|"contract"|"letter"|"report"|"form"|"ticket"|"recipe"|"note"],
 "location": "place name or null"}

Rules:
- "pictures"/"photos" → mediaTypes ["image"]; "videos" → ["video"]; "PDFs"/"documents"/"receipts" → ["document"].
- Resolve relative dates ("last summer", "2024") into dateFrom/dateTo using today's date.
- If REFINING a previous search (previous intent provided), MERGE: keep previous constraints and add/override only what the new message changes. "Only the ones with waterfalls" adds waterfall to objects. "Exclude screenshots" adds to exclude. A completely new topic replaces the intent.
Return JSON only.`;

export async function parseIntent(
  query: string,
  previous: SearchIntent | null,
): Promise<SearchIntent> {
  const today = new Date().toISOString().slice(0, 10);
  const messages = [
    { role: "system" as const, content: INTENT_PROMPT.replace("{TODAY}", today) },
    {
      role: "user" as const,
      content: previous
        ? `Previous intent (the user is refining this search):\n${JSON.stringify(previous)}\n\nNew message: ${query}`
        : `New search: ${query}`,
    },
  ];
  try {
    const resp = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages,
      response_format: { type: "json_object" },
    });
    const p = JSON.parse(resp.choices[0]?.message?.content ?? "{}");
    const arr = (v: unknown): string[] =>
      Array.isArray(v) ? v.map((x) => String(x).toLowerCase().trim()).filter(Boolean).slice(0, 10) : [];
    const dateOrNull = (v: unknown): string | null =>
      typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
    return {
      semanticQuery: typeof p.semanticQuery === "string" && p.semanticQuery.trim() ? p.semanticQuery.trim() : null,
      keywords: arr(p.keywords),
      mediaTypes: arr(p.mediaTypes).filter((t) => ["image", "video", "document", "audio", "archive", "other"].includes(t)),
      dateFrom: dateOrNull(p.dateFrom),
      dateTo: dateOrNull(p.dateTo),
      objects: arr(p.objects),
      exclude: arr(p.exclude),
      favoriteOnly: p.favoriteOnly === true,
      docTypes: arr(p.docTypes),
      location: typeof p.location === "string" && p.location.trim() ? p.location.trim() : null,
    };
  } catch (err) {
    logger.warn({ err, query }, "Intent parsing failed — falling back to keyword search");
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2).slice(0, 8);
    return { ...emptyIntent(), semanticQuery: query, keywords: words };
  }
}

// ── Hybrid execution ──────────────────────────────────────────────────────────

export interface SearchResultItem {
  id: number;
  name: string;
  relativePath: string;
  mediaType: string;
  sizeBytes: number;
  thumbnailPath: string | null;
  dateTaken: string | null;
  favorite: boolean;
  description: string | null;
  confidence: "very_likely" | "likely" | "possible";
  score: number;
  reasons: string[];
}

interface RawRow {
  id: number; name: string; relative_path: string; media_type: string;
  size_bytes: string | number; thumbnail_path: string | null;
  date_taken: Date | null; favorite: boolean;
  description: string | null; tags: unknown; objects: unknown;
  ocr_text: string | null; doc_type: string | null; scene: string | null;
  gps_latitude: number | null; gps_longitude: number | null;
  similarity: number | null;
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x).toLowerCase()) : [];
}

export async function executeSearch(
  nasPath: string,
  intent: SearchIntent,
  limit = 60,
): Promise<SearchResultItem[]> {
  const params: unknown[] = [nasPath];
  const where: string[] = [
    `f.nas_path = $1`,
    `(f.last_scan_action IS NULL OR f.last_scan_action <> 'DELETED')`,
  ];
  const add = (v: unknown): string => { params.push(v); return `$${params.length}`; };

  if (intent.mediaTypes.length) {
    // The library stores photos as "photo"; the intent vocabulary says "image".
    const types = [...new Set(intent.mediaTypes.flatMap((t) => (t === "image" ? ["image", "photo"] : [t])))];
    where.push(`f.media_type = ANY(${add(types)})`);
  }
  if (intent.favoriteOnly) where.push(`f.favorite = true`);
  if (intent.dateFrom) where.push(`COALESCE(f.date_taken, f.modified_at) >= ${add(intent.dateFrom)}`);
  if (intent.dateTo) where.push(`COALESCE(f.date_taken, f.modified_at) <= ${add(intent.dateTo + "T23:59:59")}`);
  if (intent.docTypes.length) where.push(`a.doc_type = ANY(${add(intent.docTypes)})`);

  let simSelect = `NULL::float AS similarity`;
  let orderBy = `f.date_taken DESC NULLS LAST`;
  if (intent.semanticQuery) {
    try {
      const emb = await embedText(intent.semanticQuery);
      if (emb.length) {
        const p = add(toVectorLiteral(emb));
        simSelect = `CASE WHEN a.embedding IS NULL THEN NULL ELSE 1 - (a.embedding <=> ${p}::vector) END AS similarity`;
        orderBy = `similarity DESC NULLS LAST`;
      }
    } catch (err) {
      logger.warn({ err }, "Query embedding failed — continuing without semantic ranking");
    }
  }

  const sql = `
    SELECT f.id, f.name, f.relative_path, f.media_type, f.size_bytes,
           f.thumbnail_path, f.date_taken, f.favorite,
           f.gps_latitude, f.gps_longitude,
           a.description, a.tags, a.objects, a.ocr_text, a.doc_type, a.scene,
           ${simSelect}
      FROM media_files f
      LEFT JOIN media_ai a ON a.media_file_id = f.id
     WHERE ${where.join(" AND ")}
     ORDER BY ${orderBy}
     LIMIT ${Math.min(limit * 4, 400)}`;
  const { rows } = await pool.query(sql, params);

  const scored = (rows as RawRow[])
    .map((r) => scoreRow(r, intent))
    .filter((r): r is SearchResultItem => r !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored;
}

function scoreRow(r: RawRow, intent: SearchIntent): SearchResultItem | null {
  const tags = strArr(r.tags);
  const objects = strArr(r.objects);
  const haystack = [
    r.name, r.relative_path, r.description, r.ocr_text, r.doc_type, r.scene,
    ...tags, ...objects,
  ].filter(Boolean).join(" ").toLowerCase();

  // Exclusions are hard filters.
  for (const ex of intent.exclude) {
    if (haystack.includes(ex)) return null;
  }

  let score = 0;
  const reasons: string[] = [];

  const sim = r.similarity;
  if (sim != null) {
    score += Math.max(0, sim) * 3;
    if (sim >= 0.45) reasons.push("Strong content match");
    else if (sim >= 0.30) reasons.push("Related content");
  }

  for (const obj of intent.objects) {
    if (objects.some((o) => o.includes(obj)) || tags.some((t) => t.includes(obj))) {
      score += 1.5;
      reasons.push(`${cap(obj)} detected`);
    } else if (haystack.includes(obj)) {
      score += 0.7;
      reasons.push(`Mentions "${obj}"`);
    }
  }

  for (const kw of intent.keywords) {
    if (r.name.toLowerCase().includes(kw)) { score += 1; reasons.push(`Name contains "${kw}"`); }
    else if (r.ocr_text?.toLowerCase().includes(kw)) { score += 0.9; reasons.push(`Text mentions "${kw}"`); }
    else if (haystack.includes(kw)) { score += 0.4; }
  }

  if (intent.location) {
    const loc = intent.location.toLowerCase();
    if (haystack.includes(loc)) { score += 1; reasons.push(`Location matches ${intent.location}`); }
    else if (r.gps_latitude != null) { reasons.push("Has GPS data"); score += 0.1; }
  }

  if (intent.dateFrom || intent.dateTo) {
    if (r.date_taken) reasons.push(`Taken ${new Date(r.date_taken).toLocaleDateString("en-US", { month: "short", year: "numeric" })}`);
  }
  if (intent.docTypes.length && r.doc_type && intent.docTypes.includes(r.doc_type)) {
    score += 1.5; reasons.push(`Classified as ${r.doc_type}`);
  }
  if (intent.favoriteOnly && r.favorite) reasons.push("Favorite");

  // If the intent has active signals but this row matched none of them, drop it.
  const hasSignals = !!(intent.semanticQuery || intent.objects.length || intent.keywords.length || intent.location || intent.docTypes.length);
  if (hasSignals && score <= 0.05) return null;
  // Semantic-only floor: keep clearly-unrelated rows out.
  if (intent.semanticQuery && sim != null && sim < 0.15 && score < 1) return null;

  const confidence: SearchResultItem["confidence"] =
    score >= 2.2 ? "very_likely" : score >= 1.1 ? "likely" : "possible";

  return {
    id: r.id,
    name: r.name,
    relativePath: r.relative_path,
    mediaType: r.media_type,
    sizeBytes: Number(r.size_bytes),
    thumbnailPath: r.thumbnail_path,
    dateTaken: r.date_taken ? new Date(r.date_taken).toISOString() : null,
    favorite: r.favorite,
    description: r.description,
    confidence,
    score: Math.round(score * 100) / 100,
    reasons: reasons.slice(0, 5),
  };
}

function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

// ── Empty-result suggestions ──────────────────────────────────────────────────

export function buildNoResultSuggestions(intent: SearchIntent): string[] {
  const out: string[] = [];
  if (intent.dateFrom || intent.dateTo) out.push("Remove the date filter — try searching all time");
  if (intent.mediaTypes.length === 1) out.push(`Search all media instead of just ${intent.mediaTypes[0]}s`);
  if (intent.exclude.length) out.push(`Stop excluding "${intent.exclude[0]}"`);
  if (intent.objects.length > 1) out.push(`Try just "${intent.objects[0]}" on its own`);
  if (intent.location) out.push(`Drop the location "${intent.location}" — many files have no GPS data`);
  if (intent.favoriteOnly) out.push("Include non-favorites too");
  if (!out.length) out.push("Try fewer or more general words", "Browse your collections instead");
  return out.slice(0, 4);
}

// ── Find Similar ──────────────────────────────────────────────────────────────

export async function findSimilar(nasPath: string, fileId: number, limit = 24): Promise<SearchResultItem[]> {
  const { rows } = await pool.query(
    `SELECT f.content_hash, f.media_type, a.embedding IS NOT NULL AS has_embedding
       FROM media_files f LEFT JOIN media_ai a ON a.media_file_id = f.id
      WHERE f.id = $1`,
    [fileId],
  );
  if (!rows.length) throw Object.assign(new Error("File not found"), { statusCode: 404 });
  if (!rows[0].has_embedding) throw Object.assign(new Error("This file hasn't been analyzed yet — try again shortly"), { statusCode: 409 });

  const { rows: sims } = await pool.query(
    `SELECT f.id, f.name, f.relative_path, f.media_type, f.size_bytes,
            f.thumbnail_path, f.date_taken, f.favorite,
            f.gps_latitude, f.gps_longitude,
            a.description, a.tags, a.objects, a.ocr_text, a.doc_type, a.scene,
            1 - (a.embedding <=> (SELECT embedding FROM media_ai WHERE media_file_id = $2)) AS similarity
       FROM media_files f
       JOIN media_ai a ON a.media_file_id = f.id
      WHERE f.nas_path = $1
        AND (f.last_scan_action IS NULL OR f.last_scan_action <> 'DELETED')
        AND f.id <> $2
        AND a.embedding IS NOT NULL
        AND ($3::text IS NULL OR f.content_hash IS NULL OR f.content_hash <> $3)
        AND f.media_type = $4
      ORDER BY similarity DESC
      LIMIT $5`,
    [nasPath, fileId, rows[0].content_hash, rows[0].media_type, limit],
  );
  return (sims as RawRow[]).map((r) => ({
    id: r.id,
    name: r.name,
    relativePath: r.relative_path,
    mediaType: r.media_type,
    sizeBytes: Number(r.size_bytes),
    thumbnailPath: r.thumbnail_path,
    dateTaken: r.date_taken ? new Date(r.date_taken).toISOString() : null,
    favorite: r.favorite,
    description: r.description,
    confidence: (r.similarity ?? 0) >= 0.6 ? "very_likely" : (r.similarity ?? 0) >= 0.45 ? "likely" : "possible",
    score: Math.round((r.similarity ?? 0) * 100) / 100,
    reasons: [`${Math.round((r.similarity ?? 0) * 100)}% similar content`],
  }));
}

// ── Suggestions (before/while typing) ─────────────────────────────────────────

const STARTER_SUGGESTIONS = [
  "Vacation photos",
  "Pictures from last summer",
  "Receipts",
  "Recently added videos",
  "Favorites",
  "Documents about the house",
  "Sunset photos",
  "Screenshots",
];

export async function getSuggestions(nasPath: string, prefix: string | null): Promise<string[]> {
  if (!prefix || prefix.trim().length < 2) {
    return STARTER_SUGGESTIONS;
  }
  const like = `%${prefix.trim().toLowerCase()}%`;
  const { rows } = await pool.query(
    `SELECT DISTINCT term FROM (
       SELECT lower(jsonb_array_elements_text(a.tags)) AS term
         FROM media_ai a JOIN media_files f ON f.id = a.media_file_id WHERE f.nas_path = $1
       UNION
       SELECT lower(jsonb_array_elements_text(a.objects))
         FROM media_ai a JOIN media_files f ON f.id = a.media_file_id WHERE f.nas_path = $1
       UNION
       SELECT lower(a.doc_type) FROM media_ai a JOIN media_files f ON f.id = a.media_file_id
        WHERE f.nas_path = $1 AND a.doc_type IS NOT NULL
       UNION
       SELECT lower(f.name) FROM media_files f WHERE f.nas_path = $1
     ) t WHERE term LIKE $2 ORDER BY term LIMIT 8`,
    [nasPath, like],
  );
  return rows.map((r: { term: string }) => r.term);
}
