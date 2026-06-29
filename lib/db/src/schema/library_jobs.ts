import { pgTable, serial, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const libraryJobsTable = pgTable("library_jobs", {
  id:                 serial("id").primaryKey(),
  jobType:            text("job_type").notNull(),
  profile:            text("profile"),
  priority:           text("priority").notNull().default("NORMAL"),
  status:             text("status").notNull().default("PENDING"),
  cancellationReason: text("cancellation_reason"),
  nasPath:            text("nas_path").notNull(),
  rootPath:           text("root_path"),
  cursor:             text("cursor"),
  pausedAt:           timestamp("paused_at"),
  startedAt:          timestamp("started_at"),
  finishedAt:         timestamp("finished_at"),
  totalFiles:         integer("total_files"),
  processedFiles:     integer("processed_files").notNull().default(0),
  summary:            jsonb("summary"),
  error:              text("error"),
  createdAt:          timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("library_jobs_nas_path_idx").on(t.nasPath),
  index("library_jobs_status_idx").on(t.status),
  index("library_jobs_job_type_idx").on(t.jobType),
]);

export const insertLibraryJobSchema = createInsertSchema(libraryJobsTable).omit({ id: true, createdAt: true });
export type InsertLibraryJob = z.infer<typeof insertLibraryJobSchema>;
export type LibraryJob = typeof libraryJobsTable.$inferSelect;
