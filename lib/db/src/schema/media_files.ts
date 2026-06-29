import { pgTable, serial, text, bigint, integer, real, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const mediaFilesTable = pgTable("media_files", {
  id:                   serial("id").primaryKey(),
  nasPath:              text("nas_path").notNull(),
  relativePath:         text("relative_path").notNull(),
  name:                 text("name").notNull(),
  extension:            text("extension").notNull().default(""),
  mimeType:             text("mime_type").notNull().default(""),
  mediaType:            text("media_type").notNull().default("other"),
  sizeBytes:            bigint("size_bytes", { mode: "number" }).notNull().default(0),
  modifiedAt:           timestamp("modified_at"),
  width:                integer("width"),
  height:               integer("height"),
  durationSeconds:      real("duration_seconds"),
  thumbnailPath:        text("thumbnail_path"),
  thumbnailGeneratedAt: timestamp("thumbnail_generated_at"),
  exifJson:             jsonb("exif_json"),
  contentHash:          text("content_hash"),
  indexedAt:            timestamp("indexed_at").notNull().defaultNow(),
}, (t) => [
  index("media_files_nas_path_idx").on(t.nasPath),
  index("media_files_rel_path_idx").on(t.relativePath),
  index("media_files_media_type_idx").on(t.mediaType),
  index("media_files_content_hash_idx").on(t.contentHash),
]);

export const insertMediaFileSchema = createInsertSchema(mediaFilesTable).omit({ id: true, indexedAt: true });
export type InsertMediaFile = z.infer<typeof insertMediaFileSchema>;
export type MediaFile = typeof mediaFilesTable.$inferSelect;
