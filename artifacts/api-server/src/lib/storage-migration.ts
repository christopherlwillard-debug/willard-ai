import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pool } from "@workspace/db";

export const STORAGE_MIGRATION_VERSION = 1;
export const STORAGE_MIGRATION_NAMESPACES = [
  { id: "thumbnails", label: "Thumbnails", relativeRoot: "WillardAI/cache/thumbnails", protected: false },
  { id: "previews", label: "Previews", relativeRoot: "WillardAI/cache/previews", protected: false },
  { id: "documents", label: "Document previews", relativeRoot: "WillardAI/cache/documents", protected: false },
  { id: "transcodes", label: "Transcodes", relativeRoot: "WillardAI/cache/transcodes", protected: false },
  { id: "face-crops", label: "Face crops", relativeRoot: "WillardAI/cache/faces", protected: false },
  { id: "ai-sidecars", label: "AI sidecars", relativeRoot: "WillardAI/sidecars", protected: false },
  { id: "conversion-backups", label: "Conversion backups", relativeRoot: "WillardAI/ConversionBackups", protected: true },
  { id: "conversion-staging", label: "Conversion staging", relativeRoot: "WillardAI/conversions", protected: false },
  { id: "archive-staging", label: "Archive staging", relativeRoot: "WillardAI/temp/archive-derived", protected: false },
  { id: "temporary", label: "Temporary artifacts", relativeRoot: "WillardAI/temp", protected: false },
  { id: "archive-index", label: "Archive indexes and reports", relativeRoot: "WillardAI/archive-index", protected: true },
  { id: "reports", label: "Operation reports", relativeRoot: "WillardAI/reports", protected: true },
] as const;

type MigrationNamespace = typeof STORAGE_MIGRATION_NAMESPACES[number];
export type MigrationEntryState = "pending" | "verified" | "conflict" | "missing" | "unsafe" | "error";
export type MigrationState = "PREVIEW" | "READY" | "COPYING" | "PAUSED" | "VERIFIED" | "FAILED" | "CLEANUP_PENDING" | "CLEANED";

export interface MigrationReference {
  table: "media_files" | "faces" | "conversion_jobs" | "organization_jobs";
  column: string;
  rowId: number;
  value: string;
}

export interface MigrationEntry {
  id: string;
  namespace: string;
  sourcePath: string;
  destinationPath: string;
  relativePath: string;
  sizeBytes: number;
  sourceHash: string | null;
  destinationHash: string | null;
  referenceCount: number;
  references: MigrationReference[];
  protected: boolean;
  state: MigrationEntryState;
  error?: string;
}

export interface StorageMigrationManifest {
  version: number;
  id: string;
  createdAt: string;
  updatedAt: string;
  state: MigrationState;
  sourceRoot: string;
  destinationRoot: string;
  sourceLabel: string;
  destinationLabel: string;
  requiredBytes: number;
  copiedBytes: number;
  verifiedBytes: number;
  freeBytes: number | null;
  capacitySafe: boolean | null;
  referenceCount: number;
  conflicts: number;
  unsafeFiles: number;
  missingFiles: number;
  eligibleFileCount: number;
  orphanedFiles: string[];
  entries: MigrationEntry[];
  cleanupConfirmed: boolean;
  cleanupCompletedAt?: string;
  error?: string;
}

export interface MigrationPreviewOptions {
  sourceRoot: string;
  destinationRoot: string;
  sourceLabel?: string;
  destinationLabel?: string;
  manifestDir: string;
  referenceRows?: MigrationReference[];
  now?: Date;
}

export interface MigrationServiceOptions {
  manifestDir: string;
  query?: (text: string, values?: unknown[]) => Promise<{ rows: any[] }>;
  connect?: () => Promise<{
    query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
    release: () => void;
  }>;
  hashFile?: (filePath: string) => Promise<string>;
  freeBytesAt?: (target: string) => Promise<number | null>;
}

type MigrationService = ReturnType<typeof createStorageMigrationService>;

