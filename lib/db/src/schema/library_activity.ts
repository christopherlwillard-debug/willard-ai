import { pgTable, serial, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const libraryActivityTable = pgTable("library_activity", {
  id:        serial("id").primaryKey(),
  nasPath:   text("nas_path").notNull(),
  kind:      text("kind").notNull(),
  message:   text("message").notNull(),
  details:   jsonb("details"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("library_activity_nas_path_idx").on(t.nasPath),
  index("library_activity_created_at_idx").on(t.createdAt),
]);

export const insertLibraryActivitySchema = createInsertSchema(libraryActivityTable).omit({ id: true, createdAt: true });
export type InsertLibraryActivity = z.infer<typeof insertLibraryActivitySchema>;
export type LibraryActivity = typeof libraryActivityTable.$inferSelect;
