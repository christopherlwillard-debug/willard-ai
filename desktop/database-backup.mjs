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
  randomBytes,
  scryptSync,
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORMAT = "willard-postgresql-backup";
const SCHEMA_VERSION = 1;
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
    ["-X", "--no-password", "-v", "ON_ERROR_STOP=1", "-At", "-F", "\t", "-c", sql],
    environment,
    label,
  );
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function databaseFacts(environment) {
  const tableOutput = await runSql(
    "SELECT schemaname, tablename FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY schemaname, tablename",
    environment,
    "Database table inspection",
  );
  const rowCounts = {};
  for (const line of tableOutput.trim() ? tableOutput.trim().split(/\r?\n/) : []) {
    const [schema, table] = line.split("\t");
    if (!schema || !table) fail("PostgreSQL returned an invalid table list during verification.");
    const key = `${schema}.${table}`;
    const countOutput = await runSql(
      `SELECT count(*) FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`,
      environment,
      `Row-count inspection for ${key}`,
    );
    const count = countOutput.trim();
    if (!/^\d+$/.test(count)) fail(`PostgreSQL returned an invalid row count for ${key}.`);
    rowCounts[key] = count;
  }

  const schemaOutput = await runSql(
    "SELECT table_schema, table_name, ordinal_position, column_name, data_type, udt_name, is_nullable, COALESCE(column_default, '') FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name, ordinal_position",
    environment,
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

async function sourceDatabaseName(environment) {
  const output = await runSql("SELECT current_database()", environment, "Database identity inspection");
  return output.trim();
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
  try {
    await mkdir(outputRoot, { recursive: true });
    await runTool(
      resolveBinary("PGDUMP_BIN", "pg_dump", "pg_dump.exe"),
      ["--format=custom", "--no-owner", "--no-acl", "--file", rawDump],
      environment,
      "PostgreSQL backup",
    );
    const dump = await readFile(rawDump);
    const createdAt = new Date().toISOString();
    const databaseName = await sourceDatabaseName(environment);
    const facts = await databaseFacts(environment);
    const manifest = {
      schema: SCHEMA_VERSION,
      format: FORMAT,
      createdAt,
      database: { name: databaseName },
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
  await cleanTarget(environment);
  const temporaryDump = path.join(os.tmpdir(), `willard-db-restore-${randomBytes(8).toString("hex")}.dump`);
  try {
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
    const actualFacts = await databaseFacts(environment);
    compareFacts(manifest.verification, actualFacts);
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
  restore --backup-dir DIR
  verify --backup-dir DIR

Connection:
  DATABASE_URL identifies the source database for backup.
  WILLARD_RESTORE_DATABASE_URL identifies the clean restore target.
  WILLARD_BACKUP_PASSPHRASE supplies the encryption passphrase for automation.
  PGDUMP_BIN, PGRESTORE_BIN, and PSQL_BIN override PostgreSQL tool paths.

Backups contain database metadata only; media files remain on the NAS and must
be reconciled by scanning the active library after a restore.`);
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
  authenticatedManifestPart,
  compareFacts,
  decryptDump,
  encryptDump,
  stableJson,
  validateManifest,
};