import { pgTable, serial, text, integer, timestamp, index, uniqueIndex, jsonb, customType } from "drizzle-orm/pg-core";

/**
 * pgvector column. Stored as `vector(384)` (all-MiniLM-L6-v2, computed
 * locally via transformers.js — privacy-first, nothing leaves the machine).
 * Read/written as a JSON-style number array string: "[0.1,0.2,...]".
 */
const vector384 = customType<{ data: string }>({
  dataType() {
    return "vector(384)";
  },
});

/**
 * AI-derived understanding of a media file. Exactly one row per media file
 * (single source of truth: media_files is canonical, this is derived and
 * rebuildable). Populated by the AI enrichment engine.
 */
export const mediaAiTable = pgTable("media_ai", {
  id:           serial("id").primaryKey(),
  mediaFileId:  integer("media_file_id").notNull(),

  // ── Vision / document understanding ────────────────────────────────────────
  description:  text("description"),            // one-sentence natural description
  tags:         jsonb("tags"),                  // string[] — scene/content tags
  objects:      jsonb("objects"),               // string[] — detected objects
  ocrText:      text("ocr_text"),               // visible/extracted text
  docType:      text("doc_type"),               // receipt, invoice, manual, letter…
  scene:        text("scene"),                  // outdoor, beach, city, sunset…
  people:       jsonb("people"),                // string[] — person descriptors ("man in red jacket")

  // ── User corrections & annotations (never overwritten by re-enrichment) ────
  userTags:        jsonb("user_tags"),          // string[] — tags the user added
  hiddenTags:      jsonb("hidden_tags"),        // string[] — AI tags the user removed (original preserved in tags)
  userDescription: text("user_description"),    // user-corrected description (AI original kept in description)
  notes:           text("notes"),               // free-text user notes, searchable

  // ── Semantic embedding ─────────────────────────────────────────────────────
  embedding:    vector384("embedding"),

  aiVersion:    integer("ai_version").notNull().default(1),
  analyzedAt:   timestamp("analyzed_at"),
  error:        text("error"),                  // last enrichment error, null when ok
}, (t) => [
  uniqueIndex("media_ai_file_idx").on(t.mediaFileId),
]);

/** Recent searches — one row per executed search, pruned to a small cap. */
export const searchHistoryTable = pgTable("search_history", {
  id:         serial("id").primaryKey(),
  query:      text("query").notNull(),
  intentJson: jsonb("intent_json"),
  resultCount: integer("result_count").notNull().default(0),
  createdAt:  timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("search_history_created_idx").on(t.createdAt),
]);

/** Saved searches — reusable dynamic searches (smart-folder-like). */
export const savedSearchesTable = pgTable("saved_searches", {
  id:         serial("id").primaryKey(),
  name:       text("name").notNull(),
  query:      text("query").notNull(),
  intentJson: jsonb("intent_json"),
  createdAt:  timestamp("created_at").notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at"),
});

export type MediaAiRow = typeof mediaAiTable.$inferSelect;
export type SearchHistoryRow = typeof searchHistoryTable.$inferSelect;
export type SavedSearchRow = typeof savedSearchesTable.$inferSelect;
