import { pgTable, serial, text, bigint, timestamp, boolean, integer, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const archivesTable = pgTable("archives", {
  id: serial("id").primaryKey(),
  path: text("path").notNull().unique(),
  filename: text("filename").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
  modifiedAt: timestamp("modified_at"),
  folder: text("folder").notNull().default(""),
  containedFileCount: integer("contained_file_count"),
  category: text("category").notNull().default("general"),
  peekStatus: text("peek_status").notNull().default("pending"),
  isPasswordProtected: boolean("is_password_protected").notNull().default(false),
  hasNestedArchives: boolean("has_nested_archives").notNull().default(false),
  estimatedExtractionSize: bigint("estimated_extraction_size", { mode: "number" }),
  peekEntries: jsonb("peek_entries"),
  indexedAt: timestamp("indexed_at").notNull().defaultNow(),
});

export const insertArchiveSchema = createInsertSchema(archivesTable).omit({ id: true, indexedAt: true });
export type InsertArchive = z.infer<typeof insertArchiveSchema>;
export type Archive = typeof archivesTable.$inferSelect;
