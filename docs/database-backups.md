# Willard Media Center database backups

Willard's PostgreSQL database contains authentication, settings, the media
catalog, people, jobs, search data, and user annotations. The media files
themselves stay on the configured local/NAS library and are **not** copied into
this backup.

The supported backup format is an encrypted directory containing:

- `database.dump.enc`: a PostgreSQL custom-format dump encrypted with
  AES-256-GCM;
- `manifest.json`: authenticated encryption metadata, SHA-256 digests, the
  source database name, a schema fingerprint, and exact table row counts.

The manifest metadata and ciphertext are authenticated. A restore refuses an
altered backup, a wrong passphrase, a non-empty target database, a schema
mismatch, or a row-count mismatch.

## Backup policy

1. Store backups on a different physical device from the database, preferably
   an encrypted NAS share plus a second offline copy.
2. Use a backup-only PostgreSQL login with `CONNECT` and read access, not the
   application superuser.
3. Keep at least 12 backups and 30 days of history. The command keeps the most
   recent 12 even when they are newer than the retention window.
4. Protect the backup encryption passphrase separately from the NAS and
   PostgreSQL passwords. Without it, an encrypted backup cannot be restored.
5. Run a restore drill at least once per release and after changing the
   PostgreSQL major version.

The default local output is `backups/database`, which is ignored by Git. For a
real installation, always choose a separate backup destination.

## Create a least-privilege backup login

Run the following as the PostgreSQL database owner or administrator. Replace
the placeholders; do not commit the password.

```sql
CREATE ROLE willard_backup LOGIN PASSWORD 'use-a-long-random-password';
GRANT CONNECT ON DATABASE willard TO willard_backup;
GRANT USAGE ON SCHEMA public TO willard_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO willard_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO willard_backup;
```

Run the default-privilege statement as each role that creates Willard tables so
new tables remain backed up:

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE willard_app IN SCHEMA public
  GRANT SELECT ON TABLES TO willard_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE willard_app IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO willard_backup;
```

Point `DATABASE_URL` at this login when running the backup command. Restore
with the database owner or a dedicated restore role that can create objects in
the empty target; the backup login is intentionally not granted restore
permissions.

## Create a backup on Windows

Stop heavy catalog writes first if possible. This keeps the manifest's row
counts aligned with the dump snapshot and makes the restore drill meaningful.
From the Willard folder, run:

```powershell
node .\desktop\database-backup.mjs backup `
  --output-dir "Z:\WillardBackups\Database" `
  --retention-days 30 `
  --keep 12
```

The utility loads `DATABASE_URL` from `.env` when it is not already in the
environment. It prompts for the backup passphrase without echoing it. For
scheduled jobs, set `WILLARD_BACKUP_PASSPHRASE` through the scheduler's
protected secret store for that process only; do not put it in `.env` or a
command-line argument.

The installed release includes the same utility. Use its bundled runtime:

```powershell
$install = "$env:LOCALAPPDATA\Willard Media Center"
& "$install\runtime\node.exe" "$install\desktop\database-backup.mjs" backup `
  --output-dir "Z:\WillardBackups\Database"
```

After the command finishes, copy or replicate the complete backup directory
to the second backup destination. Do not rename files inside a backup
directory.

## Verify a backup without restoring it

This checks the encrypted file's size and SHA-256 digest, decrypts it, checks
the AES-GCM authentication tag, and verifies the plaintext dump digest:

```powershell
node .\desktop\database-backup.mjs verify `
  --backup-dir "Z:\WillardBackups\Database\backup-<timestamp>-<id>"
```

Verification does not contact PostgreSQL and does not change the database.

## Restore into a clean database

A restore is deliberately non-destructive. The target must be a new empty
database; the utility refuses to overwrite an existing user table.

1. Stop Willard and make sure no process is writing to the target database.
2. Create a fresh database from `template0` as a PostgreSQL administrator:

   ```sql
   CREATE DATABASE willard_restore OWNER willard_app TEMPLATE template0;
   ```

   Install any PostgreSQL extensions used by the source database before the
   restore, if they are not already available on the server.
3. Set the target URL only for the restore process:

   ```powershell
   $env:WILLARD_RESTORE_DATABASE_URL =
     "postgresql://willard_app:password@localhost:5432/willard_restore"
   node .\desktop\database-backup.mjs restore `
     --backup-dir "Z:\WillardBackups\Database\backup-<timestamp>-<id>"
   Remove-Item Env:\WILLARD_RESTORE_DATABASE_URL
   ```

   If the target URL is omitted, `DATABASE_URL` is used. The source database
   is never modified by the restore command.
4. The command decrypts to a short-lived protected temporary file, runs
   `pg_restore --single-transaction --no-owner --no-acl`, removes the temporary
   plaintext dump, then checks the schema fingerprint and every recorded table
   row count.
5. Point the app's `.env` at the verified restored database, run the normal
   database setup/readiness step, and start Willard.

If row counts do not match, stop the app and retry from a new clean database
after quiescing catalog writes. Never use `--clean` against the production
database and never restore over a database that contains user tables.

## Media reconciliation after restore

The database backup does not contain photos, videos, documents, archives,
thumbnails, or other media derivatives. Those files remain on the NAS. After
the restored database is selected:

1. Open **Settings → Libraries** and confirm the active library points to the
   same NAS path.
2. Confirm the NAS is online and accessible to the account running Willard.
3. Run a full library scan.
4. Review the scan result for missing files and newly discovered files.
5. Allow thumbnails, embeddings, face data, and other rebuildable derived data
   to regenerate when the restored catalog does not contain them.

A database restore recovers catalog metadata and user decisions; it does not
claim that a missing NAS file was recovered. File recovery and database
recovery remain separate procedures.

## Restore drill

The repository's `pnpm run test:database-backup` test starts a disposable
PostgreSQL cluster, creates representative catalog rows, creates and verifies
an encrypted backup, restores it into a separate clean database, checks the
recovered values, proves ciphertext tampering is rejected, and checks
retention pruning. This is an automated safety net, not a substitute for a
Windows/NAS drill using the actual operator backup destination.