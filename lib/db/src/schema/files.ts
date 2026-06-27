import { pgTable, serial, text, bigint, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const indexedFilesTable = pgTable("indexed_files", {
  id: serial("id").primaryKey(),
  path: text("path").notNull().unique(),
  filename: text("filename").notNull(),
  extension: text("extension").notNull().default(""),
  fileType: text("file_type").notNull().default("other"),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
  modifiedAt: timestamp("modified_at"),
  folder: text("folder").notNull().default(""),
  source: text("source").notNull().default("local"),
  contentHash: text("content_hash"),
  indexedAt: timestamp("indexed_at").notNull().defaultNow(),
}, (t) => [
  index("indexed_files_content_hash_idx").on(t.contentHash),
]);

export const insertIndexedFileSchema = createInsertSchema(indexedFilesTable).omit({ id: true, indexedAt: true });
export type InsertIndexedFile = z.infer<typeof insertIndexedFileSchema>;
export type IndexedFile = typeof indexedFilesTable.$inferSelect;
