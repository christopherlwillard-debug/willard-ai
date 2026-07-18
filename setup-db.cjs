/**
 * Willard AI - one-shot database setup script.
 * Creates all tables from scratch on a fresh PostgreSQL database.
 * Safe to re-run: every statement uses CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
 *
 * Usage (from C:\WillardAI):
 *   node setup-db.cjs
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// -- 1. Load DATABASE_URL from root .env --------------------------------------
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !process.env[key]) process.env[key] = val;
  }
}
loadEnv();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not set and not found in .env');
  process.exit(1);
}

// -- 2. Find the pg package in pnpm's virtual store ---------------------------
function findPg() {
  // Direct (some pnpm configs hoist to root node_modules)
  try { return require('pg'); } catch {}

  const pnpmDir = path.join(__dirname, 'node_modules', '.pnpm');
  if (!fs.existsSync(pnpmDir)) {
    throw new Error('node_modules/.pnpm not found - run `pnpm install` first.');
  }
  const entries = fs.readdirSync(pnpmDir);
  // Match pg@X.Y.Z but not pg-pool, pg-protocol, pg-types, etc.
  const entry = entries.find(e => /^pg@\d/.test(e));
  if (!entry) throw new Error('pg package not found in node_modules/.pnpm');
  return require(path.join(pnpmDir, entry, 'node_modules', 'pg'));
}

const { Client } = findPg();

// -- 3. Create the willard database if it doesn't exist -----------------------
async function ensureDatabase() {
  const url    = new URL(DATABASE_URL);
  const dbName = url.pathname.slice(1);
  url.pathname = '/postgres';

  const admin = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 8000 });
  await admin.connect();
  const { rows } = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]);
  if (rows.length === 0) {
    console.log(`  Creating database "${dbName}"...`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
    console.log(`  Database "${dbName}" created.`);
  } else {
    console.log(`  Database "${dbName}" already exists.`);
  }
  await admin.end();
}

// -- 4. Optional extensions (failures are non-fatal) --------------------------
const OPTIONAL_SQL = [
  // pgvector - needed for AI embeddings; not available on all systems
  `CREATE EXTENSION IF NOT EXISTS vector`,
];

// -- 5. All SQL to create/migrate every table ---------------------------------
const SETUP_SQL = [

  // indexed_files (general file index used by dashboard, search, and scan engine)
  `CREATE TABLE IF NOT EXISTS indexed_files (
    id           serial PRIMARY KEY,
    path         text NOT NULL UNIQUE,
    filename     text NOT NULL,
    extension    text NOT NULL DEFAULT '',
    file_type    text NOT NULL DEFAULT 'other',
    size_bytes   bigint NOT NULL DEFAULT 0,
    modified_at  timestamp,
    folder       text NOT NULL DEFAULT '',
    source       text NOT NULL DEFAULT 'local',
    content_hash text,
    indexed_at   timestamp NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS indexed_files_content_hash_idx ON indexed_files (content_hash)`,

  // Session store (connect-pg-simple)
  `CREATE TABLE IF NOT EXISTS "session" (
    "sid"    varchar      NOT NULL COLLATE "default",
    "sess"   json         NOT NULL,
    "expire" timestamp(6) NOT NULL,
    CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
  ) WITH (OIDS=FALSE)`,
  `CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire")`,

  // app_settings (single-row settings + auth)
  `CREATE TABLE IF NOT EXISTS app_settings (
    id                      serial PRIMARY KEY,
    nas_path                text NOT NULL DEFAULT '',
    last_scan_at            timestamp,
    total_files_indexed     integer NOT NULL DEFAULT 0,
    password_hash           text,
    recovery_key_hash       text,
    photos_destination      text NOT NULL DEFAULT '',
    videos_destination      text NOT NULL DEFAULT '',
    documents_destination   text NOT NULL DEFAULT '',
    other_files_destination text NOT NULL DEFAULT '',
    logo_path               text,
    scan_performance        text NOT NULL DEFAULT 'BALANCED',
    thumbnail_quality       text NOT NULL DEFAULT 'BALANCED',
    indexing_paused         boolean NOT NULL DEFAULT false,
    onboarding_dismissed_at timestamp,
    celebration_shown_at    timestamp
  )`,

  // scan_jobs (legacy)
  `CREATE TABLE IF NOT EXISTS scan_jobs (
    id            serial PRIMARY KEY,
    status        text NOT NULL DEFAULT 'idle',
    files_scanned integer NOT NULL DEFAULT 0,
    total_files   integer,
    stage         text NOT NULL DEFAULT '',
    started_at    timestamp,
    finished_at   timestamp,
    error         text
  )`,

  // archives
  `CREATE TABLE IF NOT EXISTS archives (
    id                       serial PRIMARY KEY,
    path                     text NOT NULL UNIQUE,
    filename                 text NOT NULL,
    size_bytes               bigint NOT NULL DEFAULT 0,
    modified_at              timestamp,
    folder                   text NOT NULL DEFAULT '',
    contained_file_count     integer,
    photo_count              integer,
    video_count              integer,
    document_count           integer,
    category                 text NOT NULL DEFAULT 'general',
    peek_status              text NOT NULL DEFAULT 'pending',
    is_password_protected    boolean NOT NULL DEFAULT false,
    has_nested_archives      boolean NOT NULL DEFAULT false,
    estimated_extraction_size bigint,
    peek_entries             jsonb,
    indexed_at               timestamp NOT NULL DEFAULT now()
  )`,

  // organization_jobs
  `CREATE TABLE IF NOT EXISTS organization_jobs (
    id                  serial PRIMARY KEY,
    status              text NOT NULL DEFAULT 'pending',
    source_type         text NOT NULL,
    source_path         text NOT NULL,
    archive_id          integer,
    archive_disposition text NOT NULL DEFAULT 'keep',
    conflict_policy     text NOT NULL DEFAULT 'keep_existing',
    plan_json           jsonb,
    preflight_json      jsonb,
    file_moves          jsonb,
    report_json         jsonb,
    report_path         text,
    error               text,
    last_stage          text,
    stage_updated_at    timestamp,
    created_at          timestamp NOT NULL DEFAULT now(),
    completed_at        timestamp
  )`,

  // conversion_jobs
  `CREATE TABLE IF NOT EXISTS conversion_jobs (
    id               serial PRIMARY KEY,
    status           text NOT NULL DEFAULT 'pending',
    approved_exts    jsonb NOT NULL,
    backup_dir       text,
    nas_path         text NOT NULL,
    total_files      integer NOT NULL DEFAULT 0,
    processed_files  integer NOT NULL DEFAULT 0,
    succeeded_files  integer NOT NULL DEFAULT 0,
    failed_files     integer NOT NULL DEFAULT 0,
    skipped_files    integer NOT NULL DEFAULT 0,
    result_json      jsonb,
    error            text,
    created_at       timestamp NOT NULL DEFAULT now(),
    completed_at     timestamp
  )`,

  // media_scan_jobs
  `CREATE TABLE IF NOT EXISTS media_scan_jobs (
    id                   serial PRIMARY KEY,
    status               text NOT NULL DEFAULT 'running',
    nas_path             text NOT NULL,
    total_files          integer NOT NULL DEFAULT 0,
    indexed_files        integer NOT NULL DEFAULT 0,
    skipped_files        integer NOT NULL DEFAULT 0,
    thumbnails_generated integer NOT NULL DEFAULT 0,
    started_at           timestamp NOT NULL DEFAULT now(),
    finished_at          timestamp,
    error                text
  )`,

  // library_jobs
  `CREATE TABLE IF NOT EXISTS library_jobs (
    id                   serial PRIMARY KEY,
    job_type             text NOT NULL,
    profile              text,
    priority             text NOT NULL DEFAULT 'NORMAL',
    status               text NOT NULL DEFAULT 'PENDING',
    cancellation_reason  text,
    nas_path             text NOT NULL,
    root_path            text,
    cursor               text,
    paused_at            timestamp,
    started_at           timestamp,
    finished_at          timestamp,
    total_files          integer,
    processed_files      integer NOT NULL DEFAULT 0,
    summary              jsonb,
    error                text,
    created_at           timestamp NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS library_jobs_nas_path_idx ON library_jobs (nas_path)`,
  `CREATE INDEX IF NOT EXISTS library_jobs_status_idx ON library_jobs (status)`,
  `CREATE INDEX IF NOT EXISTS library_jobs_job_type_idx ON library_jobs (job_type)`,

  // media_files
  `CREATE TABLE IF NOT EXISTS media_files (
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
    orientation           integer,
    thumbnail_path        text,
    thumbnail_generated_at timestamp,
    date_taken            timestamp,
    camera_make           text,
    camera_model          text,
    lens                  text,
    iso                   integer,
    aperture              real,
    exposure              text,
    focal_length          real,
    flash                 text,
    color_profile         text,
    gps_latitude          real,
    gps_longitude         real,
    place_name            text,
    video_codec           text,
    video_bitrate         integer,
    fps                   real,
    audio_codec           text,
    date_created          timestamp,
    page_count            integer,
    pdf_author            text,
    pdf_title             text,
    pdf_subject           text,
    pdf_keywords          text,
    exif_json             jsonb,
    content_hash          text,
    quick_fingerprint     text,
    scanner_version       integer NOT NULL DEFAULT 0,
    last_scan_action      text,
    last_scanned_at       timestamp,
    favorite              boolean NOT NULL DEFAULT false,
    favorited_at          timestamp,
    indexed_at            timestamp NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS media_files_nas_rel_unique ON media_files (nas_path, relative_path)`,
  `CREATE INDEX IF NOT EXISTS media_files_nas_path_idx ON media_files (nas_path)`,
  `CREATE INDEX IF NOT EXISTS media_files_media_type_idx ON media_files (media_type)`,
  `CREATE INDEX IF NOT EXISTS media_files_content_hash_idx ON media_files (content_hash)`,
  `CREATE INDEX IF NOT EXISTS media_files_fingerprint_idx ON media_files (quick_fingerprint)`,
  `CREATE INDEX IF NOT EXISTS media_files_size_idx ON media_files (nas_path, size_bytes)`,
  `CREATE INDEX IF NOT EXISTS media_files_date_taken_idx ON media_files (date_taken)`,
  `CREATE INDEX IF NOT EXISTS media_files_gps_idx ON media_files (gps_latitude, gps_longitude)`,

  // collections
  `CREATE TABLE IF NOT EXISTS collections (
    id           serial PRIMARY KEY,
    nas_path     text NOT NULL,
    kind         text NOT NULL,
    name         text NOT NULL,
    description  text,
    auto_key     text,
    removed_at   timestamp,
    rule_json    jsonb,
    cover_file_id integer,
    created_at   timestamp NOT NULL DEFAULT now(),
    updated_at   timestamp NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS collections_nas_auto_key_unique ON collections (nas_path, auto_key)`,
  `CREATE INDEX IF NOT EXISTS collections_nas_kind_idx ON collections (nas_path, kind)`,

  // collection_items
  `CREATE TABLE IF NOT EXISTS collection_items (
    id             serial PRIMARY KEY,
    collection_id  integer NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    media_file_id  integer NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
    added_at       timestamp NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS collection_items_unique ON collection_items (collection_id, media_file_id)`,
  `CREATE INDEX IF NOT EXISTS collection_items_file_idx ON collection_items (media_file_id)`,

  // library_activity
  `CREATE TABLE IF NOT EXISTS library_activity (
    id         serial PRIMARY KEY,
    nas_path   text NOT NULL,
    kind       text NOT NULL,
    message    text NOT NULL,
    details    jsonb,
    created_at timestamp NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS library_activity_nas_path_idx ON library_activity (nas_path)`,
  `CREATE INDEX IF NOT EXISTS library_activity_created_at_idx ON library_activity (created_at)`,

  // media_ai
  `CREATE TABLE IF NOT EXISTS media_ai (
    id             serial PRIMARY KEY,
    media_file_id  integer NOT NULL,
    description    text,
    tags           jsonb,
    objects        jsonb,
    ocr_text       text,
    doc_type       text,
    scene          text,
    embedding      vector(384),
    ai_version     integer NOT NULL DEFAULT 1,
    analyzed_at    timestamp,
    error          text,
    people         jsonb,
    user_tags      jsonb,
    hidden_tags    jsonb,
    user_description text,
    notes          text
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS media_ai_file_idx ON media_ai (media_file_id)`,

  // geo_place_cache
  `CREATE TABLE IF NOT EXISTS geo_place_cache (
    lat10       integer NOT NULL,
    lon10       integer NOT NULL,
    name        text NOT NULL,
    resolved_at timestamp NOT NULL DEFAULT now(),
    PRIMARY KEY (lat10, lon10)
  )`,

  // search_history
  `CREATE TABLE IF NOT EXISTS search_history (
    id           serial PRIMARY KEY,
    query        text NOT NULL,
    intent_json  jsonb,
    result_count integer NOT NULL DEFAULT 0,
    created_at   timestamp NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS search_history_created_idx ON search_history (created_at)`,

  // saved_searches
  `CREATE TABLE IF NOT EXISTS saved_searches (
    id          serial PRIMARY KEY,
    name        text NOT NULL,
    query       text NOT NULL,
    intent_json jsonb,
    created_at  timestamp NOT NULL DEFAULT now(),
    last_used_at timestamp
  )`,

  // people (face recognition)
  `CREATE TABLE IF NOT EXISTS people (
    id            serial PRIMARY KEY,
    name          text,
    cover_face_id integer,
    face_count    integer NOT NULL DEFAULT 0,
    centroid      vector(512),
    hidden        boolean NOT NULL DEFAULT false,
    created_at    timestamp NOT NULL DEFAULT now()
  )`,

  // faces
  `CREATE TABLE IF NOT EXISTS faces (
    id            serial PRIMARY KEY,
    media_file_id integer NOT NULL,
    person_id     integer,
    box_x         real NOT NULL,
    box_y         real NOT NULL,
    box_w         real NOT NULL,
    box_h         real NOT NULL,
    score         real NOT NULL,
    crop_path     text,
    embedding     vector(512),
    created_at    timestamp NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS faces_file_idx ON faces (media_file_id)`,
  `CREATE INDEX IF NOT EXISTS faces_person_idx ON faces (person_id)`,

  // face_scan_state
  `CREATE TABLE IF NOT EXISTS face_scan_state (
    media_file_id integer PRIMARY KEY,
    face_version  integer NOT NULL DEFAULT 1,
    face_count    integer NOT NULL DEFAULT 0,
    scanned_at    timestamp NOT NULL DEFAULT now(),
    error         text
  )`,
];

// -- 6. Run everything --------------------------------------------------------
async function main() {
  console.log('\n  Willard AI - Database Setup\n');

  await ensureDatabase();

  const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 8000 });
  await client.connect();
  console.log('  Connected to database.\n');

  // Optional extensions (pgvector etc.) - failures are non-fatal
  for (const sql of OPTIONAL_SQL) {
    const label = sql.trim().slice(0, 60).replace(/\s+/g, ' ');
    try {
      await client.query(sql);
      process.stdout.write('  [OK] ' + label + '\n');
    } catch (e) {
      process.stdout.write('  [--] ' + label + ' (optional, skipped: ' + e.message.split('\n')[0] + ')\n');
    }
  }

  // Required tables - failures are fatal
  let ok = 0;
  let fail = 0;
  for (const sql of SETUP_SQL) {
    const label = sql.trim().slice(0, 60).replace(/\s+/g, ' ');
    try {
      await client.query(sql);
      ok++;
      process.stdout.write('  [OK] ' + label + '\n');
    } catch (e) {
      fail++;
      console.error('  [FAIL] ' + label);
      console.error('         ' + e.message);
    }
  }

  await client.end();

  console.log('\n  -----------------------------------------');
  if (fail === 0) {
    console.log('  All tables ready. You can now start Willard AI.\n');
  } else {
    console.log('  Done with ' + fail + ' error(s) - see above. The app may still work if errors were non-critical.\n');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('\n  Fatal error:', e.message);
  process.exit(1);
});
