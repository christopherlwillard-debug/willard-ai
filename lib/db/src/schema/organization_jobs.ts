import { pgTable, serial, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const organizationJobsTable = pgTable("organization_jobs", {
  id: serial("id").primaryKey(),
  status: text("status").notNull().default("pending"),
  sourceType: text("source_type").notNull(),
  sourcePath: text("source_path").notNull(),
  archiveId: integer("archive_id"),
  archiveDisposition: text("archive_disposition").notNull().default("keep"),
  planJson: jsonb("plan_json"),
  preflightJson: jsonb("preflight_json"),
  fileMoves: jsonb("file_moves"),
  reportJson: jsonb("report_json"),
  reportPath: text("report_path"),
  error: text("error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

export const insertOrganizationJobSchema = createInsertSchema(organizationJobsTable).omit({ id: true, createdAt: true });
export type InsertOrganizationJob = z.infer<typeof insertOrganizationJobSchema>;
export type OrganizationJob = typeof organizationJobsTable.$inferSelect;
