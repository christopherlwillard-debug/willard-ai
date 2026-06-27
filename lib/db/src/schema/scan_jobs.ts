import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const scanJobsTable = pgTable("scan_jobs", {
  id: serial("id").primaryKey(),
  status: text("status").notNull().default("idle"),
  filesScanned: integer("files_scanned").notNull().default(0),
  totalFiles: integer("total_files"),
  stage: text("stage").notNull().default(""),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
  error: text("error"),
});

export const insertScanJobSchema = createInsertSchema(scanJobsTable).omit({ id: true });
export type InsertScanJob = z.infer<typeof insertScanJobSchema>;
export type ScanJob = typeof scanJobsTable.$inferSelect;
