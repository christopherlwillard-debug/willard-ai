/**
 * Willard AI - one-shot database setup script.
 * Creates all tables from scratch on a fresh PostgreSQL database.
 * Safe to re-run: schema statements are idempotent and applied in one
 * transaction; optional capabilities never block the required schema.
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

function getDatabaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error('DATABASE_URL not set and not found in .env');
  }
  return value;
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

// -- 3. Create the willard database if it doesn't exist -----------------------
async function ensureDatabase(DATABASE_URL, Client) {
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
// Increment this when a new ordered schema step is added. The history table
// makes the bootstrap contract inspectable without relying on a local marker
// file, while every step remains idempotent for existing installations.
const SCHEMA_VERSION = 1;

const SETUP_SQL = [
  `CREATE TABLE IF NOT EXISTS willard_schema_versions (
    version    integer PRIMARY KEY,
    applied_at timestamp NOT NULL DEFAULT now()
  )`,

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
    celebration_shown_at    timestamp,
    ai_enrichment_enabled   boolean NOT NULL DEFAULT false,
    ai_local_only           boolean NOT NULL DEFAULT true,
    ai_excluded_folders     text[] NOT NULL DEFAULT '{}',
    ai_excluded_extensions  text[] NOT NULL DEFAULT '{}',
    ai_consent_at           timestamp,
    ai_consent_provider     text,
    ai_consent_version      text
  )`,
  // Older installs may contain duplicates from concurrent first-run setup.
  // Keep the authenticated/oldest row before enforcing the singleton.
  `DELETE FROM app_settings
   WHERE id NOT IN (
     SELECT id FROM app_settings
     ORDER BY (password_hash IS NOT NULL) DESC, id ASC
     LIMIT 1
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS app_settings_singleton_idx ON app_settings ((1))`,

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

  // media_ai — vector embeddings are added after the optional pgvector probe
  `CREATE TABLE IF NOT EXISTS media_ai (
    id             serial PRIMARY KEY,
    media_file_id  integer NOT NULL,
    description    text,
    tags           jsonb,
    objects        jsonb,
    ocr_text       text,
    doc_type       text,
     scene          text,
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
    nas_path      text,
    name          text,
    cover_face_id integer,
     face_count    integer NOT NULL DEFAULT 0,
    hidden        boolean NOT NULL DEFAULT false,
     created_at    timestamp NOT NULL DEFAULT now()
  )`,
  `ALTER TABLE people ADD COLUMN IF NOT EXISTS nas_path text`,
  `CREATE INDEX IF NOT EXISTS people_nas_path_idx ON people (nas_path)`,

  // user tags
  `CREATE TABLE IF NOT EXISTS media_tags (
    id serial PRIMARY KEY,
    nas_path text NOT NULL,
    name text NOT NULL,
    created_at timestamp NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS media_tags_nas_name_unique ON media_tags (nas_path, name)`,
  `CREATE INDEX IF NOT EXISTS media_tags_nas_path_idx ON media_tags (nas_path)`,
  `CREATE TABLE IF NOT EXISTS media_file_tags (
    media_file_id integer NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
    tag_id integer NOT NULL REFERENCES media_tags(id) ON DELETE CASCADE,
    created_at timestamp NOT NULL DEFAULT now(),
    PRIMARY KEY (media_file_id, tag_id)
  )`,
  `CREATE INDEX IF NOT EXISTS media_file_tags_tag_idx ON media_file_tags (tag_id)`,

  // faces
  `CREATE TABLE IF NOT EXISTS faces (
    id            serial PRIMARY KEY,
    media_file_id integer NOT NULL,
    person_id     integer,
    manual_assignment boolean NOT NULL DEFAULT false,
    box_x         real NOT NULL,
    box_y         real NOT NULL,
    box_w         real NOT NULL,
    box_h         real NOT NULL,
     score         real NOT NULL,
     crop_path     text,
    created_at    timestamp NOT NULL DEFAULT now()
  )`,
  `ALTER TABLE faces ADD COLUMN IF NOT EXISTS manual_assignment boolean NOT NULL DEFAULT false`,
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

  // Additive migrations also applied by the API bootstrap path. Keeping them
  // here lets the Windows launcher verify the complete schema once and avoid
  // repeating the same round trips when the API starts.
  `ALTER TABLE conversion_jobs ADD COLUMN IF NOT EXISTS cancelled_at timestamp`,
  `CREATE TABLE IF NOT EXISTS cleanup_operations (
    operation_id text PRIMARY KEY,
    nas_path text NOT NULL,
    media_file_id integer NOT NULL,
    operation_type text NOT NULL DEFAULT 'CLEANUP',
    source_path text NOT NULL,
    trash_path text,
    size_bytes bigint NOT NULL DEFAULT 0,
    status text NOT NULL,
    error text,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS cleanup_operations_status_idx ON cleanup_operations (nas_path, status)`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS optimize_profile text NOT NULL DEFAULT 'ARCHIVE'`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS raw_conversion_enabled boolean NOT NULL DEFAULT false`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ai_enrichment_enabled boolean NOT NULL DEFAULT false`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ai_local_only boolean NOT NULL DEFAULT true`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ai_excluded_folders text[] NOT NULL DEFAULT '{}'`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ai_excluded_extensions text[] NOT NULL DEFAULT '{}'`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ai_consent_at timestamp`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ai_consent_provider text`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ai_consent_version text`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ignored_folders text[] NOT NULL DEFAULT '{}'`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ignored_extensions text[] NOT NULL DEFAULT '{}'`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ignore_hidden_files boolean NOT NULL DEFAULT true`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ignore_system_files boolean NOT NULL DEFAULT true`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ignore_temp_files boolean NOT NULL DEFAULT true`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ignore_sidecar_files boolean NOT NULL DEFAULT true`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ignore_empty_folders boolean NOT NULL DEFAULT false`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS follow_symlinks boolean NOT NULL DEFAULT false`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS index_other_files boolean NOT NULL DEFAULT true`,
  `ALTER TABLE library_jobs ADD COLUMN IF NOT EXISTS diagnostics jsonb`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS watcher_poll_interval_seconds integer NOT NULL DEFAULT 60`,
  `ALTER TABLE media_files ADD COLUMN IF NOT EXISTS fingerprint_status text`,
  `ALTER TABLE media_files ADD COLUMN IF NOT EXISTS metadata_status text`,
  `INSERT INTO willard_schema_versions (version)
   VALUES (${SCHEMA_VERSION})
   ON CONFLICT (version) DO NOTHING`,
];

// Vector columns are optional and must never prevent a fresh database from
// receiving the required catalog/auth schema.
const VECTOR_SQL = [
  `ALTER TABLE media_ai ADD COLUMN IF NOT EXISTS embedding vector(384)`,
  `ALTER TABLE people ADD COLUMN IF NOT EXISTS centroid vector(512)`,
  `ALTER TABLE faces ADD COLUMN IF NOT EXISTS embedding vector(512)`,
];

// -- 6. Required schema runner -----------------------------------------------
// This is the single required-schema path used by both standalone setup and
// API startup. The caller owns the connection; this function owns the
// transaction so a failed migration cannot leave a partially-created schema.
async function runRequiredSchema(client, { log = true } = {}) {
  let ok = 0;
  await client.query('BEGIN');
  try {
    for (const sql of SETUP_SQL) {
      const label = sql.trim().slice(0, 60).replace(/\s+/g, ' ');
      await client.query(sql);
      ok++;
      if (log) process.stdout.write('  [OK] ' + label + '\n');
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    const error = new Error(
      `Required schema setup rolled back after ${ok} statements: ${e.message}`,
      { cause: e },
    );
    if (log) {
      console.error('  [FAIL] Required schema setup rolled back');
      console.error('         ' + e.message);
    }
    throw error;
  }
}

// -- 7. Standalone setup ------------------------------------------------------
async function main() {
  console.log('\n  Willard AI - Database Setup\n');

  const DATABASE_URL = getDatabaseUrl();
  const { Client } = findPg();
  await ensureDatabase(DATABASE_URL, Client);

  const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 8000 });
  await client.connect();
  console.log('  Connected to database.\n');

  let vectorAvailable = false;

  // Optional extensions (pgvector etc.) - failures are non-fatal
  for (const sql of OPTIONAL_SQL) {
    const label = sql.trim().slice(0, 60).replace(/\s+/g, ' ');
    try {
      await client.query(sql);
      vectorAvailable = true;
      process.stdout.write('  [OK] ' + label + '\n');
    } catch (e) {
      process.stdout.write('  [--] ' + label + ' (optional, skipped: ' + e.message.split('\n')[0] + ')\n');
    }
  }

  try {
    await runRequiredSchema(client);
  } catch {
    await client.end();
    process.exit(1);
  }

  if (vectorAvailable) {
    try {
      for (const sql of VECTOR_SQL) await client.query(sql);
      process.stdout.write('  [OK] Optional pgvector columns\n');
    } catch (e) {
      // The required schema is healthy; leave vector features disabled if a
      // permission/version issue prevents adding optional columns.
      vectorAvailable = false;
      console.error('  [--] Optional pgvector columns skipped: ' + e.message.split('\n')[0]);
    }
  }

  await client.end();

  console.log('\n  -----------------------------------------');
  console.log('  All required tables ready. You can now start Willard AI.\n');
}

module.exports = {
  OPTIONAL_SQL,
  SCHEMA_VERSION,
  SETUP_SQL,
  VECTOR_SQL,
  ensureDatabase,
  runRequiredSchema,
};

if (require.main === module) {
  main().catch(e => {
    console.error('\n  Fatal error:', e.message);
    process.exit(1);
  });
}