const safeRoot = (value: string): string => path.resolve(value);
const samePath = (a: string, b: string): boolean => safeRoot(a) === safeRoot(b);
const allowedReferences = new Set([
  "media_files:thumbnail_path",
  "faces:crop_path",
  "conversion_jobs:backup_dir",
  "organization_jobs:report_path",
]);

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(safeRoot(root), safeRoot(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function relativeFor(sourceRoot: string, filePath: string): string {
  return path.relative(safeRoot(sourceRoot), safeRoot(filePath)).split(path.sep).join("/");
}

function destinationFor(destinationRoot: string, relativePath: string): string {
  const result = safeRoot(path.join(destinationRoot, relativePath));
  if (!isWithin(destinationRoot, result)) throw new Error(`Destination path escapes migration root: ${relativePath}`);
  return result;
}

async function defaultHashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function walkFiles(root: string, onUnsafe: (filePath: string, reason: string) => void): Promise<string[]> {
  const files: string[] = [];
  if (!fs.existsSync(root)) return files;
  const visit = async (directory: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      onUnsafe(directory, error instanceof Error ? error.message : String(error));
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        onUnsafe(fullPath, "Symbolic links are not movable migration inputs.");
      } else if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      } else {
        onUnsafe(fullPath, "Unsupported filesystem entry.");
      }
    }
  };
  await visit(root);
  return files;
}

async function freeBytesAt(target: string): Promise<number | null> {
  let candidate = safeRoot(target);
  while (true) {
    try {
      const stats = await fs.promises.statfs(candidate);
      const free = Number(stats.bavail) * Number(stats.bsize);
      return Number.isFinite(free) && free >= 0 ? free : null;
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return null;
      candidate = parent;
    }
  }
}

function manifestPath(manifestDir: string, id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid migration id");
  return path.join(manifestDir, `${id}.json`);
}

async function saveManifest(manifestDir: string, manifest: StorageMigrationManifest): Promise<void> {
  await fs.promises.mkdir(manifestDir, { recursive: true });
  const target = manifestPath(manifestDir, manifest.id);
  const temporary = `${target}.${process.pid}.partial`;
  await fs.promises.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.promises.rename(temporary, target);
}

async function readManifest(manifestDir: string, id: string): Promise<StorageMigrationManifest> {
  const content = await fs.promises.readFile(manifestPath(manifestDir, id), "utf8");
  const parsed = JSON.parse(content) as StorageMigrationManifest;
  if (parsed.version !== STORAGE_MIGRATION_VERSION || parsed.id !== id || !Array.isArray(parsed.entries)) {
    throw new Error("Migration manifest is invalid or from an unsupported version.");
  }
  if (typeof parsed.sourceRoot !== "string" || typeof parsed.destinationRoot !== "string" || samePath(parsed.sourceRoot, parsed.destinationRoot)) {
    throw new Error("Migration manifest has invalid roots.");
  }
  for (const entry of parsed.entries) {
    if (!isWithin(parsed.sourceRoot, entry.sourcePath) || !isWithin(parsed.destinationRoot, entry.destinationPath)) {
      throw new Error("Migration manifest contains a path outside its source or destination root.");
    }
    for (const reference of entry.references) {
      if (!allowedReferences.has(`${reference.table}:${reference.column}`)) {
        throw new Error("Migration manifest contains an unsupported database reference.");
      }
    }
  }
  return parsed;
}

function referencesForPath(references: MigrationReference[], sourceRoot: string, sourcePath: string): MigrationReference[] {
  return references.filter((reference) => {
    if (!reference.value || !isWithin(sourceRoot, reference.value)) return false;
    return samePath(reference.value, sourcePath) || isWithin(reference.value, sourcePath);
  });
}

