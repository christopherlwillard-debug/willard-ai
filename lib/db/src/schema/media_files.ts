import { pgTable, serial, text, bigint, integer, real, timestamp, index, uniqueIndex, jsonb, boolean } from "drizzle-orm/pg-core";
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

  // ── Dimensions & duration ──────────────────────────────────────────────────
  width:                integer("width"),
  height:               integer("height"),
  durationSeconds:      real("duration_seconds"),
  orientation:          integer("orientation"),

  // ── Thumbnail ──────────────────────────────────────────────────────────────
  thumbnailPath:        text("thumbnail_path"),
  thumbnailGeneratedAt: timestamp("thumbnail_generated_at"),

  // ── Photo EXIF ────────────────────────────────────────────────────────────
  dateTaken:            timestamp("date_taken"),
  cameraMake:           text("camera_make"),
  cameraModel:          text("camera_model"),
  lens:                 text("lens"),
  iso:                  integer("iso"),
  aperture:             real("aperture"),
  exposure:             text("exposure"),
  focalLength:          real("focal_length"),
  flash:                text("flash"),
  colorProfile:         text("color_profile"),
  gpsLatitude:          real("gps_latitude"),
  gpsLongitude:         real("gps_longitude"),

  // ── Video metadata ────────────────────────────────────────────────────────
  videoCodec:           text("video_codec"),
  videoBitrate:         integer("video_bitrate"),
  fps:                  real("fps"),
  audioCodec:           text("audio_codec"),
  dateCreated:          timestamp("date_created"),

  // ── PDF metadata ──────────────────────────────────────────────────────────
  pageCount:            integer("page_count"),
  pdfAuthor:            text("pdf_author"),
  pdfTitle:             text("pdf_title"),
  pdfSubject:           text("pdf_subject"),
  pdfKeywords:          text("pdf_keywords"),

  // ── Raw EXIF + hash ───────────────────────────────────────────────────────
  exifJson:             jsonb("exif_json"),
  contentHash:          text("content_hash"),
  quickFingerprint:     text("quick_fingerprint"),
  scannerVersion:       integer("scanner_version").notNull().default(0),

  lastScanAction:       text("last_scan_action"),
  lastScannedAt:        timestamp("last_scanned_at"),

  // ── Collections / favorites ───────────────────────────────────────────────
  favorite:             boolean("favorite").notNull().default(false),
  favoritedAt:          timestamp("favorited_at"),

  indexedAt:            timestamp("indexed_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("media_files_nas_rel_unique").on(t.nasPath, t.relativePath),
  index("media_files_nas_path_idx").on(t.nasPath),
  index("media_files_media_type_idx").on(t.mediaType),
  index("media_files_content_hash_idx").on(t.contentHash),
  index("media_files_fingerprint_idx").on(t.quickFingerprint),
  index("media_files_size_idx").on(t.nasPath, t.sizeBytes),
  index("media_files_date_taken_idx").on(t.dateTaken),
  index("media_files_gps_idx").on(t.gpsLatitude, t.gpsLongitude),
]);

export const insertMediaFileSchema = createInsertSchema(mediaFilesTable).omit({ id: true, indexedAt: true });
export type InsertMediaFile = z.infer<typeof insertMediaFileSchema>;
export type MediaFile = typeof mediaFilesTable.$inferSelect;
