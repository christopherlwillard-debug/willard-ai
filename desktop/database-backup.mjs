#!/usr/bin/env node

/**
 * Encrypted PostgreSQL backup and restore for Willard Media Center.
 *
 * The database dump is deliberately separate from media files. A backup
 * directory contains an authenticated manifest and an AES-256-GCM encrypted
 * pg_dump custom-format file. The manifest records enough schema/data facts to
 * prove a restore landed in the intended clean database.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DURABLE_JSON_COLUMNS,
  DURABLE_PATH_COLUMNS,
  ensureLibraryIdentity,
  normalizeLibraryRoot,
  readLibraryIdentity,
  validateRecoveryAttachment,
} from "./library-recovery.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORMAT = "willard-postgresql-backup";
const SCHEMA_VERSION = 2;
const SUPPORTED_APPLICATION_SCHEMA_VERSION = 2;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_KEEP = 12;
const DEFAULT_OUTPUT_DIR = path.join(ROOT, "backups", "database");
const DUMP_FILE = "database.dump.enc";
const MANIFEST_FILE = "manifest.json";
const SCRYPT = Object.freeze({ name: "scrypt", N: 16_384, r: 8, p: 1, keyLength: 32 });
const ALGORITHM = "aes-256-gcm";

function fail(message) {
  throw new Error(message);
}

function loadEnvironmentFile() {
  const candidates = [
    process.env.WILLARD_ENV_FILE,
    path.join(ROOT, ".env"),
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Willard Media Center", ".env")
      : null,
  ].filter(Boolean);
  for (const filePath of candidates) {
    let content;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    for (const line of content.replace(/^\uFEFF/, "").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || match[1] in process.env) continue;
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
    return;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireOption(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) {
    fail(`Missing required option --${name}.`);
  }
  return value;
}

function parseArgs(argv) {
  const command = argv[0] || "help";
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) fail(`Unexpected argument: ${token}`);
    const equals = token.indexOf("=");
    if (equals !== -1) {
      options[token.slice(2, equals)] = token.slice(equals + 1);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options[name] = next;
      index += 1;
    } else {
      options[name] = true;
    }
  }
  return { command, options };
}

function integerOption(options, name, fallback, minimum = 0) {
  const raw = options[name] ?? fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(`--${name} must be an integer greater than or equal to ${minimum}.`);
  }
  return value;
}

function resolveBackupRoot(options) {
  return path.resolve(
    options["output-dir"] ||
      options["backup-root"] ||
      process.env.WILLARD_DB_BACKUP_DIR ||
      DEFAULT_OUTPUT_DIR,
  );
}

function resolveBinary(environmentName, unixName, windowsName) {
  return process.env[environmentName] || (process.platform === "win32" ? windowsName : unixName);
}

function connectionEnvironment(connectionString) {
  const source = { ...process.env };
  delete source.DATABASE_URL;
  delete source.WILLARD_RESTORE_DATABASE_URL;
  if (!connectionString) return source;

  let url;
  try {
    url = new URL(connectionString);
  } catch {
    fail("The PostgreSQL connection string is not a valid URL.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    fail("The PostgreSQL connection string must use postgres:// or postgresql://.");
  }
  if (!url.hostname && !url.pathname) fail("The PostgreSQL connection string has no database host or name.");

  source.PGHOST = url.hostname || "localhost";
  if (url.port) source.PGPORT = url.port;
  if (url.username) source.PGUSER = decodeURIComponent(url.username);
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!database) fail("The PostgreSQL connection string must include a database name.");
  source.PGDATABASE = database;
  if (url.password) source.PGPASSWORD = decodeURIComponent(url.password);
  else delete source.PGPASSWORD;
  const sslMode = url.searchParams.get("sslmode");
  if (sslMode) source.PGSSLMODE = sslMode;
  return source;
}

function databaseConnection(options, restore = false) {
  const connectionString =
    (restore ? process.env.WILLARD_RESTORE_DATABASE_URL : null) ||
    options["database-url"] ||
    process.env.DATABASE_URL;
  if (!connectionString && !process.env.PGDATABASE) {
    fail(
      restore
        ? "Set WILLARD_RESTORE_DATABASE_URL (or DATABASE_URL) for the clean restore target."
        : "Set DATABASE_URL for the source PostgreSQL database.",
    );
  }
  return connectionEnvironment(connectionString);
}

function runTool(command, args, environment, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(new Error(`${label} could not start: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || (signal ? `signal ${signal}` : `exit code ${code}`);
        reject(new Error(`${label} failed: ${detail}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function runSql(sql, environment, label = "PostgreSQL query") {
  return runTool(
    resolveBinary("PSQL_BIN", "psql", "psql.exe"),
    ["-X", "--no-password", "-q", "-v", "ON_ERROR_STOP=1", "-At", "-F", "\t", "-c", sql],
    environment,
    label,
  );
}

function runSnapshotSql(sql, environment, snapshot, label) {
  if (!snapshot) return runSql(sql, environment, label);
  const snapshotLiteral = sqlLiteral(snapshot);
  return runSql(
    `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT ${snapshotLiteral}; ${sql}; COMMIT`,
    environment,
    label,
  );
}

async function openDatabaseSnapshot(environment) {
  const command = resolveBinary("PSQL_BIN", "psql", "psql.exe");
  const args = [
    "-X",
    "--no-password",
    "-v",
    "ON_ERROR_STOP=1",
    "-At",
  ];
  const child = spawn(command, args, {
    cwd: ROOT,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.write("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n");
  const snapshot = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Timed out while exporting the PostgreSQL backup snapshot."));
    }, 10_000);
    const inspect = () => {
      const exported = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => /^[0-9a-f]+-[0-9a-f]+-\d+$/i.test(line));
      if (exported) {
        clearTimeout(timeout);
        resolve(exported);
      }
    };
    child.stdout.on("data", inspect);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`PostgreSQL snapshot holder could not start: ${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      reject(new Error(`PostgreSQL snapshot holder exited early: ${stderr.trim() || `exit code ${code}`}`));
    });
  });
  return {
    snapshot,
    async release() {
      if (child.exitCode !== null) return;
      child.stdin.end("ROLLBACK;\n\\q\n");
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 3000);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function databaseFacts(environment, snapshot = null) {
  const tableOutput = await runSnapshotSql(
    "SELECT schemaname, tablename FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY schemaname, tablename",
    environment,
    snapshot,
    "Database table inspection",
  );
  const rowCounts = {};
  for (const line of tableOutput.trim() ? tableOutput.trim().split(/\r?\n/) : []) {
    const [schema, table] = line.split("\t");
    if (!schema || !table) fail("PostgreSQL returned an invalid table list during verification.");
    const key = `${schema}.${table}`;
    const countOutput = await runSnapshotSql(
      `SELECT count(*) FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`,
      environment,
      snapshot,
      `Row-count inspection for ${key}`,
    );
    const count = countOutput.trim();
    if (!/^\d+$/.test(count)) fail(`PostgreSQL returned an invalid row count for ${key}.`);
    rowCounts[key] = count;
  }

  const schemaOutput = await runSnapshotSql(
    "SELECT table_schema, table_name, ordinal_position, column_name, data_type, udt_name, is_nullable, COALESCE(column_default, '') FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name, ordinal_position",
    environment,
    snapshot,
    "Database schema inspection",
  );
  return {
    schemaSha256: sha256Bytes(Buffer.from(schemaOutput, "utf8")),
    rowCounts,
  };
}

function authenticatedManifestPart(manifest) {
  return {
    schema: manifest.schema,
    format: manifest.format,
    createdAt: manifest.createdAt,
    database: manifest.database,
    compatibility: manifest.compatibility,
    library: manifest.library,
    encryption: manifest.encryption,
    dump: manifest.dump,
    verification: manifest.verification,
  };
}

function manifestAad(manifest) {
  return Buffer.from(stableJson(authenticatedManifestPart(manifest)), "utf8");
}

function promptSecret(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    fail("No backup passphrase was supplied. Set WILLARD_BACKUP_PASSPHRASE or run from an interactive terminal.");
  }
  return new Promise((resolve, reject) => {
    let value = "";
    const stdin = process.stdin;
    const finish = (error, result) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(result);
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") {
          finish(new Error("Passphrase entry was cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish(null, value);
          return;
        }
        if (character === "\u0008" || character === "\u007f") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };
    process.stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function passphrase(confirm = false) {
  const value = process.env.WILLARD_BACKUP_PASSPHRASE;
  if (value) {
    if (value.length < 12) fail("WILLARD_BACKUP_PASSPHRASE must contain at least 12 characters.");
    return value;
  }
  const entered = await promptSecret("Backup encryption passphrase: ");
  if (entered.length < 12) fail("The backup passphrase must contain at least 12 characters.");
  if (confirm) {
    const repeated = await promptSecret("Repeat backup encryption passphrase: ");
    if (entered !== repeated) fail("The backup passphrases did not match.");
  }
  return entered;
}

function validateBase64(value, expectedBytes, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    fail(`Backup manifest has an invalid ${label}.`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== expectedBytes) fail(`Backup manifest has an invalid ${label} length.`);
  return decoded;
}

function validateManifest(manifest) {
  if (!manifest || manifest.schema !== SCHEMA_VERSION || manifest.format !== FORMAT) {
    fail("The backup manifest is not a supported Willard PostgreSQL backup.");
  }
  if (typeof manifest.createdAt !== "string" || Number.isNaN(Date.parse(manifest.createdAt))) {
    fail("Backup manifest has an invalid creation time.");
  }
  if (!manifest.database || typeof manifest.database.name !== "string") {
    fail("Backup manifest has no database identity.");
  }
  if (
    !manifest.compatibility ||
    (manifest.compatibility.postgresMajor !== null &&
      !Number.isSafeInteger(manifest.compatibility.postgresMajor)) ||
    (manifest.compatibility.applicationSchemaVersion !== null &&
      !Number.isSafeInteger(manifest.compatibility.applicationSchemaVersion))
  ) {
    fail("Backup manifest has no supported compatibility metadata.");
  }
  if (manifest.library !== null) {
    if (
      !manifest.library ||
      typeof manifest.library.libraryId !== "string" ||
      !/^[0-9a-f-]{16,80}$/i.test(manifest.library.libraryId) ||
      typeof manifest.library.root !== "string" ||
      !manifest.library.root ||
      !/^[a-f0-9]{64}$/i.test(manifest.library.markerSha256) ||
      !Number.isSafeInteger(manifest.library.catalogMediaCount) ||
      !Array.isArray(manifest.library.mediaSamples) ||
      manifest.library.mediaSamples.some(
        (sample) =>
          !sample ||
          typeof sample.relativePath !== "string" ||
          path.isAbsolute(sample.relativePath) ||
          sample.relativePath.split(/[\\/]+/).includes("..") ||
          !/^[a-f0-9]{64}$/i.test(sample.sha256),
      )
    ) {
      fail("Backup manifest has invalid NAS library identity metadata.");
    }
  }
  if (
    !manifest.encryption ||
    manifest.encryption.algorithm !== ALGORITHM ||
    manifest.encryption.kdf?.name !== SCRYPT.name ||
    manifest.encryption.kdf?.N !== SCRYPT.N ||
    manifest.encryption.kdf?.r !== SCRYPT.r ||
    manifest.encryption.kdf?.p !== SCRYPT.p ||
    manifest.encryption.kdf?.keyLength !== SCRYPT.keyLength
  ) {
    fail("Backup manifest uses an unsupported encryption configuration.");
  }
  validateBase64(manifest.encryption.salt, 16, "encryption salt");
  validateBase64(manifest.encryption.iv, 12, "encryption IV");
  if (
    !manifest.dump ||
    manifest.dump.file !== DUMP_FILE ||
    !/^[a-f0-9]{64}$/.test(manifest.dump.plaintextSha256) ||
    !Number.isSafeInteger(manifest.dump.plaintextBytes) ||
    manifest.dump.plaintextBytes < 1
  ) {
    fail("Backup manifest has invalid dump metadata.");
  }
  if (
    !manifest.integrity ||
    !/^[a-f0-9]{64}$/.test(manifest.integrity.encryptedSha256) ||
    !Number.isSafeInteger(manifest.integrity.encryptedBytes) ||
    manifest.integrity.encryptedBytes < 1 ||
    typeof manifest.integrity.authTag !== "string"
  ) {
    fail("Backup manifest has invalid integrity metadata.");
  }
  validateBase64(manifest.integrity.authTag, 16, "authentication tag");
  if (
    !manifest.verification ||
    typeof manifest.verification.schemaSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.verification.schemaSha256)
  ) {
    fail("Backup manifest has no restore verification facts.");
  }
  if (!manifest.verification.rowCounts || typeof manifest.verification.rowCounts !== "object") {
    fail("Backup manifest has no table row counts.");
  }
  for (const [key, count] of Object.entries(manifest.verification.rowCounts)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !/^\d+$/.test(count)) {
      fail("Backup manifest has invalid table verification facts.");
    }
  }
  return manifest;
}

async function readBackup(backupDir) {
  const manifestPath = path.join(backupDir, MANIFEST_FILE);
  const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8").then((value) => value.replace(/^\uFEFF/, ""))));
  const dumpPath = path.join(backupDir, manifest.dump.file);
  if (path.dirname(dumpPath) !== path.resolve(backupDir)) fail("Backup dump path escapes its backup directory.");
  const encrypted = await readFile(dumpPath);
  if (encrypted.length !== manifest.integrity.encryptedBytes) fail("Encrypted backup size does not match its manifest.");
  if (sha256Bytes(encrypted) !== manifest.integrity.encryptedSha256) {
    fail("Encrypted backup failed its SHA-256 integrity check.");
  }
  return { manifest, encrypted, dumpPath };
}

function encryptDump(dump, manifest, secret) {
  const salt = validateBase64(manifest.encryption.salt, 16, "encryption salt");
  const iv = validateBase64(manifest.encryption.iv, 12, "encryption IV");
  const key = scryptSync(secret, salt, SCRYPT.keyLength, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 64 * 1024 * 1024,
  });
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(manifestAad(manifest));
  const encrypted = Buffer.concat([cipher.update(dump), cipher.final()]);
  manifest.integrity.authTag = cipher.getAuthTag().toString("base64");
  return encrypted;
}

function decryptDump(encrypted, manifest, secret) {
  const salt = validateBase64(manifest.encryption.salt, 16, "encryption salt");
  const iv = validateBase64(manifest.encryption.iv, 12, "encryption IV");
  const authTag = validateBase64(manifest.integrity.authTag, 16, "authentication tag");
  const key = scryptSync(secret, salt, SCRYPT.keyLength, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 64 * 1024 * 1024,
  });
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(manifestAad(manifest));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    fail("The passphrase or authenticated backup metadata is incorrect.");
  }
}

async function secureRemove(filePath) {
  try {
    const info = await stat(filePath);
    if (info.isFile() && info.size > 0) {
      await writeFile(filePath, Buffer.alloc(info.size), { mode: 0o600 });
    }
  } catch {
    // Cleanup is best effort; the containing temporary directory is removed too.
  }
  await rm(filePath, { force: true }).catch(() => {});
}

async function sourceDatabaseName(environment, snapshot = null) {
  const output = await runSnapshotSql(
    "SELECT current_database()", environment, snapshot, "Database identity inspection",
  );
  return output.trim();
}

async function sourceCompatibility(environment, snapshot = null) {
  const output = await runSnapshotSql(
    "SHOW server_version_num", environment, snapshot, "PostgreSQL compatibility inspection",
  );
  const version = Number(output.trim());
  if (!Number.isSafeInteger(version) || version < 10000) {
    fail("PostgreSQL returned an invalid server version.");
  }
  let applicationSchemaVersion = null;
  try {
    const schemaOutput = await runSnapshotSql(
      "SELECT max(version) FROM willard_schema_versions",
      environment,
      snapshot,
      "Application schema inspection",
    );
    const value = schemaOutput.trim();
    if (value && value !== "\\N") {
      applicationSchemaVersion = Number(value);
      if (!Number.isSafeInteger(applicationSchemaVersion) || applicationSchemaVersion < 1) {
        fail("The application schema version is invalid.");
      }
    }
  } catch (error) {
    if (!/willard_schema_versions|does not exist/i.test(String(error))) throw error;
  }
  return { postgresMajor: Math.floor(version / 10000), applicationSchemaVersion };
}

async function sourceLibrary(environment, snapshot = null) {
  let output;
  try {
    output = await runSnapshotSql(
      "SELECT nas_path FROM app_settings WHERE nas_path IS NOT NULL AND btrim(nas_path) <> '' LIMIT 1",
      environment,
      snapshot,
      "Library identity inspection",
    );
  } catch (error) {
    if (/app_settings|does not exist/i.test(String(error))) return null;
    throw error;
  }
  const root = output.trim();
  if (!root) return null;
  const identity = await ensureLibraryIdentity(root);
  const countOutput = await runSnapshotSql(
    "SELECT count(*)::text || E'\\t' || count(*) FILTER (WHERE content_hash ~ '^[a-fA-F0-9]{64}$')::text FROM media_files",
    environment,
    snapshot,
    "Library catalog identity inspection",
  );
  const [totalValue, hashedValue] = countOutput.trim().split("\t");
  const catalogMediaCount = Number(totalValue);
  const hashedMediaCount = Number(hashedValue);
  if (
    !Number.isSafeInteger(catalogMediaCount) ||
    catalogMediaCount < 0 ||
    !Number.isSafeInteger(hashedMediaCount) ||
    hashedMediaCount !== catalogMediaCount
  ) {
    fail("Library-bound backup requires canonical SHA-256 hashes for every media row. Complete a full scan before backup.");
  }
  if (!Number.isSafeInteger(catalogMediaCount) || catalogMediaCount < 0) {
    fail("The library catalog returned an invalid media count.");
  }
  const sampleOutput = await runSnapshotSql(
    "SELECT relative_path, lower(content_hash) FROM media_files WHERE content_hash ~ '^[a-fA-F0-9]{64}$' ORDER BY relative_path LIMIT 32",
    environment,
    snapshot,
    "Library media identity sample",
  );
  const mediaSamples = sampleOutput.trim()
    ? sampleOutput.trim().split(/\r?\n/).map((line) => {
        const [relativePath, sha256] = line.split("\t");
        return { relativePath, sha256 };
      })
    : [];
  return {
    libraryId: identity.libraryId,
    root: identity.root,
    markerSha256: identity.markerSha256,
    catalogMediaCount,
    mediaSamples,
  };
}

async function createBackup(options) {
  const outputRoot = resolveBackupRoot(options);
  const retentionDays = integerOption(options, "retention-days", DEFAULT_RETENTION_DAYS);
  const keep = integerOption(options, "keep", DEFAULT_KEEP, 1);
  const environment = databaseConnection(options);
  const secret = await passphrase(true);
  const actualWorkRoot = path.join(os.tmpdir(), `willard-db-backup-${randomBytes(8).toString("hex")}`);
  await mkdir(actualWorkRoot, { recursive: true });
  const rawDump = path.join(actualWorkRoot, "database.dump");
  const staging = path.join(outputRoot, `.staging-${randomBytes(8).toString("hex")}`);
  let finalDir;
  let snapshotHolder;
  try {
    await mkdir(outputRoot, { recursive: true });
    snapshotHolder = await openDatabaseSnapshot(environment);
    const { snapshot } = snapshotHolder;
    const createdAt = new Date().toISOString();
    const databaseName = await sourceDatabaseName(environment, snapshot);
    const facts = await databaseFacts(environment, snapshot);
    const compatibility = await sourceCompatibility(environment, snapshot);
    const library = await sourceLibrary(environment, snapshot);
    await runTool(
      resolveBinary("PGDUMP_BIN", "pg_dump", "pg_dump.exe"),
      ["--format=custom", "--no-owner", "--no-acl", "--snapshot", snapshot, "--file", rawDump],
      environment,
      "PostgreSQL backup",
    );
    await snapshotHolder.release();
    snapshotHolder = null;
    const dump = await readFile(rawDump);
    const manifest = {
      schema: SCHEMA_VERSION,
      format: FORMAT,
      createdAt,
      database: { name: databaseName },
      compatibility,
      library,
      encryption: {
        algorithm: ALGORITHM,
        kdf: SCRYPT,
        salt: randomBytes(16).toString("base64"),
        iv: randomBytes(12).toString("base64"),
      },
      dump: {
        file: DUMP_FILE,
        plaintextBytes: dump.length,
        plaintextSha256: sha256Bytes(dump),
      },
      verification: facts,
      integrity: {
        encryptedBytes: 0,
        encryptedSha256: "",
        authTag: "",
      },
    };
    const encrypted = encryptDump(dump, manifest, secret);
    manifest.integrity.encryptedBytes = encrypted.length;
    manifest.integrity.encryptedSha256 = sha256Bytes(encrypted);
    validateManifest(manifest);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    await writeFile(path.join(staging, DUMP_FILE), encrypted, { mode: 0o600 });
    await writeFile(path.join(staging, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    const suffix = randomBytes(4).toString("hex");
    finalDir = path.join(outputRoot, `backup-${createdAt.replace(/[-:.]/g, "")}-${suffix}`);
    await rename(staging, finalDir);
    const removed = await pruneBackups(outputRoot, retentionDays, keep);
    console.log(`Encrypted database backup created: ${finalDir}`);
    if (removed.length) console.log(`Retention removed ${removed.length} older backup(s).`);
    return finalDir;
  } finally {
    await snapshotHolder?.release().catch(() => {});
    await secureRemove(rawDump);
    await rm(actualWorkRoot, { recursive: true, force: true }).catch(() => {});
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

async function listBackupDirectories(outputRoot) {
  const entries = await readdir(outputRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const backups = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("backup-")) continue;
    try {
      const manifest = validateManifest(JSON.parse(await readFile(path.join(outputRoot, entry.name, MANIFEST_FILE), "utf8")));
      backups.push({ path: path.join(outputRoot, entry.name), manifest });
    } catch {
      // Retention never deletes an unrecognized directory.
    }
  }
  return backups.sort((left, right) => Date.parse(right.manifest.createdAt) - Date.parse(left.manifest.createdAt));
}

async function pruneBackups(outputRoot, retentionDays, keep) {
  const backups = await listBackupDirectories(outputRoot);
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const removed = [];
  for (const [index, backup] of backups.entries()) {
    if (index < keep || Date.parse(backup.manifest.createdAt) >= cutoff) continue;
    await rm(backup.path, { recursive: true, force: true });
    removed.push(backup.path);
  }
  return removed;
}

async function cleanTarget(environment) {
  const output = await runSql(
    "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')",
    environment,
    "Restore target safety check",
  );
  const count = output.trim();
  if (!/^\d+$/.test(count)) fail("Could not determine whether the restore target is empty.");
  if (count !== "0") {
    fail("Restore target is not empty. Create a new disposable PostgreSQL database and retry; existing data is never overwritten.");
  }
}

function recoveryJournalPath(targetRoot, manifest) {
  return path.join(
    normalizeLibraryRoot(targetRoot),
    "WillardAI",
    "config",
    "recovery-attempts",
    `${manifest.integrity.encryptedSha256}.json`,
  );
}

function recoveryJournalKey(manifest, secret) {
  return scryptSync(secret, Buffer.from(manifest.encryption.salt, "base64"), 32, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 64 * 1024 * 1024,
  });
}

function signRecoveryJournal(journal, manifest, secret) {
  return createHmac("sha256", recoveryJournalKey(manifest, secret))
    .update(stableJson(journal))
    .digest("hex");
}

async function createRecoveryTargetIdentity(environment, manifest) {
  const targetDatabase = await sourceDatabaseName(environment);
  const recoveryToken = `willard-recovery:${manifest.integrity.encryptedSha256}:${randomBytes(16).toString("hex")}`;
  await runSql(
    `COMMENT ON DATABASE ${quoteIdentifier(targetDatabase)} IS ${sqlLiteral(recoveryToken)}`,
    environment,
    "Recovery target identity creation",
  );
  const output = await runSql(
    "SELECT oid::text || E'\\t' || COALESCE(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = current_database()",
    environment,
    "Recovery target identity inspection",
  );
  const [databaseOid, comment] = output.trim().split("\t");
  if (!/^\d+$/.test(databaseOid) || comment !== recoveryToken) {
    fail("Could not bind the recovery journal to the empty target database.");
  }
  return { targetDatabase, databaseOid, recoveryToken };
}

async function writeRecoveryJournal(targetRoot, manifest, secret, targetIdentity, state, detail = null) {
  const filePath = recoveryJournalPath(targetRoot, manifest);
  const authenticated = {
    format: 1,
    backupSha256: manifest.integrity.encryptedSha256,
    libraryId: manifest.library.libraryId,
    targetIdentity,
    state,
    updatedAt: new Date().toISOString(),
    detail,
  };
  const journal = { ...authenticated, hmacSha256: signRecoveryJournal(authenticated, manifest, secret) };
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.partial`;
  await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filePath);
  return journal;
}

async function validateRecoveryJournal(targetRoot, manifest, secret, environment) {
  let journal;
  try {
    journal = JSON.parse(await readFile(recoveryJournalPath(targetRoot, manifest), "utf8"));
  } catch {
    fail("Recovery resume refused: no matching recovery journal exists on the attached NAS.");
  }
  const { hmacSha256, ...authenticated } = journal || {};
  const expected = signRecoveryJournal(authenticated, manifest, secret);
  if (
    typeof hmacSha256 !== "string" ||
    hmacSha256.length !== expected.length ||
    !timingSafeEqual(Buffer.from(hmacSha256), Buffer.from(expected))
  ) {
    fail("Recovery resume refused: the NAS recovery journal authentication failed.");
  }
  const targetDatabase = await sourceDatabaseName(environment);
  const identityOutput = await runSql(
    "SELECT oid::text || E'\\t' || COALESCE(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = current_database()",
    environment,
    "Recovery resume target identity inspection",
  );
  const [databaseOid, recoveryToken] = identityOutput.trim().split("\t");
  if (
    journal?.format !== 1 ||
    journal.backupSha256 !== manifest.integrity.encryptedSha256 ||
    journal.libraryId !== manifest.library.libraryId ||
    journal.targetIdentity?.targetDatabase !== targetDatabase ||
    journal.targetIdentity?.databaseOid !== databaseOid ||
    journal.targetIdentity?.recoveryToken !== recoveryToken ||
    !["RESTORING", "RESTORED", "REMAP_FAILED", "COMPLETE"].includes(journal.state)
  ) {
    fail("Recovery resume refused: the NAS recovery journal does not match this backup and target database.");
  }
  return journal;
}

async function verifyLibraryMediaSamples(manifestLibrary, targetLibrary) {
  for (const sample of manifestLibrary.mediaSamples) {
    const candidate = path.resolve(targetLibrary.root, sample.relativePath);
    const relative = path.relative(targetLibrary.root, candidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      fail(`Recovery refused: invalid sampled media path ${sample.relativePath}.`);
    }
    let bytes;
    try {
      bytes = await readFile(candidate);
    } catch {
      fail(`Recovery refused: sampled canonical media is missing: ${sample.relativePath}.`);
    }
    if (sha256Bytes(bytes) !== sample.sha256) {
      fail(`Recovery refused: sampled canonical media hash does not match: ${sample.relativePath}.`);
    }
  }
}

async function verifyRestoredLibraryInventory(environment, manifestLibrary, targetLibrary) {
  const output = await runSql(
    "SELECT relative_path, lower(content_hash) FROM media_files ORDER BY relative_path",
    environment,
    "Restored canonical media inventory",
  );
  const rows = output.trim()
    ? output.trim().split(/\r?\n/).map((line) => line.split("\t"))
    : [];
  if (rows.length !== manifestLibrary.catalogMediaCount) {
    fail(
      `Recovery refused: restored catalog has ${rows.length} media rows but the authenticated backup records ` +
      `${manifestLibrary.catalogMediaCount}.`,
    );
  }
  for (const [relativePath, expectedHash] of rows) {
    if (
      !relativePath ||
      path.isAbsolute(relativePath) ||
      relativePath.split(/[\\/]+/).includes("..") ||
      !/^[a-f0-9]{64}$/i.test(expectedHash || "")
    ) {
      fail("Recovery refused: the restored catalog contains an invalid canonical media identity.");
    }
    const candidate = path.resolve(targetLibrary.root, relativePath);
    const relative = path.relative(targetLibrary.root, candidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      fail(`Recovery refused: invalid catalog media path ${relativePath}.`);
    }
    let bytes;
    try {
      bytes = await readFile(candidate);
    } catch {
      fail(`Recovery refused: cataloged original is missing from the attached NAS: ${relativePath}.`);
    }
    if (sha256Bytes(bytes) !== expectedHash) {
      fail(`Recovery refused: cataloged original hash does not match the attached NAS: ${relativePath}.`);
    }
  }
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function pathPrefixCondition(column, sourceLiteral, sourceHasTrailingSeparator) {
  if (sourceHasTrailingSeparator) {
    return `left(${column}, length(${sourceLiteral})) = ${sourceLiteral}`;
  }
  return `(${column} = ${sourceLiteral} OR (left(${column}, length(${sourceLiteral})) = ${sourceLiteral} AND substring(${column}, length(${sourceLiteral}) + 1, 1) IN ('/', E'\\\\')))`;
}

function remapExpression(column, sourceLiteral, targetLiteral) {
  return `${targetLiteral} || substring(${column} from length(${sourceLiteral}) + 1)`;
}

function buildLibraryRemapSql(sourceRoot, targetRoot) {
  const source = normalizeLibraryRoot(sourceRoot);
  const target = normalizeLibraryRoot(targetRoot);
  if (source === target) return "";
  const sourceHasTrailingSeparator = /[\\/]$/.test(source);
  const sourceLiteral = sqlLiteral(source);
  const targetLiteral = sqlLiteral(target);
  const statements = ["BEGIN"];
  for (const [table, column, mode] of DURABLE_PATH_COLUMNS) {
    const identifier = `"${table.replaceAll('"', '""')}"`;
    const field = `"${column.replaceAll('"', '""')}"`;
    const condition = mode === "exact"
      ? `${field} = ${sourceLiteral}`
      : pathPrefixCondition(field, sourceLiteral, sourceHasTrailingSeparator);
    statements.push(`UPDATE ${identifier} SET ${field} = ${remapExpression(field, sourceLiteral, targetLiteral)} WHERE ${condition}`);
  }
  statements.push(`
CREATE FUNCTION pg_temp.willard_remap_jsonb(input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $willard$
DECLARE
  text_value text;
BEGIN
  CASE jsonb_typeof(input)
    WHEN 'object' THEN
      RETURN (SELECT jsonb_object_agg(key, pg_temp.willard_remap_jsonb(value)) FROM jsonb_each(input));
    WHEN 'array' THEN
      RETURN (SELECT jsonb_agg(pg_temp.willard_remap_jsonb(value)) FROM jsonb_array_elements(input));
    WHEN 'string' THEN
      text_value := input #>> '{}';
      IF ${
        sourceHasTrailingSeparator
          ? `left(text_value, length(${sourceLiteral})) = ${sourceLiteral}`
          : `text_value = ${sourceLiteral}
         OR (left(text_value, length(${sourceLiteral})) = ${sourceLiteral}
             AND substring(text_value, length(${sourceLiteral}) + 1, 1) IN ('/', E'\\\\'))`
      } THEN
        RETURN to_jsonb((${targetLiteral} || substring(text_value from length(${sourceLiteral}) + 1))::text);
      END IF;
  END CASE;
  RETURN input;
END
$willard$`);
  for (const [table, column] of DURABLE_JSON_COLUMNS) {
    const identifier = `"${table.replaceAll('"', '""')}"`;
    const field = `"${column.replaceAll('"', '""')}"`;
    statements.push(
      `UPDATE ${identifier} SET ${field} = pg_temp.willard_remap_jsonb(${field}) WHERE ${field} IS NOT NULL AND pg_temp.willard_remap_jsonb(${field}) IS DISTINCT FROM ${field}`,
    );
  }
  statements.push("COMMIT");
  return `${statements.join(";\n")};`;
}

async function remapRestoredLibrary(environment, sourceRoot, targetRoot) {
  const sql = buildLibraryRemapSql(sourceRoot, targetRoot);
  if (sql) await runSql(sql, environment, "Restored library path reconciliation");
}

async function assertTargetCompatibility(environment, manifest) {
  if (
    manifest.compatibility?.applicationSchemaVersion !== null &&
    manifest.compatibility?.applicationSchemaVersion !== SUPPORTED_APPLICATION_SCHEMA_VERSION
  ) {
    fail(
      `Backup application schema ${manifest.compatibility.applicationSchemaVersion} is not supported by this recovery utility ` +
      `(expected ${SUPPORTED_APPLICATION_SCHEMA_VERSION}).`,
    );
  }
  if (manifest.compatibility?.postgresMajor == null) return;
  const output = await runSql("SHOW server_version_num", environment, "Restore target compatibility inspection");
  const version = Number(output.trim());
  const targetMajor = Math.floor(version / 10000);
  if (!Number.isSafeInteger(version) || targetMajor !== manifest.compatibility.postgresMajor) {
    fail(
      `Restore target PostgreSQL major ${Number.isFinite(targetMajor) ? targetMajor : "unknown"} ` +
      `does not match backup major ${manifest.compatibility.postgresMajor}.`,
    );
  }
}

function compareFacts(expected, actual) {
  if (expected.schemaSha256 !== actual.schemaSha256) {
    fail("Restored database schema verification failed.");
  }
  const expectedKeys = Object.keys(expected.rowCounts).sort();
  const actualKeys = Object.keys(actual.rowCounts).sort();
  if (stableJson(expectedKeys) !== stableJson(actualKeys)) fail("Restored database table verification failed.");
  for (const key of expectedKeys) {
    if (expected.rowCounts[key] !== actual.rowCounts[key]) {
      fail(`Restored database row-count verification failed for ${key}.`);
    }
  }
}

async function restoreBackup(options) {
  const backupDir = path.resolve(requireOption(options, "backup-dir"));
  const { manifest, encrypted } = await readBackup(backupDir);
  const secret = await passphrase();
  const dump = decryptDump(encrypted, manifest, secret);
  if (dump.length !== manifest.dump.plaintextBytes || sha256Bytes(dump) !== manifest.dump.plaintextSha256) {
    fail("Decrypted database dump failed its SHA-256 integrity check.");
  }
  const environment = databaseConnection(options, true);
  const targetRoot = options["library-root"];
  let targetLibrary = null;
  if (manifest.library) {
    if (typeof targetRoot !== "string" || !targetRoot.trim()) {
      fail("This backup is library-bound. Restore it with --library-root pointing at the existing NAS library.");
    }
    if (options["confirm-library-id"] !== manifest.library.libraryId) {
      fail(
        "Recovery requires --confirm-library-id with the authenticated library ID. " +
        "This operator attestation prevents an identity marker copied by itself from silently authorizing a restore.",
      );
    }
    try {
      targetLibrary = await readLibraryIdentity(targetRoot);
    } catch (error) {
      fail(`Recovery refused: ${error instanceof Error ? error.message : String(error)}`);
    }
    validateRecoveryAttachment(manifest.library, targetLibrary);
    await verifyLibraryMediaSamples(manifest.library, targetLibrary);
  }
  await assertTargetCompatibility(environment, manifest);
  let targetEmpty = true;
  let recoveryTargetIdentity = null;
  try {
    await cleanTarget(environment);
  } catch (error) {
    targetEmpty = false;
    if (!options["resume-recovery"] || !manifest.library || !targetLibrary) throw error;
    const journal = await validateRecoveryJournal(targetLibrary.root, manifest, secret, environment);
    recoveryTargetIdentity = journal.targetIdentity;
    const currentFacts = await databaseFacts(environment);
    compareFacts(manifest.verification, currentFacts);
  }
  const temporaryDump = path.join(os.tmpdir(), `willard-db-restore-${randomBytes(8).toString("hex")}.dump`);
  try {
    if (targetEmpty) {
      if (manifest.library && targetLibrary) {
        recoveryTargetIdentity = await createRecoveryTargetIdentity(environment, manifest);
        await writeRecoveryJournal(
          targetLibrary.root, manifest, secret, recoveryTargetIdentity, "RESTORING",
        );
      }
      await writeFile(temporaryDump, dump, { mode: 0o600 });
      const targetDatabase = environment.PGDATABASE || "postgres";
      await runTool(
        resolveBinary("PGRESTORE_BIN", "pg_restore", "pg_restore.exe"),
        [
          "--exit-on-error",
          "--single-transaction",
          "--no-owner",
          "--no-acl",
          "--dbname",
          targetDatabase,
          temporaryDump,
        ],
        environment,
        "PostgreSQL restore",
      );
      if (manifest.library && targetLibrary) {
        await writeRecoveryJournal(
          targetLibrary.root, manifest, secret, recoveryTargetIdentity, "RESTORED",
        );
      }
    }
    if (manifest.library && targetLibrary) {
      await verifyRestoredLibraryInventory(environment, manifest.library, targetLibrary);
      try {
        await remapRestoredLibrary(environment, manifest.library.root, targetLibrary.root);
      } catch (error) {
        await writeRecoveryJournal(
          targetLibrary.root,
          manifest,
          secret,
          recoveryTargetIdentity,
          "REMAP_FAILED",
          error instanceof Error ? error.message : String(error),
        ).catch(() => {});
        throw error;
      }
    }
    const actualFacts = await databaseFacts(environment);
    compareFacts(manifest.verification, actualFacts);
    if (manifest.library && targetLibrary) {
      await writeRecoveryJournal(
        targetLibrary.root, manifest, secret, recoveryTargetIdentity, "COMPLETE",
      );
    }
    console.log(`Database restored and verified: ${backupDir}`);
  } finally {
    await secureRemove(temporaryDump);
  }
}

async function verifyBackup(options) {
  const backupDir = path.resolve(requireOption(options, "backup-dir"));
  const { manifest, encrypted } = await readBackup(backupDir);
  const dump = decryptDump(encrypted, manifest, await passphrase());
  if (dump.length !== manifest.dump.plaintextBytes || sha256Bytes(dump) !== manifest.dump.plaintextSha256) {
    fail("Decrypted database dump failed its SHA-256 integrity check.");
  }
  console.log(`Backup integrity verified: ${backupDir}`);
}

function printHelp() {
  console.log(`Willard Media Center PostgreSQL recovery

Commands:
  backup [--output-dir DIR] [--retention-days N] [--keep N]
  restore --backup-dir DIR [--library-root NAS_LIBRARY] [--confirm-library-id ID]
          [--resume-recovery]
  verify --backup-dir DIR

Connection:
  DATABASE_URL identifies the source database for backup.
  WILLARD_RESTORE_DATABASE_URL identifies the clean restore target.
  WILLARD_BACKUP_PASSPHRASE supplies the encryption passphrase for automation.
  PGDUMP_BIN, PGRESTORE_BIN, and PSQL_BIN override PostgreSQL tool paths.

Backups contain database metadata only; media files remain on the NAS and must
be reconciled by scanning the active library after a restore. Library-bound
backups require the existing NAS identity marker and safely remap path-bearing
catalog references when the clean machine uses a different mount path.`);
}

async function main() {
  loadEnvironmentFile();
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "backup" || command === "create") {
    await createBackup(options);
    return;
  }
  if (command === "restore") {
    await restoreBackup(options);
    return;
  }
  if (command === "verify") {
    await verifyBackup(options);
    return;
  }
  fail(`Unknown command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

export {
  ALGORITHM,
  FORMAT,
  SCHEMA_VERSION,
  SUPPORTED_APPLICATION_SCHEMA_VERSION,
  authenticatedManifestPart,
  compareFacts,
  buildLibraryRemapSql,
  decryptDump,
  encryptDump,
  stableJson,
  validateManifest,
};