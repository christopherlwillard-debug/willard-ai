#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push

# Ensure media tables exist (drizzle-kit push may skip non-interactive envs)
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
  indexed_at            timestamp NOT NULL DEFAULT now(),
  UNIQUE (nas_path, relative_path)
);
CREATE INDEX IF NOT EXISTS media_files_nas_path_idx ON media_files (nas_path);
CREATE INDEX IF NOT EXISTS media_files_rel_path_idx ON media_files (relative_path);
CREATE INDEX IF NOT EXISTS media_files_media_type_idx ON media_files (media_type);
CREATE INDEX IF NOT EXISTS media_files_content_hash_idx ON media_files (content_hash);

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
SQL