async function databaseReferences(query: MigrationServiceOptions["query"]): Promise<MigrationReference[]> {
  if (!query) return [];
  const references: MigrationReference[] = [];
  const queries = [
    ["media_files", "thumbnail_path", "SELECT id, thumbnail_path AS value FROM media_files WHERE thumbnail_path IS NOT NULL"],
    ["faces", "crop_path", "SELECT id, crop_path AS value FROM faces WHERE crop_path IS NOT NULL"],
    ["conversion_jobs", "backup_dir", "SELECT id, backup_dir AS value FROM conversion_jobs WHERE backup_dir IS NOT NULL"],
    ["organization_jobs", "report_path", "SELECT id, report_path AS value FROM organization_jobs WHERE report_path IS NOT NULL"],
  ] as const;
  for (const [table, column, text] of queries) {
    const result = await query(text);
    for (const row of result.rows) {
      if (typeof row.value === "string" && Number.isInteger(Number(row.id))) {
        references.push({ table, column, rowId: Number(row.id), value: row.value });
      }
    }
  }
  return references;
}

function blankCounts(entries: MigrationEntry[]): Pick<StorageMigrationManifest, "requiredBytes" | "copiedBytes" | "verifiedBytes" | "referenceCount" | "conflicts" | "unsafeFiles" | "missingFiles"> {
  const countedReferences = new Set<string>();
  return entries.reduce((counts, entry) => {
    counts.requiredBytes += entry.state === "pending" || entry.state === "error" ? entry.sizeBytes : 0;
    counts.copiedBytes += entry.state === "verified" ? entry.sizeBytes : 0;
    counts.verifiedBytes += entry.state === "verified" ? entry.sizeBytes : 0;
    for (const reference of entry.references) {
      const key = `${reference.table}:${reference.column}:${reference.rowId}`;
      if (!countedReferences.has(key)) {
        countedReferences.add(key);
        counts.referenceCount++;
      }
    }
    counts.conflicts += entry.state === "conflict" ? 1 : 0;
    counts.unsafeFiles += entry.state === "unsafe" ? 1 : 0;
    counts.missingFiles += entry.state === "missing" ? 1 : 0;
    return counts;
  }, { requiredBytes: 0, copiedBytes: 0, verifiedBytes: 0, referenceCount: 0, conflicts: 0, unsafeFiles: 0, missingFiles: 0 });
}

function refreshedState(manifest: StorageMigrationManifest): MigrationState {
  if (manifest.state === "CLEANED") return "CLEANED";
  if (manifest.cleanupConfirmed) return "CLEANUP_PENDING";
  if (manifest.entries.some((entry) => entry.state === "conflict" || entry.state === "unsafe" || entry.state === "missing")) return "PREVIEW";
  if (manifest.entries.length > 0 && manifest.entries.every((entry) => entry.state === "verified")) return "VERIFIED";
  return manifest.state === "COPYING" ? "COPYING" : "READY";
}

