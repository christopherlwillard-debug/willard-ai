import assert from "node:assert/strict";
import { createServer } from "node:net";
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
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

test(
  "backs up encrypted PostgreSQL data and restores it into a clean database",
  { timeout: 120_000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "willard-db-drill-"));
    const dataDir = path.join(root, "data");
    const socketDir = path.join(root, "socket");
    const backupRoot = path.join(root, "backups");
    const tamperedBackup = path.join(root, "tampered-backup");
    const tamperedManifestBackup = path.join(root, "tampered-manifest-backup");
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
      await run(psqlBin, [
        "-X",
        "--no-password",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        "CREATE TABLE catalog_items (id integer PRIMARY KEY, title text NOT NULL); INSERT INTO catalog_items VALUES (1, 'nas photo'), (2, 'family video'); CREATE TABLE empty_table (id integer PRIMARY KEY);",
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
      assert.equal(manifest.encryption.algorithm, "aes-256-gcm");
      assert.equal(manifest.verification.rowCounts["public.catalog_items"], "2");
      assert.equal(manifest.verification.rowCounts["public.empty_table"], "0");
      assert.ok(!encrypted.includes(Buffer.from("nas photo")));
      await runCli(["verify", "--backup-dir", backupDir], {
        WILLARD_BACKUP_PASSPHRASE: passphrase,
      });

      await runCli(["restore", "--backup-dir", backupDir], {
        DATABASE_URL: sourceUrl,
        WILLARD_RESTORE_DATABASE_URL: targetUrl,
        WILLARD_BACKUP_PASSPHRASE: passphrase,
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
      await assert.rejects(
        runCli(["restore", "--backup-dir", backupDir], {
          WILLARD_RESTORE_DATABASE_URL: targetUrl,
          WILLARD_BACKUP_PASSPHRASE: passphrase,
        }),
        /not empty/,
      );

      await cp(backupDir, tamperedBackup, { recursive: true });
      const tamperedFile = path.join(tamperedBackup, "database.dump.enc");
      const tamperedBytes = await readFile(tamperedFile);
      tamperedBytes[0] ^= 0xff;
      await writeFile(tamperedFile, tamperedBytes);
      await assert.rejects(
        runCli(["restore", "--backup-dir", tamperedBackup], {
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
        runCli(["restore", "--backup-dir", tamperedManifestBackup], {
          WILLARD_RESTORE_DATABASE_URL: targetUrl,
          WILLARD_BACKUP_PASSPHRASE: passphrase,
        }),
        /passphrase or authenticated backup metadata/,
      );

      await new Promise((resolve) => setTimeout(resolve, 20));
      await runCli(["backup", "--output-dir", backupRoot, "--retention-days", "0", "--keep", "1"], {
        DATABASE_URL: sourceUrl,
        WILLARD_BACKUP_PASSPHRASE: passphrase,
      });
      const retained = (await readdir(backupRoot, { withFileTypes: true })).filter(
        (entry) => entry.isDirectory() && entry.name.startsWith("backup-"),
      );
      assert.equal(retained.length, 1);
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