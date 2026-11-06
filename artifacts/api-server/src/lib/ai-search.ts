import { pool } from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { embedText, toVectorLiteral } from "./ai-enrichment.ts";
import { logger } from "./logger.ts";
import { escapeLikePattern } from "./sql-like.ts";
import { isVectorAvailable } from "./vector-capability.ts";
import { activeMediaSql } from "./media-scope.ts";
import { normalizeOptionalDateOnlyRange, parseOptionalDateOnlyRange } from "./request-validation.ts";

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
  personNames: string[];          // named face clusters matched directly
}

export function emptyIntent(): SearchIntent {
  return {
    semanticQuery: null, keywords: [], mediaTypes: [], dateFrom: null, dateTo: null,
    objects: [], exclude: [], favoriteOnly: false, docTypes: [], location: null, personNames: [],
  };
}

export interface SearchIntentClear {
  semanticQuery?: boolean;
  keywords?: boolean;
  mediaTypes?: boolean;
  dateRange?: boolean;
  objects?: boolean;
  exclude?: string[];
  excludeAll?: boolean;
  favoriteOnly?: boolean;
  docTypes?: boolean;
  location?: boolean;
  personNames?: boolean;
}

export function mergeRefinedIntent(
  previous: SearchIntent,
  refinement: SearchIntent,
  clear: SearchIntentClear = {},
): SearchIntent {
  const removedExclusions = new Set((clear.exclude ?? []).map((value) => value.toLowerCase()));
  const exclude = clear.excludeAll
    ? refinement.exclude
    : [...new Set([
        ...previous.exclude.filter((value) => !removedExclusions.has(value.toLowerCase())),
        ...refinement.exclude,
      ])];
  return {
    semanticQuery: clear.semanticQuery ? refinement.semanticQuery : refinement.semanticQuery ?? previous.semanticQuery,
    keywords: clear.keywords ? refinement.keywords : [...new Set([...previous.keywords, ...refinement.keywords])],
    mediaTypes: clear.mediaTypes ? refinement.mediaTypes : refinement.mediaTypes.length ? refinement.mediaTypes : previous.mediaTypes,
    dateFrom: clear.dateRange ? refinement.dateFrom : refinement.dateFrom ?? previous.dateFrom,
    dateTo: clear.dateRange ? refinement.dateTo : refinement.dateTo ?? previous.dateTo,
    objects: clear.objects ? refinement.objects : [...new Set([...previous.objects, ...refinement.objects])],
    exclude,
    favoriteOnly: clear.favoriteOnly ? refinement.favoriteOnly : previous.favoriteOnly || refinement.favoriteOnly,
    docTypes: clear.docTypes ? refinement.docTypes : [...new Set([...previous.docTypes, ...refinement.docTypes])],
    location: clear.location ? refinement.location : refinement.location ?? previous.location,
    personNames: clear.personNames ? refinement.personNames : [...new Set([...previous.personNames, ...refinement.personNames])],
  };
}