export function createStorageMigrationService(options: MigrationServiceOptions) {
  const hashFile = options.hashFile ?? defaultHashFile;
  const getFreeBytes = options.freeBytesAt ?? freeBytesAt;
  const query = options.query;
  const connect = options.connect ?? (() => pool.connect() as any);

  async function preview(input: Omit<MigrationPreviewOptions, "manifestDir">): Promise<StorageMigrationManifest> {
    const sourceRoot = safeRoot(input.sourceRoot);
    const destinationRoot = safeRoot(input.destinationRoot);
    if (samePath(sourceRoot, destinationRoot)) throw new Error("Migration source and destination must be different.");
    if (!fs.existsSync(sourceRoot)) throw new Error("Migration source is not reachable.");

    const references = input.referenceRows ?? await databaseReferences(query);
    const unsafe: Array<{ path: string; reason: string }> = [];
    const entries: MigrationEntry[] = [];
    const seenSourcePaths = new Set<string>();
    const destinationCandidates = new Set<string>();
    for (const namespace of STORAGE_MIGRATION_NAMESPACES) {
      const sourceNamespace = path.join(sourceRoot, namespace.relativeRoot);
      const files = await walkFiles(sourceNamespace, (filePath, reason) => unsafe.push({ path: filePath, reason }));
      for (const sourcePath of files) {
        if (seenSourcePaths.has(safeRoot(sourcePath))) continue;
        seenSourcePaths.add(safeRoot(sourcePath));
        const relativePath = relativeFor(sourceRoot, sourcePath);
        const destinationPath = destinationFor(destinationRoot, relativePath);
        destinationCandidates.add(safeRoot(destinationPath));
        let stat: fs.Stats;
        try {
          stat = await fs.promises.stat(sourcePath);
        } catch (error) {
          entries.push({
            id: crypto.randomUUID(), namespace: namespace.id, sourcePath, destinationPath, relativePath,
            sizeBytes: 0, sourceHash: null, destinationHash: null, referenceCount: 0, references: [],
            protected: namespace.protected, state: "missing", error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        let sourceHash: string | null = null;
        try {
          sourceHash = await hashFile(sourcePath);
        } catch (error) {
          entries.push({
            id: crypto.randomUUID(), namespace: namespace.id, sourcePath, destinationPath, relativePath,
            sizeBytes: stat.size, sourceHash: null, destinationHash: null, referenceCount: 0, references: [],
            protected: namespace.protected, state: "unsafe", error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        let destinationHash: string | null = null;
        let destinationExists = false;
        try {
          const destinationStat = await fs.promises.stat(destinationPath);
          destinationExists = destinationStat.isFile();
          if (destinationExists) destinationHash = await hashFile(destinationPath);
        } catch { /* destination is absent */ }
        const fileReferences = referencesForPath(references, sourceRoot, sourcePath);
        entries.push({
          id: crypto.randomUUID(), namespace: namespace.id, sourcePath, destinationPath, relativePath,
          sizeBytes: stat.size, sourceHash, destinationHash, referenceCount: fileReferences.length,
          references: fileReferences, protected: namespace.protected,
          state: destinationExists && destinationHash === sourceHash ? "verified" : destinationExists ? "conflict" : "pending",
          ...(destinationExists && destinationHash !== sourceHash ? { error: "Destination already exists with different content." } : {}),
        });
      }
    }
    for (const item of unsafe) {
      entries.push({
        id: crypto.randomUUID(), namespace: "unsafe", sourcePath: item.path, destinationPath: destinationFor(destinationRoot, relativeFor(sourceRoot, item.path)),
        relativePath: relativeFor(sourceRoot, item.path), sizeBytes: 0, sourceHash: null, destinationHash: null,
        referenceCount: 0, references: [], protected: true, state: "unsafe", error: item.reason,
      });
    }
    const orphanedFiles: string[] = [];
    for (const namespace of STORAGE_MIGRATION_NAMESPACES) {
      const destinationNamespace = path.join(destinationRoot, namespace.relativeRoot);
      const files = await walkFiles(destinationNamespace, () => {});
      for (const filePath of files) {
        if (!destinationCandidates.has(safeRoot(filePath))) orphanedFiles.push(relativeFor(destinationRoot, filePath));
      }
    }
    const knownSourcePaths = new Set(entries.map((entry) => safeRoot(entry.sourcePath)));
    for (const reference of references) {
      if (!isWithin(sourceRoot, reference.value)) continue;
      const referencedPath = safeRoot(reference.value);
      if (knownSourcePaths.has(referencedPath)) continue;
      let referenceIsDirectory = false;
      try {
        referenceIsDirectory = (await fs.promises.stat(reference.value)).isDirectory();
      } catch { /* missing reference is reported below */ }
      if (referenceIsDirectory) continue;
      entries.push({
        id: crypto.randomUUID(), namespace: "database-reference", sourcePath: reference.value,
        destinationPath: destinationFor(destinationRoot, relativeFor(sourceRoot, reference.value)),
        relativePath: relativeFor(sourceRoot, reference.value), sizeBytes: 0, sourceHash: null,
        destinationHash: null, referenceCount: 1, references: [reference], protected: true,
        state: "missing", error: "Database reference has no matching source artifact.",
      });
      knownSourcePaths.add(referencedPath);
    }
    const counts = blankCounts(entries);
    const freeBytes = await getFreeBytes(destinationRoot);
    const capacitySafe = freeBytes === null ? null : freeBytes >= counts.requiredBytes;
    const manifest: StorageMigrationManifest = {
      version: STORAGE_MIGRATION_VERSION, id: crypto.randomUUID(), createdAt: (input.now ?? new Date()).toISOString(),
      updatedAt: (input.now ?? new Date()).toISOString(), state: "PREVIEW", sourceRoot, destinationRoot,
      sourceLabel: input.sourceLabel ?? sourceRoot, destinationLabel: input.destinationLabel ?? destinationRoot,
      ...counts, freeBytes, capacitySafe, entries, cleanupConfirmed: false,
      eligibleFileCount: entries.filter((entry) => entry.state !== "missing" && entry.state !== "unsafe").length,
      orphanedFiles,
    };
    manifest.state = refreshedState(manifest);
    await saveManifest(options.manifestDir, manifest);
    return manifest;
  }

  async function get(id: string): Promise<StorageMigrationManifest> {
    return readManifest(options.manifestDir, id);
  }

  async function list(): Promise<StorageMigrationManifest[]> {
    if (!fs.existsSync(options.manifestDir)) return [];
    const names = (await fs.promises.readdir(options.manifestDir))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .reverse();
    const manifests = await Promise.all(names.map((name) => readManifest(options.manifestDir, name.slice(0, -5))));
    return manifests.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async function copy(id: string): Promise<StorageMigrationManifest> {
    const manifest = await get(id);
    if (manifest.cleanupConfirmed || manifest.state === "CLEANED") throw new Error("This migration is in cleanup state and cannot be copied.");
    if (manifest.conflicts || manifest.unsafeFiles || manifest.missingFiles) throw new Error("Resolve conflicts, unsafe files, and missing sources before copying.");
    const freeBytes = await getFreeBytes(manifest.destinationRoot);
    const remainingBytes = manifest.entries
      .filter((entry) => entry.state !== "verified")
      .reduce((sum, entry) => sum + entry.sizeBytes, 0);
    if (freeBytes === null) {
      manifest.freeBytes = null;
      manifest.capacitySafe = null;
      manifest.state = "PAUSED";
      manifest.error = "Destination free space could not be measured; migration is paused fail-closed.";
      manifest.updatedAt = new Date().toISOString();
      await saveManifest(options.manifestDir, manifest);
      throw new Error(manifest.error);
    }
    if (freeBytes < remainingBytes) {
      manifest.freeBytes = freeBytes;
      manifest.capacitySafe = false;
      manifest.state = "PAUSED";
      manifest.error = "Destination does not have enough free space for the remaining verified copy.";
      manifest.updatedAt = new Date().toISOString();
      await saveManifest(options.manifestDir, manifest);
      throw new Error(manifest.error);
    }
    manifest.state = "COPYING";
    manifest.error = undefined;
    await saveManifest(options.manifestDir, manifest);
    try {
      for (const entry of manifest.entries) {
        if (entry.state === "verified") continue;
        if (!fs.existsSync(entry.sourcePath)) {
          entry.state = "missing";
          entry.error = "Source is no longer available.";
          throw new Error(entry.error);
        }
        if (fs.existsSync(entry.destinationPath)) {
          try {
            const existingHash = await hashFile(entry.destinationPath);
            if (existingHash === entry.sourceHash) {
              entry.destinationHash = existingHash;
              entry.state = "verified";
              Object.assign(manifest, blankCounts(manifest.entries), { updatedAt: new Date().toISOString() });
              await saveManifest(options.manifestDir, manifest);
              continue;
            }
          } catch { /* the atomic replacement below will report the real write error */ }
          entry.state = "conflict";
          entry.error = "Destination changed after the dry run.";
          throw new Error(entry.error);
        }
        const partialPath = `${entry.destinationPath}.${manifest.id}.partial`;
        await fs.promises.mkdir(path.dirname(entry.destinationPath), { recursive: true });
        try {
          await pipeline(createReadStream(entry.sourcePath), createWriteStream(partialPath, { flags: "w" }));
          const copiedHash = await hashFile(partialPath);
          if (copiedHash !== entry.sourceHash) {
            await fs.promises.rm(partialPath, { force: true });
            entry.state = "error";
            entry.error = "SHA-256 verification failed; partial destination removed.";
            throw new Error(entry.error);
          }
          await fs.promises.rename(partialPath, entry.destinationPath);
          entry.destinationHash = copiedHash;
        } catch (error) {
          await fs.promises.rm(partialPath, { force: true });
          throw error;
        }
        entry.state = "verified";
        const counts = blankCounts(manifest.entries);
        Object.assign(manifest, counts, { updatedAt: new Date().toISOString() });
        await saveManifest(options.manifestDir, manifest);
      }
      const allReferences = manifest.entries.flatMap((entry) => entry.references);
      if (allReferences.length > 0) {
        const client = await connect();
        try {
          await client.query("BEGIN");
          const updated = new Set<string>();
          for (const reference of allReferences) {
            if (!allowedReferences.has(`${reference.table}:${reference.column}`)) {
              throw new Error("Unsupported database reference in migration manifest.");
            }
            const key = `${reference.table}:${reference.column}:${reference.rowId}`;
            if (updated.has(key)) continue;
            updated.add(key);
            const exactEntry = manifest.entries.find((candidate) => samePath(candidate.sourcePath, reference.value));
            const destinationValue = exactEntry
              ? exactEntry.destinationPath
              : destinationFor(manifest.destinationRoot, relativeFor(manifest.sourceRoot, reference.value));
            await client.query(
              `UPDATE ${reference.table} SET ${reference.column} = $1 WHERE id = $2 AND ${reference.column} = $3`,
              [destinationValue, reference.rowId, reference.value],
            );
          }
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      }
      Object.assign(manifest, blankCounts(manifest.entries), { state: "VERIFIED", updatedAt: new Date().toISOString() });
      await saveManifest(options.manifestDir, manifest);
      return manifest;
    } catch (error) {
      manifest.state = "PAUSED";
      manifest.error = error instanceof Error ? error.message : String(error);
      manifest.updatedAt = new Date().toISOString();
      await saveManifest(options.manifestDir, manifest);
      throw error;
    }
  }

  async function confirmCleanup(id: string): Promise<StorageMigrationManifest> {
    const manifest = await get(id);
    if (manifest.state !== "VERIFIED") throw new Error("Cleanup is available only after the migration and database references are verified.");
    if (manifest.entries.some((entry) => entry.state !== "verified")) throw new Error("Every selected artifact must be verified before cleanup.");
    manifest.cleanupConfirmed = true;
    manifest.state = "CLEANUP_PENDING";
    manifest.updatedAt = new Date().toISOString();
    await saveManifest(options.manifestDir, manifest);
    return manifest;
  }

  async function cleanup(id: string): Promise<StorageMigrationManifest> {
    const manifest = await get(id);
    if (!manifest.cleanupConfirmed) throw new Error("Cleanup requires a separate explicit confirmation.");
    for (const entry of manifest.entries) {
      if (entry.protected || entry.state !== "verified") continue;
      if (!isWithin(manifest.sourceRoot, entry.sourcePath)) throw new Error("Refusing to delete a path outside the original source root.");
      const destinationHash = await hashFile(entry.destinationPath);
      if (destinationHash !== entry.sourceHash) throw new Error(`Destination changed after verification: ${entry.relativePath}`);
      await fs.promises.rm(entry.sourcePath, { force: false });
    }
    manifest.state = "CLEANED";
    manifest.cleanupCompletedAt = new Date().toISOString();
    manifest.updatedAt = new Date().toISOString();
    await saveManifest(options.manifestDir, manifest);
    return manifest;
  }

  return { preview, get, list, copy, confirmCleanup, cleanup };
}

export const storageMigrationService = createStorageMigrationService({
  manifestDir: path.join(
    process.env.WILLARD_LOCAL_DATA_ROOT?.trim()
      || (process.env.LOCALAPPDATA?.trim() ? path.join(process.env.LOCALAPPDATA.trim(), "Willard Media Center") : process.cwd()),
    "migrations",
  ),
  query: async (text, values) => pool.query(text, values),
});
