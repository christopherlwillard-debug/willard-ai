import { pgTable, serial, text, bigint, timestamp, boolean, integer, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const archivesTable = pgTable("archives", {
  id: serial("id").primaryKey(),
  nasPath: text("nas_path"),
  path: text("path").notNull().unique(),
  filename: text("filename").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
  modifiedAt: timestamp("modified_at"),
  folder: text("folder").notNull().default(""),
  containedFileCount: integer("contained_file_count"),
  photoCount: integer("photo_count"),
  videoCount: integer("video_count"),
  documentCount: integer("document_count"),
  category: text("category").notNull().default("general"),
  peekStatus: text("peek_status").notNull().default("pending"),
  isPasswordProtected: boolean("is_password_protected").notNull().default(false),
  hasNestedArchives: boolean("has_nested_archives").notNull().default(false),
  estimatedExtractionSize: bigint("estimated_extraction_size", { mode: "number" }),
  peekEntries: jsonb("peek_entries"),
  indexedAt: timestamp("indexed_at").notNull().defaultNow(),
}, (t) => [
  index("archives_nas_size_idx").on(t.nasPath, t.sizeBytes),
  index("archives_nas_modified_idx").on(t.nasPath, t.modifiedAt),
  index("archives_nas_status_idx").on(t.nasPath, t.peekStatus),
]);

export const insertArchiveSchema = createInsertSchema(archivesTable).omit({ id: true, indexedAt: true });
export type InsertArchive = z.infer<typeof insertArchiveSchema>;
export type Archive = typeof archivesTable.$inferSelect;