export function localSearchClearFilters(query: string): SearchIntentClear {
  const normalized = query.trim().toLowerCase();
  const clear: SearchIntentClear = {};
  if (/^remove the date filter\b/.test(normalized)) clear.dateRange = true;
  if (/^search all media\b/.test(normalized)) clear.mediaTypes = true;
  if (/^include non[- ]favorites\b/.test(normalized)) clear.favoriteOnly = true;
  if (/^drop the location\b/.test(normalized)) clear.location = true;
  if (/^stop excluding (?:everything|all)\b/.test(normalized)) {
    clear.excludeAll = true;
  } else {
    const exclusion = query.trim().match(/^stop excluding\s+["']?(.+?)["']?\s*$/i);
    if (exclusion?.[1]) clear.exclude = [exclusion[1].trim().toLowerCase()];
  }
  if (/^try just\b/.test(normalized) && /\bon its own\s*$/.test(normalized)) {
    clear.objects = true;
    clear.keywords = true;
    clear.semanticQuery = true;
  }
  return clear;
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
 "location": "place name or null",
 "clearFilters": {
   "semanticQuery": false, "keywords": false, "mediaTypes": false, "dateRange": false,
   "objects": false, "exclude": [], "excludeAll": false, "favoriteOnly": false,
   "docTypes": false, "location": false, "personNames": false
 }}

Rules:
- "pictures"/"photos" → mediaTypes ["image"]; "videos" → ["video"]; "PDFs"/"documents"/"receipts" → ["document"].
- Resolve relative dates ("last summer", "2024") into dateFrom/dateTo using today's date.
- When refining, merge constraints by default. Set clearFilters.dateRange when the user removes the date filter; clearFilters.mediaTypes when they ask for all media; clearFilters.favoriteOnly when they include non-favorites; clearFilters.exclude to the exact exclusions they want removed; set clearFilters.excludeAll to remove every exclusion; set clearFilters.objects when they ask to keep only the newly parsed objects; and use the matching clearFilters field when they explicitly remove another constraint.
- Leave every clearFilters field false/empty unless the user explicitly asks to remove or replace that constraint.
- A completely new topic should replace the previous semanticQuery and keywords and clear any obsolete constraints.
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
    const dates = normalizeOptionalDateOnlyRange(p.dateFrom, p.dateTo);
    const parsed: SearchIntent = {
      semanticQuery: typeof p.semanticQuery === "string" && p.semanticQuery.trim() ? p.semanticQuery.trim() : null,
      keywords: arr(p.keywords),
      mediaTypes: arr(p.mediaTypes).filter((t) => ["image", "video", "document", "audio", "archive", "other"].includes(t)),
      dateFrom: dates.dateFrom,
      dateTo: dates.dateTo,
      objects: arr(p.objects),
      exclude: arr(p.exclude),
      favoriteOnly: p.favoriteOnly === true,
      docTypes: arr(p.docTypes),
      location: typeof p.location === "string" && p.location.trim() ? p.location.trim() : null,
      personNames: [],
    };
    // Built-in no-result suggestions must work even if the model omits or
    // misstates a clear flag. These exact UI actions are deterministic.
    const localClear: SearchIntentClear = previous ? localSearchClearFilters(query) : {};
    const objectMatch = query.trim().match(/^try just\s+["']?(.+?)["']?\s+on its own\s*$/i);
    const objectName = objectMatch?.[1]?.trim().toLowerCase();
    if (localClear.dateRange) {
      parsed.dateFrom = null;
      parsed.dateTo = null;
    }
    if (localClear.mediaTypes) parsed.mediaTypes = [];
    if (localClear.favoriteOnly) parsed.favoriteOnly = false;
    if (localClear.location) parsed.location = null;
    if (localClear.excludeAll) parsed.exclude = [];
    else if (localClear.exclude?.length) {
      const removed = new Set(localClear.exclude);
      parsed.exclude = parsed.exclude.filter((value) => !removed.has(value));
    }
    if (localClear.objects && objectName) {
      parsed.semanticQuery = objectName;
      parsed.keywords = [objectName];
      parsed.objects = [objectName];
    }
    const rawClear = p.clearFilters && typeof p.clearFilters === "object"
      ? p.clearFilters as Record<string, unknown>
      : {};
    const clear: SearchIntentClear = {
      semanticQuery: rawClear.semanticQuery === true,
      keywords: rawClear.keywords === true,
      mediaTypes: rawClear.mediaTypes === true,
      dateRange: rawClear.dateRange === true,
      objects: rawClear.objects === true,
      exclude: arr(rawClear.exclude),
      excludeAll: rawClear.excludeAll === true,
      favoriteOnly: rawClear.favoriteOnly === true,
      docTypes: rawClear.docTypes === true,
      location: rawClear.location === true,
      personNames: rawClear.personNames === true,
    };
    const effectiveClear: SearchIntentClear = {
      ...clear,
      ...localClear,
      exclude: [...(clear.exclude ?? []), ...(localClear.exclude ?? [])],
    };
    const merged = previous ? mergeRefinedIntent(previous, parsed, effectiveClear) : parsed;
    return { ...merged, ...normalizeOptionalDateOnlyRange(merged.dateFrom, merged.dateTo) };
  } catch (err) {
    logger.warn({ err, query }, "Intent parsing failed — falling back to keyword search");
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2).slice(0, 8);
    const clear: SearchIntentClear = previous ? localSearchClearFilters(query) : {};
    const hasClearAction = Object.values(clear).some((value) => value === true || (Array.isArray(value) && value.length > 0));
    const objectMatch = query.trim().match(/^try just\s+["']?(.+?)["']?\s+on its own\s*$/i);
    const objectName = objectMatch?.[1]?.trim().toLowerCase();
    const fallback: SearchIntent = hasClearAction
      ? objectName
        ? { ...emptyIntent(), semanticQuery: objectName, keywords: [objectName], objects: [objectName] }
        : emptyIntent()
      : { ...emptyIntent(), semanticQuery: query, keywords: words };
    return previous ? mergeRefinedIntent(previous, fallback, clear) : fallback;
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

export interface RawRow {
  id: number; name: string; relative_path: string; media_type: string;
  size_bytes: string | number; thumbnail_path: string | null;
  date_taken: Date | null; favorite: boolean;
  description: string | null; tags: unknown; objects: unknown;
  ocr_text: string | null; doc_type: string | null; scene: string | null;
  people: unknown; user_tags: unknown; hidden_tags: unknown;
  person_names?: unknown;
  user_description: string | null; notes: string | null;
  gps_latitude: number | null; gps_longitude: number | null;
  place_name: string | null;
  similarity: number | null;
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x).toLowerCase()) : [];
}

export function normalizedMediaTypes(mediaTypes: string[]): string[] {
  return [...new Set(mediaTypes.flatMap((t) => (t === "image" ? ["image", "photo"] : [t])))];
}

export interface SearchQuery {
  sql: string;
  params: unknown[];
}

export function buildSearchQuery(
  nasPath: string,
  intent: SearchIntent,
  limit = 60,
  vectorLiteral: string | null = null,
): SearchQuery {
  const params: unknown[] = [nasPath];
  const where: string[] = [
    `f.nas_path = $1`,
    activeMediaSql("f"),
  ];
  const add = (v: unknown): string => { params.push(v); return `$${params.length}`; };
  const dateRange = parseOptionalDateOnlyRange(intent.dateFrom ?? undefined, intent.dateTo ?? undefined);

  if (intent.mediaTypes.length) {
    where.push(`f.media_type = ANY(${add(normalizedMediaTypes(intent.mediaTypes))})`);
  }
  if (intent.favoriteOnly) where.push(`f.favorite = true`);
  if (dateRange.from) {
    where.push(`COALESCE(f.date_taken, f.modified_at) >= ${add(dateRange.from.toISOString().slice(0, 10))}`);
  }
  if (dateRange.toExclusive) {
    where.push(`COALESCE(f.date_taken, f.modified_at) < ${add(dateRange.toExclusive.toISOString().slice(0, 10))}`);
  }
  if (intent.docTypes.length) where.push(`a.doc_type = ANY(${add(intent.docTypes)})`);
  if (intent.personNames.length) {
    const personNames = add(intent.personNames.map((name) => name.toLowerCase()));
    where.push(`EXISTS (
      SELECT 1
        FROM faces face_match
        JOIN people person_match ON person_match.id = face_match.person_id
       WHERE face_match.media_file_id = f.id
         AND person_match.nas_path = $1
         AND person_match.hidden = false
         AND lower(person_match.name) = ANY(${personNames}::text[])
    )`);
  }

  const vectorParam = vectorLiteral ? add(vectorLiteral) : null;
  const simSelect = vectorParam
    ? `CASE WHEN a.embedding IS NULL THEN NULL ELSE 1 - (a.embedding <=> ${vectorParam}::vector) END AS similarity`
    : `NULL::float AS similarity`;
  return {
    sql: `
    SELECT f.id, f.name, f.relative_path, f.media_type, f.size_bytes,
           f.thumbnail_path, f.date_taken, f.favorite,
           f.gps_latitude, f.gps_longitude, f.place_name,
           a.description, a.tags, a.objects, a.ocr_text, a.doc_type, a.scene,
           a.people, a.user_tags, a.hidden_tags, a.user_description, a.notes,
            COALESCE((
              SELECT array_agg(DISTINCT lower(pm.name))
                FROM faces fm
                JOIN people pm ON pm.id = fm.person_id
               WHERE fm.media_file_id = f.id
                 AND pm.nas_path = f.nas_path
                 AND pm.hidden = false
                 AND pm.name IS NOT NULL
            ), ARRAY[]::text[]) AS person_names,
           ${simSelect}
      FROM media_files f
      LEFT JOIN media_ai a ON a.media_file_id = f.id
     WHERE ${where.join(" AND ")}
      ORDER BY ${vectorParam
        ? `a.embedding <=> ${vectorParam}::vector ASC NULLS LAST`
        : "f.date_taken DESC NULLS LAST"}
     LIMIT ${Math.min(limit * 4, 400)}`,
    params,
  };
}

export async function executeSearch(
  nasPath: string,
  intent: SearchIntent,
  limit = 60,
): Promise<SearchResultItem[]> {
  let vectorLiteral: string | null = null;
  if (intent.semanticQuery && isVectorAvailable()) {
    try {
      const emb = await embedText(intent.semanticQuery);
      if (emb.length) vectorLiteral = toVectorLiteral(emb);
    } catch (err) {
      logger.warn({ err }, "Query embedding failed — continuing without semantic ranking");
    }
  }

  const query = buildSearchQuery(nasPath, intent, limit, vectorLiteral);
  const { rows } = await pool.query(query.sql, query.params);

  const scored = (rows as RawRow[])
    .map((r) => scoreRow(r, intent))
    .filter((r): r is SearchResultItem => r !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored;
}

export function scoreRow(r: RawRow, intent: SearchIntent): SearchResultItem | null {
  // Effective tags: AI tags minus user-hidden ones, plus user-added ones.
  const hidden = new Set(strArr(r.hidden_tags));
  const tags = [...strArr(r.tags).filter((t) => !hidden.has(t)), ...strArr(r.user_tags)];
  const objects = strArr(r.objects);
  const people = strArr(r.people);
  const personNames = strArr(r.person_names);
  const haystack = [
    r.name, r.relative_path, r.user_description ?? r.description, r.notes,
    r.ocr_text, r.doc_type, r.scene, r.place_name,
    ...tags, ...objects, ...people, ...personNames,
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
    else if (r.notes?.toLowerCase().includes(kw)) { score += 1; reasons.push(`Your note mentions "${kw}"`); }
    else if (r.ocr_text?.toLowerCase().includes(kw)) { score += 0.9; reasons.push(`Text mentions "${kw}"`); }
    else if (haystack.includes(kw)) { score += 0.4; }
  }

  for (const personName of intent.personNames) {
    if (personNames.includes(personName.toLowerCase())) {
      score += 2;
      reasons.push(`Person: ${cap(personName)}`);
    }
  }

  if (intent.location) {
    const loc = intent.location.toLowerCase();
    if (r.place_name && r.place_name.toLowerCase().includes(loc)) { score += 1.5; reasons.push(`Taken in ${r.place_name}`); }
    else if (haystack.includes(loc)) { score += 1; reasons.push(`Location matches ${intent.location}`); }
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
  const hasSignals = !!(intent.semanticQuery || intent.objects.length || intent.keywords.length || intent.location || intent.docTypes.length || intent.personNames.length);
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
    description: r.user_description ?? r.description,
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
  if (!isVectorAvailable()) return [];
  const { rows } = await pool.query(
    `SELECT f.content_hash, f.media_type, a.embedding IS NOT NULL AS has_embedding
            , a.embedding::text AS embedding
       FROM media_files f LEFT JOIN media_ai a ON a.media_file_id = f.id
      WHERE f.id = $1
        AND f.nas_path = $2
         AND ${activeMediaSql("f")}`,
    [fileId, nasPath],
  );
  if (!rows.length) throw Object.assign(new Error("File not found"), { statusCode: 404 });
  if (!rows[0].has_embedding) throw Object.assign(new Error("This file hasn't been analyzed yet — try again shortly"), { statusCode: 409 });

  const { rows: sims } = await pool.query(
    `SELECT f.id, f.name, f.relative_path, f.media_type, f.size_bytes,
            f.thumbnail_path, f.date_taken, f.favorite,
            f.gps_latitude, f.gps_longitude, f.place_name,
            a.description, a.tags, a.objects, a.ocr_text, a.doc_type, a.scene,
            a.people, a.user_tags, a.hidden_tags, a.user_description, a.notes,
            1 - (a.embedding <=> $2::vector) AS similarity
       FROM media_files f
       JOIN media_ai a ON a.media_file_id = f.id
      WHERE f.nas_path = $1
        AND ${activeMediaSql("f")}
        AND f.id <> $2
        AND a.embedding IS NOT NULL
        AND ($3::text IS NULL OR f.content_hash IS NULL OR f.content_hash <> $3)
        AND f.media_type = $4
      ORDER BY a.embedding <=> $2::vector ASC
      LIMIT $5`,
    [nasPath, rows[0].embedding, rows[0].content_hash, rows[0].media_type, limit],
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
    description: r.user_description ?? r.description,
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

export function buildSuggestionPattern(prefix: string): string {
  return `%${escapeLikePattern(prefix.trim().toLowerCase())}%`;
}

export async function getSuggestions(nasPath: string, prefix: string | null): Promise<string[]> {
  if (!prefix || prefix.trim().length < 2) {
    return STARTER_SUGGESTIONS;
  }
  const like = buildSuggestionPattern(prefix);
  const { rows } = await pool.query(
    `SELECT DISTINCT term FROM (
       SELECT lower(jsonb_array_elements_text(a.tags)) AS term
         FROM media_ai a JOIN media_files f ON f.id = a.media_file_id WHERE f.nas_path = $1
           AND ${activeMediaSql("f")}
       UNION
       SELECT lower(jsonb_array_elements_text(a.objects))
          FROM media_ai a JOIN media_files f ON f.id = a.media_file_id WHERE f.nas_path = $1
           AND ${activeMediaSql("f")}
       UNION
       SELECT lower(a.doc_type) FROM media_ai a JOIN media_files f ON f.id = a.media_file_id
         WHERE f.nas_path = $1 AND ${activeMediaSql("f")} AND a.doc_type IS NOT NULL
       UNION
        SELECT lower(f.name) FROM media_files f WHERE f.nas_path = $1 AND ${activeMediaSql("f")}
       UNION
       SELECT lower(p.name) FROM people p
         WHERE p.nas_path = $1 AND p.hidden = false AND p.name IS NOT NULL
           AND EXISTS (
             SELECT 1
               FROM faces face_suggestion
               JOIN media_files mf_suggestion ON mf_suggestion.id = face_suggestion.media_file_id
              WHERE face_suggestion.person_id = p.id
                AND mf_suggestion.nas_path = $1
                AND ${activeMediaSql("mf_suggestion")}
           )
     ) t WHERE term LIKE $2 ESCAPE E'\\\\' ORDER BY term LIMIT 8`,
    [nasPath, like],
  );
  return rows.map((r: { term: string }) => r.term);
}
