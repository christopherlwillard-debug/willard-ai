import { Router, type IRouter } from "express";
import { db, pool, appSettingsTable } from "@workspace/db";
import {
  parseIntent, executeSearch, findSimilar, getSuggestions,
  buildNoResultSuggestions, emptyIntent, type SearchIntent,
} from "../lib/ai-search";
import { getEnrichmentStatus } from "../lib/ai-enrichment";
import { logger } from "../lib/logger";

const router: IRouter = Router();

async function getNasPath(): Promise<string | null> {
  const [row] = await db.select({ nasPath: appSettingsTable.nasPath }).from(appSettingsTable).limit(1);
  const p = row?.nasPath?.trim();
  return p ? p : null;
}

function sanitizeIntent(raw: unknown): SearchIntent | null {
  if (!raw || typeof raw !== "object") return null;
  const base = emptyIntent();
  const o = raw as Record<string, unknown>;
  const arr = (v: unknown) => Array.isArray(v) ? v.map(String).slice(0, 10) : [];
  return {
    ...base,
    semanticQuery: typeof o.semanticQuery === "string" ? o.semanticQuery : null,
    keywords: arr(o.keywords),
    mediaTypes: arr(o.mediaTypes),
    dateFrom: typeof o.dateFrom === "string" ? o.dateFrom : null,
    dateTo: typeof o.dateTo === "string" ? o.dateTo : null,
    objects: arr(o.objects),
    exclude: arr(o.exclude),
    favoriteOnly: o.favoriteOnly === true,
    docTypes: arr(o.docTypes),
    location: typeof o.location === "string" ? o.location : null,
  };
}

// ── Conversational hybrid search ──────────────────────────────────────────────

router.post("/search/ai", async (req, res) => {
  try {
    const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
    if (!query) return res.status(400).json({ error: "query is required" });
    const previousIntent = sanitizeIntent(req.body?.previousIntent);
    const refine = req.body?.refine === true && previousIntent !== null;

    const nasPath = await getNasPath();
    if (!nasPath) return res.status(409).json({ error: "No library configured" });

    const intent = await parseIntent(query, refine ? previousIntent : null);

    // Conventional filters cooperate with natural language: explicit UI
    // filters override whatever the language parse inferred.
    const f = req.body?.filters;
    if (f && typeof f === "object") {
      if (Array.isArray(f.mediaTypes) && f.mediaTypes.length) {
        intent.mediaTypes = f.mediaTypes.map(String).slice(0, 6);
      }
      if (f.favoriteOnly === true) intent.favoriteOnly = true;
      if (typeof f.dateFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f.dateFrom)) intent.dateFrom = f.dateFrom;
      if (typeof f.dateTo === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f.dateTo)) intent.dateTo = f.dateTo;
    }

    const results = await executeSearch(nasPath, intent);

    // Record history (best-effort, pruned to 50).
    pool.query(
      `INSERT INTO search_history (query, intent_json, result_count) VALUES ($1, $2, $3)`,
      [query, JSON.stringify(intent), results.length],
    ).then(() => pool.query(
      `DELETE FROM search_history WHERE id NOT IN (SELECT id FROM search_history ORDER BY created_at DESC LIMIT 50)`,
    )).catch(() => {});

    const enrichment = getEnrichmentStatus();
    return res.json({
      query,
      refined: refine,
      intent,
      results,
      suggestions: results.length === 0 ? buildNoResultSuggestions(intent) : [],
      enrichmentPending: enrichment.pending,
    });
  } catch (err) {
    logger.error({ err }, "AI search failed");
    return res.status(500).json({ error: "Search failed — please try again" });
  }
});

// ── Find Similar ──────────────────────────────────────────────────────────────

router.get("/search/similar/:id", async (req, res) => {
  try {
    const fileId = Number(req.params.id);
    if (!Number.isInteger(fileId)) return res.status(400).json({ error: "Invalid file id" });
    const nasPath = await getNasPath();
    if (!nasPath) return res.status(409).json({ error: "No library configured" });
    const results = await findSimilar(nasPath, fileId);
    return res.json({ results });
  } catch (err) {
    const sc = (err as { statusCode?: number }).statusCode;
    if (sc) return res.status(sc).json({ error: (err as Error).message });
    logger.error({ err }, "Similar search failed");
    return res.status(500).json({ error: "Similar search failed" });
  }
});

