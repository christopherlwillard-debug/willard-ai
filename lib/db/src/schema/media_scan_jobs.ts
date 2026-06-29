import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const mediaScanJobsTable = pgTable("media_scan_jobs", {
  id:                  serial("id").primaryKey(),
  status:              text("status").notNull().default("running"),
  nasPath:             text("nas_path").notNull(),
  totalFiles:          integer("total_files").notNull().default(0),
  indexedFiles:        integer("indexed_files").notNull().default(0),
  skippedFiles:        integer("skipped_files").notNull().default(0),
  thumbnailsGenerated: integer("thumbnails_generated").notNull().default(0),
  startedAt:           timestamp("started_at").notNull().defaultNow(),
  finishedAt:          timestamp("finished_at"),
  error:               text("error"),
});

export const insertMediaScanJobSchema = createInsertSchema(mediaScanJobsTable).omit({ id: true, startedAt: true });
export type InsertMediaScanJob = z.infer<typeof insertMediaScanJobSchema>;
export type MediaScanJob = typeof mediaScanJobsTable.$inferSelect;
