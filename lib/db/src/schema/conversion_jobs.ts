import { pgTable, serial, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";

export const conversionJobsTable = pgTable("conversion_jobs", {
  id:              serial("id").primaryKey(),
  status:          text("status").notNull().default("pending"),
  approvedExts:    jsonb("approved_exts").notNull(),
  backupDir:       text("backup_dir"),
  nasPath:         text("nas_path").notNull(),
  totalFiles:      integer("total_files").notNull().default(0),
  processedFiles:  integer("processed_files").notNull().default(0),
  succeededFiles:  integer("succeeded_files").notNull().default(0),
  failedFiles:     integer("failed_files").notNull().default(0),
  skippedFiles:    integer("skipped_files").notNull().default(0),
  resultJson:      jsonb("result_json"),
  error:           text("error"),
  createdAt:       timestamp("created_at").notNull().defaultNow(),
  completedAt:     timestamp("completed_at"),
});

export type ConversionJob = typeof conversionJobsTable.$inferSelect;
