import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  buildLibraryRemapSql,
  createPrivateBackupWorkDirectory,
  findWindowsPostgresBinary,
  overwriteFileWithZeroes,
  readRegularFileNoFollow,
  runTool,
} from "./database-backup.mjs";
import {
  LIBRARY_IDENTITY_RELATIVE_PATH,
  ensureLibraryIdentity,
  readLibraryFileNoFollow,
  readLibraryIdentity,
} from "./library-recovery.mjs";
import {
  loadLibraryDurabilityManifest,
  validateLibraryDurabilityManifest,
} from "../scripts/windows/library-durability.mjs";
import {
  createRecoveryExport,
  decryptRecoveryExport,
  validateRecoveryExport,
} from "./backup-credentials.mjs";
import { waitForExportedSnapshot } from "./postgres-snapshot-process.mjs";

const execFileAsync = promisify(execFile);

test("concurrent NAS identity initialization never replaces the first published identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "willard-identity-race-"));
  try {
    const [first, second, persisted] = await Promise.all([
      ensureLibraryIdentity(root),
      ensureLibraryIdentity(root),
      ensureLibraryIdentity(root),
    ]);
    assert.equal(first.libraryId, second.libraryId);
    assert.equal(first.libraryId, persisted.libraryId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backup input reader refuses symlinked manifest and dump files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "willard-backup-input-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "willard-backup-outside-"));
  try {
    const target = path.join(outside, "secret.bin");
    const link = path.join(root, "dump.enc");
    await writeFile(target, "sensitive external bytes");
    try {
      await symlink(target, link, "file");
    } catch (error) {
      if (["EPERM", "EACCES"].includes(error?.code)) {
        t.skip("file symlink creation is not permitted on this runner");
        return;
      }
      throw error;
    }
    await assert.rejects(() => readRegularFileNoFollow(link), /regular, non-symlink file/);
    assert.equal(await readRegularFileNoFollow(target, "utf8"), "sensitive external bytes");
    await assert.rejects(() => readRegularFileNoFollow(target, undefined, 4), /permitted size limit/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("recovery media verification refuses symlinked library paths", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "willard-media-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "willard-media-outside-"));
  try {
    const outsideFile = path.join(outside, "secret.jpg");
    await writeFile(outsideFile, "external media bytes");
    await mkdir(path.join(root, "photos"), { recursive: true });
    try {
      await symlink(outside, path.join(root, "linked-photos"), "dir");
      await symlink(outsideFile, path.join(root, "photos", "linked.jpg"), "file");
    } catch (error) {
      if (["EPERM", "EACCES"].includes(error?.code)) {
        t.skip("symlink creation is not permitted on this runner");
        return;
      }
      throw error;
    }
    await assert.rejects(() => readLibraryFileNoFollow(root, "linked-photos/secret.jpg"), /symlink or non-directory component/);
    await assert.rejects(() => readLibraryFileNoFollow(root, "photos/linked.jpg"), /symlink or non-regular file/);
    await writeFile(path.join(root, "photos", "family.jpg"), "family media");
    assert.equal((await readLibraryFileNoFollow(root, "photos/family.jpg")).toString("utf8"), "family media");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("NAS library identity refuses symlinked config directories", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "willard-identity-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "willard-identity-outside-"));
  try {
    await mkdir(path.join(root, "WillardAI"), { recursive: true });
    try {
      await symlink(outside, path.join(root, "WillardAI", "config"), "dir");
    } catch (error) {
      if (["EPERM", "EACCES"].includes(error?.code)) {
        t.skip("directory symlink creation is not permitted on this runner");
        return;
      }
      throw error;
    }
    await assert.rejects(() => ensureLibraryIdentity(root), /symlink or non-directory component/);
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("NAS library identity refuses a symlinked marker file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "willard-identity-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "willard-identity-outside-"));
  try {
    const config = path.join(root, "WillardAI", "config");
    await mkdir(config, { recursive: true });
    const outsideMarker = path.join(outside, "marker.json");
    await writeFile(outsideMarker, JSON.stringify({
      format: "willard-library-identity",
      version: 1,
      libraryId: "12345678-1234-1234-1234-123456789abc",
      createdAt: new Date().toISOString(),
    }));
    try {
      await symlink(outsideMarker, path.join(config, "library-identity.json"), "file");
    } catch (error) {
      if (["EPERM", "EACCES"].includes(error?.code)) {
        t.skip("file symlink creation is not permitted on this runner");
        return;
      }
      throw error;
    }
    await assert.rejects(() => readLibraryIdentity(root), /regular file inside the configured library/);
    assert.equal((await readFile(outsideMarker, "utf8")).length > 0, true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("plaintext backup work directory is private before pg_dump writes", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "willard-backup-test-"));
  let workDir;
  try {
    workDir = await createPrivateBackupWorkDirectory(tempRoot);
    assert.equal(path.dirname(workDir), tempRoot);
    assert.ok((await stat(workDir)).isDirectory());
    if (process.platform !== "win32") {
      assert.equal((await stat(workDir)).mode & 0o777, 0o700);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("PostgreSQL helper subprocess output is bounded and excessive output is terminated", async () => {
  await assert.rejects(
    runTool(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000)"],
      process.env,
      "bounded test process",
      { maxOutputBytes: 128 },
    ),
    /exceeded its 128-byte output limit/,
  );
});

test("PostgreSQL helper subprocess retains only a bounded stderr tail", async () => {
  await assert.rejects(
    runTool(
      process.execPath,
      ["-e", "process.stderr.write('x'.repeat(4096)); process.exit(1)"],
      process.env,
      "stderr tail test",
      { maxStderrBytes: 64 },
    ),
    (error) => {
      assert.ok(error.message.length < 200);
      assert.ok(error.message.endsWith("x".repeat(64)));
      return true;
    },
  );
});

test("restore plaintext dump uses an exclusive file in a private operation workspace", async () => {
  const source = await readFile(new URL("./database-backup.mjs", import.meta.url), "utf8");
  assert.match(source, /const restoreWorkRoot = await createPrivateBackupWorkDirectory\(\)/);
  assert.match(source, /const temporaryDump = path\.join\(restoreWorkRoot, "database\.dump"\)/);
  assert.match(source, /writeFile\(temporaryDump, dump, \{ mode: 0o600, flag: "wx" \}\)/);
  assert.match(source, /await rm\(restoreWorkRoot, \{ recursive: true, force: true \}\)/);
});

test("backup encryption and decryption clear derived key buffers", async () => {
  const source = await readFile(new URL("./database-backup.mjs", import.meta.url), "utf8");
  const encryptStart = source.indexOf("function encryptDump");
  const decryptStart = source.indexOf("function decryptDump");
  const clearStart = source.indexOf("async function overwriteFileWithZeroes");
  assert.ok(encryptStart >= 0 && decryptStart > encryptStart && clearStart > decryptStart);
  assert.match(source.slice(encryptStart, decryptStart), /finally\s*\{\s*key\.fill\(0\)/);
  assert.match(source.slice(decryptStart, clearStart), /finally\s*\{\s*key\.fill\(0\)/);
});

test("temporary database dump clearing uses bounded chunks and handles partial writes", async () => {
  const size = 2 * 1024 * 1024 + 37;
  const chunkSize = 64 * 1024;
  const destination = Buffer.alloc(size, 0xff);
  let largestWriteBuffer = 0;
  let syncCalled = false;
  const handle = {
    async write(buffer, offset, length, position) {
      largestWriteBuffer = Math.max(largestWriteBuffer, buffer.length);
      const bytesWritten = Math.min(length, 4093);
      buffer.copy(destination, position, offset, offset + bytesWritten);
      return { bytesWritten };
    },
    async sync() {
      syncCalled = true;
    },
  };

  await overwriteFileWithZeroes(handle, size, chunkSize);
  assert.equal(largestWriteBuffer, chunkSize);
  assert.ok(destination.every((byte) => byte === 0));
  assert.equal(syncCalled, true);
  await assert.rejects(() => overwriteFileWithZeroes(handle, Number.MAX_SAFE_INTEGER + 1), /invalid file size/);
});
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "desktop", "database-backup.mjs");
const postgresBin = process.env.POSTGRES_BIN || "postgres";
const initdbBin = process.env.INITDB_BIN || "initdb";
const createdbBin = process.env.CREATEDB_BIN || "createdb";
const dropdbBin = process.env.DROPDB_BIN || "dropdb";
const psqlBin = process.env.PSQL_BIN || "psql";

async function run(command, args, env = {}) {
  return execFileAsync(command, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      ...(process.platform === "win32" ? { PGPASSWORD: process.env.PGPASSWORD || "postgres" } : {}),
      ...env,
    },
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForPostgres(url, process) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (process && process.exitCode !== null) {
      throw new Error(
        `Disposable PostgreSQL exited before becoming ready.\n${process.stderrText || "(no server error output)"}`,
      );
    }
    try {
      await run(psqlBin, ["-X", "--no-password", "-v", "ON_ERROR_STOP=1", "-At", "-c", "SELECT 1", url]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Disposable PostgreSQL did not become ready.");
}

async function stopPostgres(process) {
  if (!process || process.exitCode !== null) return;
  process.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      process.kill("SIGKILL");
      resolve();
    }, 5000);
    process.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function runCli(args, env) {
  return run(process.execPath, [SCRIPT, ...args], env);
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

test("library durability manifest covers permanent, recoverable, and rebuildable state", () => {
  assert.deepEqual(validateLibraryDurabilityManifest(loadLibraryDurabilityManifest()), []);
});

test("library path reconciliation is transactional and boundary-aware", () => {
  const sql = buildLibraryRemapSql("/old/library", "/reattached/library");
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /UPDATE "media_files".*"nas_path"/);
  assert.match(sql, /UPDATE "collections".*"nas_path"/);
  assert.match(sql, /UPDATE "cleanup_operations".*"source_path"/);
  assert.match(sql, /UPDATE "organization_jobs".*"plan_json"/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.match(sql, /substring\(.* IN \('\/', E'\\\\'\)/);
  assert.doesNotMatch(sql, /DELETE|DROP|TRUNCATE/);
  assert.equal(buildLibraryRemapSql("/same/library", "/same/library"), "");

  const windows = buildLibraryRemapSql("Z:\\Media Library", "Y:\\Recovered Media");
  assert.ok(windows.includes("Z:\\Media Library"));
  assert.ok(windows.includes("Y:\\Recovered Media"));
  assert.match(windows, /pg_temp\.willard_remap_jsonb/);
  assert.doesNotMatch(windows, /replace\("plan_json"::text/);

  const unc = buildLibraryRemapSql(
    "\\\\nas-a\\photos\\Willard",
    "\\\\nas-b\\recovered\\Willard",
  );
  assert.ok(unc.includes("\\\\nas-a\\photos\\Willard"));
  assert.ok(unc.includes("\\\\nas-b\\recovered\\Willard"));
});

test("Windows backup tools are found in standard PostgreSQL installation folders", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "willard-postgres-tools-"));
  try {
    const bin = path.join(root, "PostgreSQL", "16", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "psql.exe"), "");
    await writeFile(path.join(bin, "pg_dump.exe"), "");

    assert.equal(
      findWindowsPostgresBinary("psql.exe", {
        ProgramFiles: root,
        ProgramW6432: "",
        "ProgramFiles(x86)": "",
        Path: "",
        PATH: "",
      }),
      path.join(bin, "psql.exe"),
    );
    assert.equal(
      findWindowsPostgresBinary("pg_dump.exe", {
        ProgramFiles: root,
        ProgramW6432: "",
        "ProgramFiles(x86)": "",
        Path: "",
        PATH: "",
      }),
      path.join(bin, "pg_dump.exe"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portable recovery exports are encrypted, authenticated, and fail closed", () => {
  const secret = "automatic-backup-secret-that-never-goes-on-the-nas";
  const passphrase = "portable-export-passphrase";
  const serialized = createRecoveryExport(secret, passphrase);
  const exported = validateRecoveryExport(JSON.parse(serialized));
  assert.equal(exported.format, "willard-backup-recovery-export");
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.equal(decryptRecoveryExport(serialized, passphrase), secret);
  assert.throws(() => decryptRecoveryExport(serialized, "incorrect-passphrase"), /incorrect/);

  const tampered = JSON.parse(serialized);
  tampered.createdAt = new Date(Date.parse(tampered.createdAt) + 1000).toISOString();
  assert.throws(() => decryptRecoveryExport(tampered, passphrase), /incorrect/);
});

test(
  "recovers representative library knowledge from NAS into a clean database",
  { timeout: 120_000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "willard-db-drill-"));
    const dataDir = path.join(root, "data");
    const socketDir = path.join(root, "socket");
    const backupRoot = path.join(root, "backups");
    const tamperedBackup = path.join(root, "tampered-backup");
    const tamperedManifestBackup = path.join(root, "tampered-manifest-backup");
    const nasRoot = path.join(root, "nas-library");
    const reattachedNasRoot = path.join(root, "reattached-nas-library");
    const foreignNasRoot = path.join(root, "foreign-nas-library");
    const originalPath = path.join(nasRoot, "photos", "family.jpg");
    const recycledPath = path.join(nasRoot, "photos", "recycled.jpg");
    const deletedPath = path.join(nasRoot, "photos", "deleted.jpg");
    const recycledTrashPath = path.join(nasRoot, "WillardAI", ".Trash", "recycled.jpg");
    const optionalCache = path.join(nasRoot, "WillardAI", "cache", "thumbnails", "1.webp");
    const localModelCache = path.join(root, "lost-laptop", "models", "face.onnx");
    const useInstalledService = process.platform === "win32";
    const databaseSuffix = path
      .basename(root)
      .replace(/[^a-z0-9]/gi, "")
      .slice(-20)
      .toLowerCase();
    const sourceDatabase = `willard_source_${databaseSuffix}`;
    const targetDatabase = `willard_target_${databaseSuffix}`;
    const port = await freePort();
    const databasePort = useInstalledService ? 5432 : port;
    const databasePrefix = useInstalledService
      ? `postgresql://postgres:postgres@127.0.0.1:${databasePort}`
      : `postgresql://postgres@127.0.0.1:${databasePort}`;
    let server;
    try {
      if (useInstalledService) {
        await waitForPostgres(`${databasePrefix}/postgres`, null);
      } else {
        await run(initdbBin, ["--no-locale", "--auth=trust", "--username=postgres", "--pgdata", dataDir]);
        await mkdir(socketDir, { recursive: true });
        server = spawn(
          postgresBin,
          ["-D", dataDir, "-p", String(port), "-h", "127.0.0.1", "-k", socketDir],
          { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
        );
        server.stderrText = "";
        server.stderr.on("data", (chunk) => {
          server.stderrText += chunk.toString();
        });
        await waitForPostgres(`${databasePrefix}/postgres`, server);
      }
      const databaseArgs = ["-h", "127.0.0.1", "-p", String(databasePort), "-U", "postgres"];
      await run(createdbBin, [...databaseArgs, sourceDatabase]);
      await run(createdbBin, [...databaseArgs, targetDatabase]);
      const sourceUrl = `${databasePrefix}/${sourceDatabase}`;
      const targetUrl = `${databasePrefix}/${targetDatabase}`;
      await mkdir(path.dirname(originalPath), { recursive: true });
      await mkdir(path.dirname(recycledTrashPath), { recursive: true });
      await mkdir(path.dirname(optionalCache), { recursive: true });
      await mkdir(path.dirname(localModelCache), { recursive: true });
      const originalBytes = Buffer.from("representative-original-photo-bytes");
      const originalSha256 = createHash("sha256").update(originalBytes).digest("hex");
      const recycledBytes = Buffer.from("recycled-photo-bytes");
      const recycledSha256 = createHash("sha256").update(recycledBytes).digest("hex");
      await writeFile(originalPath, originalBytes);
      await writeFile(recycledTrashPath, recycledBytes);
      await writeFile(optionalCache, "rebuildable thumbnail");
      await writeFile(localModelCache, "rebuildable model cache");
      await mkdir(foreignNasRoot, { recursive: true });
      await ensureLibraryIdentity(foreignNasRoot);
      await run(psqlBin, [
        "-X",
        "--no-password",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        `
          CREATE TABLE app_settings (
            id integer PRIMARY KEY, nas_path text, photos_destination text,
            videos_destination text, documents_destination text, other_files_destination text,
            password_hash text
          );
          INSERT INTO app_settings VALUES
            (1, ${sqlLiteral(nasRoot)}, ${sqlLiteral(path.join(nasRoot, "photos"))}, '', '', '', NULL);
          CREATE TABLE willard_schema_versions (version integer PRIMARY KEY);
          INSERT INTO willard_schema_versions VALUES (2);
          CREATE TABLE media_files (
            id integer PRIMARY KEY, nas_path text NOT NULL, relative_path text NOT NULL,
            content_hash text, favorite boolean NOT NULL DEFAULT false, name text NOT NULL,
            thumbnail_path text, last_scan_action text
          );
          INSERT INTO media_files
            (id, nas_path, relative_path, content_hash, favorite, name, thumbnail_path, last_scan_action)
          VALUES
            (1, ${sqlLiteral(nasRoot)}, 'photos/family.jpg', ${sqlLiteral(originalSha256)}, true, 'family.jpg',
             ${sqlLiteral(optionalCache)}, NULL),
            (2, ${sqlLiteral(nasRoot)}, 'photos/recycled.jpg', ${sqlLiteral(recycledSha256)}, false, 'recycled.jpg',
             NULL, 'RECYCLED'),
            (3, ${sqlLiteral(nasRoot)}, 'photos/deleted.jpg', ${sqlLiteral(originalSha256)}, false, 'deleted.jpg',
             NULL, 'DELETED');
          CREATE TABLE media_ai (
            media_file_id integer PRIMARY KEY, description text, user_description text,
            user_tags jsonb, hidden_tags jsonb, notes text, embedding text
          );
          INSERT INTO media_ai VALUES
            (1, 'two people outdoors', 'Family reunion', '["family"]', '["outdoor"]', 'Keep forever', '[0.1,0.2]');
          CREATE TABLE collections (id integer PRIMARY KEY, nas_path text NOT NULL, kind text, name text);
          CREATE TABLE collection_items (collection_id integer, media_file_id integer, PRIMARY KEY (collection_id, media_file_id));
          INSERT INTO collections VALUES (10, ${sqlLiteral(nasRoot)}, 'manual', 'Family');
          INSERT INTO collection_items VALUES (10, 1);
          CREATE TABLE media_tags (id integer PRIMARY KEY, nas_path text NOT NULL, name text);
          CREATE TABLE media_file_tags (media_file_id integer, tag_id integer, PRIMARY KEY (media_file_id, tag_id));
          INSERT INTO media_tags VALUES (20, ${sqlLiteral(nasRoot)}, 'favorite-trip');
          INSERT INTO media_file_tags VALUES (1, 20);
          CREATE TABLE people (id integer PRIMARY KEY, nas_path text, name text, hidden boolean);
          CREATE TABLE faces (id integer PRIMARY KEY, media_file_id integer, person_id integer, crop_path text);
          CREATE TABLE face_scan_state (media_file_id integer PRIMARY KEY, face_version integer, face_count integer);
          INSERT INTO people VALUES (30, ${sqlLiteral(nasRoot)}, 'Alex', false);
          INSERT INTO faces VALUES (31, 1, 30, ${sqlLiteral(path.join(nasRoot, "WillardAI", "cache", "faces", "31.webp"))});
          INSERT INTO face_scan_state VALUES (1, 1, 1);
          CREATE TABLE archives (id integer PRIMARY KEY, nas_path text, path text, filename text, folder text);
          INSERT INTO archives VALUES
            (40, ${sqlLiteral(nasRoot)}, ${sqlLiteral(path.join(nasRoot, "archives", "family.zip"))}, 'family.zip',
             ${sqlLiteral(path.join(nasRoot, "archives"))});
          CREATE TABLE cleanup_operations (
            operation_id text PRIMARY KEY, nas_path text, media_file_id integer,
            operation_type text, source_path text, trash_path text, status text
          );
          INSERT INTO cleanup_operations VALUES
            ('cleanup-1', ${sqlLiteral(nasRoot)}, 1, 'CLEANUP',
             ${sqlLiteral(originalPath)}, ${sqlLiteral(path.join(nasRoot, "WillardAI", ".Trash", "family.jpg"))}, 'STAGED');
          CREATE TABLE conversion_jobs (id integer PRIMARY KEY, nas_path text, backup_dir text, result_json jsonb);
          INSERT INTO conversion_jobs VALUES
            (45, ${sqlLiteral(nasRoot)}, ${sqlLiteral(path.join(nasRoot, "WillardAI", "ConversionBackups"))},
             ${sqlLiteral(JSON.stringify({ output: path.join(nasRoot, "converted", "family.jpg") }))}::jsonb);
          CREATE TABLE indexed_files (id integer PRIMARY KEY, path text, folder text);
          INSERT INTO indexed_files VALUES
            (46, ${sqlLiteral(originalPath)}, ${sqlLiteral(path.dirname(originalPath))});
          CREATE TABLE library_activity (id integer PRIMARY KEY, nas_path text);
          INSERT INTO library_activity VALUES (47, ${sqlLiteral(nasRoot)});
          CREATE TABLE organization_jobs (
            id integer PRIMARY KEY, nas_path text, source_path text, report_path text,
            plan_json jsonb, preflight_json jsonb, file_moves jsonb, report_json jsonb
          );
          INSERT INTO organization_jobs VALUES
            (48, ${sqlLiteral(nasRoot)}, ${sqlLiteral(originalPath)},
             ${sqlLiteral(path.join(nasRoot, "WillardAI", "reports", "organize.json"))},
             ${sqlLiteral(JSON.stringify({ source: originalPath, emptyObject: {}, emptyArray: [], nested: { emptyObject: {}, emptyArray: [] } }))}::jsonb,
             ${sqlLiteral(JSON.stringify({ root: nasRoot }))}::jsonb,
             ${sqlLiteral(JSON.stringify([{ from: originalPath, to: path.join(nasRoot, "organized", "family.jpg") }]))}::jsonb,
             ${sqlLiteral(JSON.stringify({ report: path.join(nasRoot, "WillardAI", "reports", "organize.json") }))}::jsonb);
          CREATE TABLE library_jobs (
            id integer PRIMARY KEY, nas_path text, job_type text, status text,
            cursor text, processed_files integer, root_path text, summary jsonb, diagnostics jsonb
          );
          INSERT INTO library_jobs VALUES
            (50, ${sqlLiteral(nasRoot)}, 'FULL_SCAN', 'PAUSED', 'photos/family.jpg', 1,
             ${sqlLiteral(nasRoot)}, '{"last":"photos/family.jpg"}', '{"reason":"NAS_OFFLINE"}');
          CREATE TABLE search_history (id integer PRIMARY KEY, query text, result_count integer);
          CREATE TABLE saved_searches (id integer PRIMARY KEY, name text, query text);
          INSERT INTO search_history VALUES (60, 'family Alex', 1);
          INSERT INTO saved_searches VALUES (61, 'Family search', 'family Alex');
          CREATE TABLE catalog_items (id integer PRIMARY KEY, title text NOT NULL);
          INSERT INTO catalog_items VALUES (1, 'nas photo'), (2, 'family video');
          CREATE TABLE empty_table (id integer PRIMARY KEY);
        `,
        sourceUrl,
      ]);

      const passphrase = "offline-restore-drill-passphrase";
      await runCli(["backup", "--output-dir", backupRoot, "--keep", "12"], {
        DATABASE_URL: sourceUrl,
        WILLARD_BACKUP_PASSPHRASE: passphrase,
      });
      const backupEntries = (await readdir(backupRoot, { withFileTypes: true })).filter(
        (entry) => entry.isDirectory() && entry.name.startsWith("backup-"),
      );
      assert.equal(backupEntries.length, 1);
      const backupDir = path.join(backupRoot, backupEntries[0].name);
      const manifest = JSON.parse(await readFile(path.join(backupDir, "manifest.json"), "utf8"));
      const encrypted = await readFile(path.join(backupDir, "database.dump.enc"));
      assert.equal(manifest.format, "willard-postgresql-backup");
      assert.equal(manifest.schema, 2);
      assert.equal(manifest.encryption.algorithm, "aes-256-gcm");
      assert.equal(manifest.library.root, path.resolve(nasRoot));
      assert.match(manifest.library.libraryId, /^[0-9a-f-]{36}$/);
      assert.equal(manifest.library.catalogInventoryScope, "active");
      assert.equal(manifest.library.catalogMediaCount, 1, "recycled and deleted rows are not active canonical media");
      assert.equal(manifest.library.mediaSamples.length, 1);
      assert.equal(manifest.compatibility.applicationSchemaVersion, 2);
      assert.equal(manifest.verification.rowCounts["public.catalog_items"], "2");
      assert.equal(manifest.verification.rowCounts["public.media_files"], "3");
      assert.equal(manifest.verification.rowCounts["public.empty_table"], "0");
      assert.ok(!encrypted.includes(Buffer.from("nas photo")));
      await runCli(["verify", "--backup-dir", backupDir], {
        WILLARD_BACKUP_PASSPHRASE: passphrase,
      });
      const recoveryExport = path.join(root, "portable-recovery.willard-recovery.json");
      const exportPassphrase = "separate-portable-export-passphrase";
      await runCli(["export-recovery", "--output", recoveryExport], {
        WILLARD_BACKUP_PASSPHRASE: passphrase,
        WILLARD_RECOVERY_EXPORT_PASSPHRASE: exportPassphrase,
      });
      const serializedExport = await readFile(recoveryExport, "utf8");
      assert.doesNotMatch(serializedExport, new RegExp(passphrase));
      await runCli(["verify", "--backup-dir", backupDir, "--recovery-export", recoveryExport], {
        WILLARD_BACKUP_PASSPHRASE: "",
        WILLARD_RECOVERY_EXPORT_PASSPHRASE: exportPassphrase,
      });
      const discovered = await runCli(["discover", "--output-dir", backupRoot, "--recovery-export", recoveryExport], {
        WILLARD_BACKUP_PASSPHRASE: "",
        WILLARD_RECOVERY_EXPORT_PASSPHRASE: exportPassphrase,
      });
      const discoveredBackups = JSON.parse(discovered.stdout);
      assert.equal(discoveredBackups.length, 1);
      assert.equal(discoveredBackups[0].backupDir, backupDir);
      assert.equal(discoveredBackups[0].verified, true);
      const sourceIdentityPath = path.join(nasRoot, LIBRARY_IDENTITY_RELATIVE_PATH);
      const reattachedIdentityPath = path.join(reattachedNasRoot, LIBRARY_IDENTITY_RELATIVE_PATH);
      const reattachedOriginalPath = path.join(reattachedNasRoot, "photos", "family.jpg");
      await mkdir(path.dirname(reattachedIdentityPath), { recursive: true });
      await mkdir(path.dirname(reattachedOriginalPath), { recursive: true });
      await cp(sourceIdentityPath, reattachedIdentityPath);
      await cp(originalPath, reattachedOriginalPath);

      await assert.rejects(
        runCli(["restore", "--backup-dir", backupDir], {
          WILLARD_RESTORE_DATABASE_URL: targetUrl,
          WILLARD_BACKUP_PASSPHRASE: passphrase,
        }),
        /library-bound|--library-root/,
      );
      await assert.rejects(
        runCli(["restore", "--backup-dir", backupDir, "--library-root", reattachedNasRoot], {
          WILLARD_RESTORE_DATABASE_URL: targetUrl,
          WILLARD_BACKUP_PASSPHRASE: passphrase,
        }),
        /confirm-library-id|operator attestation/,
      );
      await assert.rejects(
        runCli([
          "restore", "--backup-dir", backupDir, "--library-root", foreignNasRoot,
          "--confirm-library-id", manifest.library.libraryId,
        ], {
          WILLARD_RESTORE_DATABASE_URL: targetUrl,
          WILLARD_BACKUP_PASSPHRASE: passphrase,
        }),
        /does not match the backup identity|identity marker does not match/,
      );
      const identityPath = reattachedIdentityPath;
      const disconnectedIdentityPath = `${identityPath}.disconnected`;
      await rename(identityPath, disconnectedIdentityPath);
      await assert.rejects(
        runCli([
          "restore", "--backup-dir", backupDir, "--library-root", reattachedNasRoot,
          "--confirm-library-id", manifest.library.libraryId,
        ], {
          WILLARD_RESTORE_DATABASE_URL: targetUrl,
          WILLARD_BACKUP_PASSPHRASE: passphrase,
        }),
        /missing or invalid|ENOENT|no such file/i,
      );
      await rename(disconnectedIdentityPath, identityPath);
      await rm(path.join(nasRoot, "WillardAI", "cache"), { recursive: true, force: true });
      await rm(path.join(root, "lost-laptop"), { recursive: true, force: true });

      await runCli([
        "restore", "--backup-dir", backupDir, "--library-root", reattachedNasRoot,
        "--confirm-library-id", manifest.library.libraryId,
        "--recovery-export", recoveryExport,
      ], {
        DATABASE_URL: sourceUrl,
        WILLARD_RESTORE_DATABASE_URL: targetUrl,
        WILLARD_BACKUP_PASSPHRASE: "",
        WILLARD_RECOVERY_EXPORT_PASSPHRASE: exportPassphrase,
      });
      const restored = await run(psqlBin, [
        "-X",
        "--no-password",
        "-v",
        "ON_ERROR_STOP=1",
        "-At",
        "-c",
        "SELECT count(*) || ':' || string_agg(title, ',' ORDER BY id) FROM catalog_items",
        targetUrl,
      ]);
      assert.equal(restored.stdout.trim(), "2:nas photo,family video");
      const restoredMediaStates = await run(psqlBin, [
        "-X",
        "--no-password",
        "-v",
        "ON_ERROR_STOP=1",
        "-At",
        "-c",
        "SELECT count(*) || ':' || count(*) FILTER (WHERE last_scan_action IS DISTINCT FROM 'DELETED' AND last_scan_action IS DISTINCT FROM 'RECYCLED') FROM media_files",
        targetUrl,
      ]);
      assert.equal(restoredMediaStates.stdout.trim(), "3:1", "recycled and deleted catalog history remains while active media is verified");
      const recoveredKnowledge = await run(psqlBin, [
        "-X",
        "--no-password",
        "-v",
        "ON_ERROR_STOP=1",
        "-At",
        "-F",
        "|",
        "-c",
        `
          SELECT
            mf.nas_path,
            mf.relative_path,
            mf.content_hash,
            mf.favorite,
            ai.user_description,
            ai.notes,
            c.name,
            t.name,
            p.name,
            f.person_id,
            a.filename,
            co.status,
            lj.status || ':' || lj.cursor,
            ss.query
          FROM media_files mf
          JOIN media_ai ai ON ai.media_file_id = mf.id
          JOIN collection_items ci ON ci.media_file_id = mf.id
          JOIN collections c ON c.id = ci.collection_id
          JOIN media_file_tags mft ON mft.media_file_id = mf.id
          JOIN media_tags t ON t.id = mft.tag_id
          JOIN faces f ON f.media_file_id = mf.id
          JOIN people p ON p.id = f.person_id
          CROSS JOIN archives a
          CROSS JOIN cleanup_operations co
          CROSS JOIN library_jobs lj
          CROSS JOIN saved_searches ss
        `,
        targetUrl,
      ]);
      assert.equal(
        recoveredKnowledge.stdout.trim(),
        [
          "photos/family.jpg",
          path.resolve(reattachedNasRoot),
        ].reverse().concat([
          originalSha256,
          "t",
          "Family reunion",
          "Keep forever",
          "Family",
          "favorite-trip",
          "Alex",
          "30",
          "family.zip",
          "STAGED",
          "PAUSED:photos/family.jpg",
          "family Alex",
        ]).join("|"),
      );
      const recoveredEmptyJson = await run(psqlBin, [
        "-X",
        "--no-password",
        "-v",
        "ON_ERROR_STOP=1",
        "-At",
        "-F",
        "|",
        "-c",
        `
          SELECT
            jsonb_typeof(plan_json -> 'emptyObject'),
            jsonb_typeof(plan_json -> 'emptyArray'),
            jsonb_array_length(plan_json -> 'emptyArray'),
            jsonb_typeof(plan_json #> '{nested,emptyObject}'),
            jsonb_typeof(plan_json #> '{nested,emptyArray}'),
            jsonb_array_length(plan_json #> '{nested,emptyArray}')
          FROM organization_jobs
          WHERE id = 48
        `,
        targetUrl,
      ]);
      assert.equal(
        recoveredEmptyJson.stdout.trim(),
        "object|array|0|object|array|0",
        "path remapping must preserve empty JSON objects and arrays, including nested values",
      );
      assert.equal(
        createHash("sha256").update(await readFile(reattachedOriginalPath)).digest("hex"),
        originalSha256,
      );
      await assert.rejects(readFile(optionalCache), /ENOENT/);

      for (const probe of [
        {
          source: "Z:\\",
          target: "Y:\\",
          media: "Z:\\photos\\family.jpg",
          expectedMedia: "Y:\\photos\\family.jpg",
          cache: "Z:\\cache\\thumb.webp",
          expectedCache: "Y:\\cache\\thumb.webp",
        },
        {
          source: "\\\\old-nas\\library\\",
          target: "\\\\new-nas\\recovered\\",
          media: "\\\\old-nas\\library\\photos\\family.jpg",
          expectedMedia: "\\\\new-nas\\recovered\\photos\\family.jpg",
          cache: "\\\\old-nas\\library\\cache\\thumb.webp",
          expectedCache: "\\\\new-nas\\recovered\\cache\\thumb.webp",
        },
      ]) {
        await run(psqlBin, [
          "-X",
          "--no-password",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          `
            UPDATE media_files
               SET nas_path = ${sqlLiteral(probe.source)},
                   thumbnail_path = ${sqlLiteral(probe.cache)};
            UPDATE app_settings
               SET nas_path = ${sqlLiteral(probe.source)},
                   photos_destination = ${sqlLiteral(probe.media)};
            UPDATE organization_jobs
               SET plan_json = ${sqlLiteral(JSON.stringify({ source: probe.media }))}::jsonb;
          `,
          targetUrl,
        ]);
        await run(psqlBin, [
          "-X",
          "--no-password",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          buildLibraryRemapSql(probe.source, probe.target),
          targetUrl,
        ]);
        const remapped = await run(psqlBin, [
          "-X",
          "--no-password",
          "-v",
          "ON_ERROR_STOP=1",
          "-At",
          "-F",
          "|",
          "-c",
          `
            SELECT mf.nas_path, mf.thumbnail_path, s.photos_destination,
                   oj.plan_json ->> 'source'
              FROM media_files mf
              CROSS JOIN app_settings s
              CROSS JOIN organization_jobs oj
          `,
          targetUrl,
        ]);
        const expectedRemapRow = [probe.target, probe.expectedCache, probe.expectedMedia, probe.expectedMedia].join("|");
        assert.deepEqual(
          remapped.stdout.trim().split(/\r?\n/),
          [expectedRemapRow, expectedRemapRow, expectedRemapRow],
          "path remapping must update active, recycled, and deleted media rows",
        );
      }

      await assert.rejects(
        runCli([
          "restore", "--backup-dir", backupDir, "--library-root", reattachedNasRoot,
          "--confirm-library-id", manifest.library.libraryId,
        ], {
          WILLARD_RESTORE_DATABASE_URL: targetUrl,
          WILLARD_BACKUP_PASSPHRASE: passphrase,
        }),
        /not empty/,
      );
      const recoveryJournal = path.join(
        reattachedNasRoot,
        "WillardAI",
        "config",
        "recovery-attempts",
        `${manifest.integrity.encryptedSha256}.json`,
      );
      const completeJournalBytes = await readFile(recoveryJournal);
      const resumable = JSON.parse(completeJournalBytes.toString("utf8"));
      resumable.state = "REMAP_FAILED";
      await writeFile(recoveryJournal, `${JSON.stringify(resumable, null, 2)}\n`);
      await assert.rejects(
        runCli([
          "restore", "--backup-dir", backupDir, "--library-root", reattachedNasRoot,
          "--confirm-library-id", manifest.library.libraryId, "--resume-recovery",
        ], {
          WILLARD_RESTORE_DATABASE_URL: targetUrl,
          WILLARD_BACKUP_PASSPHRASE: passphrase,
        }),
        /journal authentication failed/,
      );
      await writeFile(recoveryJournal, completeJournalBytes);
      await runCli([
        "restore", "--backup-dir", backupDir, "--library-root", reattachedNasRoot,
        "--confirm-library-id", manifest.library.libraryId, "--resume-recovery",
      ], {
        WILLARD_RESTORE_DATABASE_URL: targetUrl,
        WILLARD_BACKUP_PASSPHRASE: passphrase,
      });
      assert.equal(JSON.parse(await readFile(recoveryJournal, "utf8")).state, "COMPLETE");

      await cp(backupDir, tamperedBackup, { recursive: true });
      const tamperedFile = path.join(tamperedBackup, "database.dump.enc");
      const tamperedBytes = await readFile(tamperedFile);
      tamperedBytes[0] ^= 0xff;
      await writeFile(tamperedFile, tamperedBytes);
      await assert.rejects(
        runCli([
          "restore", "--backup-dir", tamperedBackup, "--library-root", reattachedNasRoot,
          "--confirm-library-id", manifest.library.libraryId,
        ], {
          WILLARD_RESTORE_DATABASE_URL: targetUrl,
          WILLARD_BACKUP_PASSPHRASE: passphrase,
        }),
        /SHA-256 integrity check/,
      );

      await cp(backupDir, tamperedManifestBackup, { recursive: true });
      const tamperedManifestPath = path.join(tamperedManifestBackup, "manifest.json");
      const tamperedManifest = JSON.parse(await readFile(tamperedManifestPath, "utf8"));
      tamperedManifest.verification.rowCounts["public.catalog_items"] = "999";
      await writeFile(tamperedManifestPath, `${JSON.stringify(tamperedManifest, null, 2)}\n`);
      await assert.rejects(
        runCli([
          "verify", "--backup-dir", tamperedManifestBackup,
        ], {
          WILLARD_BACKUP_PASSPHRASE: passphrase,
        }),
        /passphrase or authenticated backup metadata/,
      );

      const tamperedRetentionBackup = path.join(backupRoot, "backup-tampered-retention-date");
      await cp(backupDir, tamperedRetentionBackup, { recursive: true });
      const tamperedRetentionManifestPath = path.join(tamperedRetentionBackup, "manifest.json");
      const tamperedRetentionManifest = JSON.parse(await readFile(tamperedRetentionManifestPath, "utf8"));
      tamperedRetentionManifest.createdAt = "2000-01-01T00:00:00.000Z";
      await writeFile(tamperedRetentionManifestPath, `${JSON.stringify(tamperedRetentionManifest, null, 2)}\n`);

      await new Promise((resolve) => setTimeout(resolve, 20));
      await runCli(["backup", "--output-dir", backupRoot, "--retention-days", "0", "--keep", "1"], {
        DATABASE_URL: sourceUrl,
        WILLARD_BACKUP_PASSPHRASE: passphrase,
      });
      const retained = (await readdir(backupRoot, { withFileTypes: true })).filter(
        (entry) => entry.isDirectory() && entry.name.startsWith("backup-"),
      );
      assert.equal(retained.length, 2, "retention must preserve a backup with an unauthenticated manifest");
      assert.equal(
        retained.some((entry) => entry.name === "backup-tampered-retention-date"),
        true,
        "retention must not delete a backup based on a tampered creation date",
      );
      assert.equal(
        retained.some((entry) => entry.name === path.basename(backupDir)),
        false,
        "the authenticated older backup should be pruned when keep=1 and retention-days=0",
      );
    } finally {
      await stopPostgres(server);
      if (useInstalledService) {
        const databaseArgs = ["-h", "127.0.0.1", "-p", String(databasePort), "-U", "postgres"];
        await Promise.all(
          [targetDatabase, sourceDatabase].map((database) =>
            run(dropdbBin, [...databaseArgs, "--if-exists", database]).catch(() => undefined),
          ),
        );
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("backup manifest uses the canonical authenticated active-library settings row", async () => {
  const source = await readFile(new URL("./database-backup.mjs", import.meta.url), "utf8");
  assert.match(
    source,
    /SELECT nas_path FROM app_settings ORDER BY \(password_hash IS NOT NULL\) DESC, id ASC LIMIT 1/,
  );
});


test("secure plaintext backup cleanup refuses symlink targets", async () => {
  const source = await readFile(new URL("./database-backup.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function secureRemove");
  const end = source.indexOf("\nasync function sourceDatabaseName", start);
  assert.ok(start >= 0 && end > start);
  const cleanup = source.slice(start, end);
  assert.match(cleanup, /const info = await lstat\(filePath\)/);
  assert.match(cleanup, /info\.isSymbolicLink\(\) \|\| !info\.isFile\(\)/);
  assert.match(cleanup, /fsConstants\.O_RDWR \| noFollow/);
  assert.match(cleanup, /current\.isSymbolicLink\(\)/);
});


test("restore target safety checks schemas, relations, routines, types, and extensions", async () => {
  const source = await readFile(new URL("./database-backup.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function cleanTarget");
  const end = source.indexOf("\nasync function recoveryJournalPath", start);
  assert.ok(start >= 0 && end > start);
  const check = source.slice(start, end);
  for (const catalog of ["pg_class", "pg_proc", "pg_type", "pg_namespace", "pg_extension"]) {
    assert.match(check, new RegExp(`pg_catalog\\.${catalog}\\b`));
  }
  assert.match(check, /nspname NOT IN \('pg_catalog', 'information_schema', 'public'\)/);
  assert.match(check, /extname <> 'plpgsql'/);
  assert.doesNotMatch(check, /pg_catalog\.pg_tables/);
});


test("backup and restore media inventories are scoped to the authenticated NAS root", async () => {
  const source = await readFile(new URL("./database-backup.mjs", import.meta.url), "utf8");
  const sourceStart = source.indexOf("async function sourceLibrary");
  const sourceEnd = source.indexOf("\nexport async function createPrivateBackupWorkDirectory", sourceStart);
  assert.ok(sourceStart >= 0 && sourceEnd > sourceStart);
  const sourceLibrary = source.slice(sourceStart, sourceEnd);
  assert.match(sourceLibrary, /FROM media_files WHERE nas_path = \$\{sqlLiteral\(root\)\}/);
  assert.match(sourceLibrary, /WHERE nas_path = \$\{sqlLiteral\(root\)\} AND last_scan_action/);

  const restoreStart = source.indexOf("async function verifyRestoredLibraryInventory");
  const restoreEnd = source.indexOf("\nfunction sqlLiteral", restoreStart);
  assert.ok(restoreStart >= 0 && restoreEnd > restoreStart);
  const restoreInventory = source.slice(restoreStart, restoreEnd);
  assert.match(restoreInventory, /nas_path = \$\{sqlLiteral\(targetLibrary\.root\)\}/);
});
