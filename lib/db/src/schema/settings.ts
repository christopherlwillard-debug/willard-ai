import { pgTable, serial, text, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const appSettingsTable = pgTable("app_settings", {
  id: serial("id").primaryKey(),
  nasPath: text("nas_path").notNull().default(""),
  lastScanAt: timestamp("last_scan_at"),
  totalFilesIndexed: integer("total_files_indexed").notNull().default(0),
  passwordHash: text("password_hash"),
  recoveryKeyHash: text("recovery_key_hash"),
  photosDestination: text("photos_destination").notNull().default(""),
  videosDestination: text("videos_destination").notNull().default(""),
  documentsDestination: text("documents_destination").notNull().default(""),
  otherFilesDestination: text("other_files_destination").notNull().default(""),
  logoPath: text("logo_path"),
  scanPerformance: text("scan_performance").notNull().default("BALANCED"),
  thumbnailQuality: text("thumbnail_quality").notNull().default("BALANCED"),
  indexingPaused: boolean("indexing_paused").notNull().default(false),
  onboardingDismissedAt: timestamp("onboarding_dismissed_at"),
  celebrationShownAt: timestamp("celebration_shown_at"),
  ignoredFolders:    text("ignored_folders").array().notNull().default([]),
  ignoredExtensions: text("ignored_extensions").array().notNull().default([]),
  ignoreHiddenFiles:  boolean("ignore_hidden_files").notNull().default(true),
  ignoreSystemFiles:  boolean("ignore_system_files").notNull().default(true),
  ignoreTempFiles:    boolean("ignore_temp_files").notNull().default(true),
  ignoreSidecarFiles: boolean("ignore_sidecar_files").notNull().default(true),
  ignoreEmptyFolders: boolean("ignore_empty_folders").notNull().default(false),
  followSymlinks:     boolean("follow_symlinks").notNull().default(false),
  indexOtherFiles:    boolean("index_other_files").notNull().default(true),
  watcherPollIntervalSeconds: integer("watcher_poll_interval_seconds").notNull().default(60),
});

export const insertAppSettingsSchema = createInsertSchema(appSettingsTable).omit({ id: true });
export type InsertAppSettings = z.infer<typeof insertAppSettingsSchema>;
export type AppSettings = typeof appSettingsTable.$inferSelect;
