import { pgTable, serial, text, integer, timestamp, index, uniqueIndex, primaryKey } from "drizzle-orm/pg-core";

import { mediaFilesTable } from "./media_files.ts";

export const mediaTagsTable = pgTable("media_tags", {
  id: serial("id").primaryKey(),
  nasPath: text("nas_path").notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("media_tags_nas_name_unique").on(t.nasPath, t.name),
  index("media_tags_nas_path_idx").on(t.nasPath),
]);

export const mediaFileTagsTable = pgTable("media_file_tags", {
  mediaFileId: integer("media_file_id").notNull().references(() => mediaFilesTable.id, { onDelete: "cascade" }),
  tagId: integer("tag_id").notNull().references(() => mediaTagsTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.mediaFileId, t.tagId], name: "media_file_tags_pkey" }),
  index("media_file_tags_tag_idx").on(t.tagId),
]);

export type MediaTag = typeof mediaTagsTable.$inferSelect;