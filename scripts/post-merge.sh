#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push

# Ensure media tables and library_jobs table exist
psql "$DATABASE_URL" << 'SQL'
CREATE TABLE IF NOT EXISTS media_files (
  id                    serial PRIMARY KEY,
  nas_path              text NOT NULL,
  relative_path         text NOT NULL,
  name                  text NOT NULL,
  extension             text NOT NULL DEFAULT '',
  mime_type             text NOT NULL DEFAULT '',
  media_type            text NOT NULL DEFAULT 'other',
  size_bytes            bigint NOT NULL DEFAULT 0,
  modified_at           timestamp,
  width                 integer,
  height                integer,
  duration_seconds      real,
  thumbnail_path        text,
  thumbnail_generated_at timestamp,
  exif_json             jsonb,
  content_hash          text,
  last_scan_action      text,
  last_scanned_at       timestamp,
  indexed_at            timestamp NOT NULL DEFAULT now()
);

-- Idempotent: add new columns to existing tables
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS orientation      integer;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS date_taken       timestamp;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS camera_make      text;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS camera_model     text;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS lens             text;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS iso              integer;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS aperture         real;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS exposure         text;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS focal_length     real;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS flash            text;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS color_profile    text;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS gps_latitude     real;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS gps_longitude    real;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS video_codec      text;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS video_bitrate    integer;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS fps              real;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS audio_codec      text;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS date_created     timestamp;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS page_count       integer;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS pdf_author       text;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS pdf_title        text;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS pdf_subject      text;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS pdf_keywords     text;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS last_scan_action text;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS last_scanned_at  timestamp;

CREATE UNIQUE INDEX IF NOT EXISTS media_files_nas_rel_unique
  ON media_files (nas_path, relative_path);
CREATE INDEX IF NOT EXISTS media_files_nas_path_idx      ON media_files (nas_path);
CREATE INDEX IF NOT EXISTS media_files_media_type_idx    ON media_files (media_type);
CREATE INDEX IF NOT EXISTS media_files_content_hash_idx  ON media_files (content_hash);
CREATE INDEX IF NOT EXISTS media_files_date_taken_idx    ON media_files (date_taken);
CREATE INDEX IF NOT EXISTS media_files_gps_idx           ON media_files (gps_latitude, gps_longitude);

CREATE TABLE IF NOT EXISTS media_scan_jobs (
  id                    serial PRIMARY KEY,
  status                text NOT NULL DEFAULT 'running',
  nas_path              text NOT NULL,
  total_files           integer NOT NULL DEFAULT 0,
  indexed_files         integer NOT NULL DEFAULT 0,
  skipped_files         integer NOT NULL DEFAULT 0,
  thumbnails_generated  integer NOT NULL DEFAULT 0,
  started_at            timestamp NOT NULL DEFAULT now(),
  finished_at           timestamp,
  error                 text
);

CREATE TABLE IF NOT EXISTS library_jobs (
  id                    serial PRIMARY KEY,
  job_type              text NOT NULL,
  profile               text,
  priority              text NOT NULL DEFAULT 'NORMAL',
  status                text NOT NULL DEFAULT 'PENDING',
  cancellation_reason   text,
  nas_path              text NOT NULL,
  root_path             text,
  cursor                text,
  paused_at             timestamp,
  started_at            timestamp,
  finished_at           timestamp,
  total_files           integer,
  processed_files       integer NOT NULL DEFAULT 0,
  summary               jsonb,
  error                 text,
  created_at            timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS library_jobs_nas_path_idx  ON library_jobs (nas_path);
CREATE INDEX IF NOT EXISTS library_jobs_status_idx    ON library_jobs (status);
CREATE INDEX IF NOT EXISTS library_jobs_job_type_idx  ON library_jobs (job_type);
SQL