// ── Suggestions ───────────────────────────────────────────────────────────────

router.get("/search/suggestions", async (req, res) => {
  try {
    const nasPath = await getNasPath();
    if (!nasPath) return res.json({ suggestions: [] });
    const q = typeof req.query.q === "string" ? req.query.q : null;
    return res.json({ suggestions: await getSuggestions(nasPath, q) });
  } catch (err) {
    logger.warn({ err }, "Suggestions failed");
    return res.json({ suggestions: [] });
  }
});

// ── History ───────────────────────────────────────────────────────────────────

router.get("/search/history", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, query, result_count, created_at FROM search_history ORDER BY created_at DESC LIMIT 10`,
  );
  res.json({
    history: rows.map((r: any) => ({
      id: r.id, query: r.query, resultCount: r.result_count, createdAt: new Date(r.created_at).toISOString(),
    })),
  });
});

router.delete("/search/history", async (_req, res) => {
  await pool.query(`DELETE FROM search_history`);
  res.json({ ok: true });
});

// ── Saved searches ────────────────────────────────────────────────────────────

router.get("/search/saved", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, query, intent_json, created_at, last_used_at FROM saved_searches ORDER BY created_at DESC LIMIT 50`,
  );
  res.json({
    saved: rows.map((r: any) => ({
      id: r.id, name: r.name, query: r.query, intent: r.intent_json,
      createdAt: new Date(r.created_at).toISOString(),
      lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
    })),
  });
});

router.post("/search/saved", async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  if (!name || !query) return res.status(400).json({ error: "name and query are required" });
  const intent = sanitizeIntent(req.body?.intent);
  const { rows } = await pool.query(
    `INSERT INTO saved_searches (name, query, intent_json) VALUES ($1,$2,$3) RETURNING id`,
    [name.slice(0, 100), query.slice(0, 500), intent ? JSON.stringify(intent) : null],
  );
  return res.json({ id: rows[0].id, ok: true });
});

router.post("/search/saved/:id/run", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query(`SELECT query, intent_json FROM saved_searches WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: "Saved search not found" });
    const nasPath = await getNasPath();
    if (!nasPath) return res.status(409).json({ error: "No library configured" });
    // Saved searches stay current: re-parse if no stored intent, else reuse it.
    const stored = sanitizeIntent(rows[0].intent_json);
    const intent = stored ?? await parseIntent(rows[0].query, null);
    const results = await executeSearch(nasPath, intent);
    pool.query(`UPDATE saved_searches SET last_used_at = now() WHERE id = $1`, [id]).catch(() => {});
    return res.json({
      query: rows[0].query, intent, results,
      suggestions: results.length === 0 ? buildNoResultSuggestions(intent) : [],
    });
  } catch (err) {
    logger.error({ err }, "Saved search run failed");
    return res.status(500).json({ error: "Saved search failed" });
  }
});

router.delete("/search/saved/:id", async (req, res) => {
  await pool.query(`DELETE FROM saved_searches WHERE id = $1`, [Number(req.params.id)]);
  res.json({ ok: true });
});

// ── Enrichment status (how much of the library is AI-analyzed) ───────────────

router.get("/search/ai-status", async (_req, res) => {
  const nasPath = await getNasPath();
  let analyzedCount = 0, totalCount = 0;
  if (nasPath) {
    const { rows } = await pool.query(
      `SELECT count(*) FILTER (WHERE a.id IS NOT NULL AND a.analyzed_at IS NOT NULL) AS analyzed,
              count(*) AS total
         FROM media_files f
         LEFT JOIN media_ai a ON a.media_file_id = f.id
        WHERE f.nas_path = $1 AND (f.last_scan_action IS NULL OR f.last_scan_action <> 'DELETED')`,
      [nasPath],
    );
    analyzedCount = Number(rows[0].analyzed);
    totalCount = Number(rows[0].total);
  }
  res.json({ ...getEnrichmentStatus(), analyzedCount, totalCount });
});

export default router;
