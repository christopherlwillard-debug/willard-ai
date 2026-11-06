import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { organizationJobsTable, archivesTable } from "@workspace/db";
import { eq, desc, inArray, or, and, isNull, isNotNull, lt, sql } from "drizzle-orm";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { spawn, spawnSync } from "child_process";
import { pipeline } from "stream/promises";
import { createGunzip } from "node:zlib";
import AdmZip from "adm-zip";
import * as tar from "tar";
import Seven from "node-7z";
import { getSevenZipPath } from "../lib/sevenzip.ts";
import { openai } from "@workspace/integrations-openai-ai-server";
import { getWillardAIDir, getTempDir, cleanTempDir, assertWithinRoot, resolveWithinRoot, ensurePrivateDir, ensureDirectoryWithinRoot, ensureDataDirectoryWithinRoot, pruneOperationalFiles } from "../lib/nas-storage";
import { archiveByIdScope, resolveActiveArchivePath } from "../lib/archive-scope.ts";
import { getActiveAppSettings, getActiveNasPath } from "../lib/active-library.ts";
import {
  ARCHIVE_LIMITS,
  ArchiveSafetyError,
  assertArchiveFileUnchanged,
  assertBufferedZipFile,
  createArchiveBudget,
  createArchiveExpansionLimiter,
  inspectExtractedTree,
  isZipSymlinkEntry,
  isTarLinkEntry,
  getSevenZipEntryInfo,
  snapshotArchiveFile,
  validateArchiveEntry,
  writeArchiveFileAtomically,
} from "../lib/archive-safety.ts";
import { moveFileNoReplace, sha256File, sha256Buffer, verifiedMove, rollbackMoves, walkDirectoryFiles, canDeleteOrganizationJob, type FileMoveRecord } from "../lib/organize-helpers";
import { consumeActionToken, issueActionToken } from "../lib/action-tokens";
import { canSendToAiProvider, getAiPrivacySettings, isMediaExcluded } from "../lib/ai-privacy";
import { logger } from "../lib/logger.ts";
import { parseAllowedString, parsePositiveIntegerParam, parsePositiveIntegerValue } from "../lib/request-validation.ts";
import { redactOperationalData, redactText } from "../lib/log-redaction.ts";
import { StoragePolicyError } from "../lib/storage-policy.ts";
import {
  reserveCapacity,
  releaseCapacity,
  evaluateCapacity,
  CapacityAdmissionError,
  type CapacityReservation,
} from "../lib/capacity-service.ts";
import { requestLibraryBackup } from "../lib/backup-coordinator.ts";

const router: IRouter = Router();

async function getNasPath(): Promise<string | null> {
  return getActiveNasPath();
}

async function getScopedOrganizationJob(id: number, nasPath: string) {
  const [job] = await db.select().from(organizationJobsTable).where(and(
    eq(organizationJobsTable.id, id),
    eq(organizationJobsTable.nasPath, nasPath),
  )).limit(1);
  return job;
}

function publicOrganizationJob<T extends { leaseToken?: string | null }>(job: T) {
  const { leaseToken: _leaseToken, ...publicJob } = job;
  return publicJob;
}

/**
 * Treat persisted move journals as untrusted recovery input. Every recorded
 * path must remain inside the active NAS and every move must carry a verified
 * matching SHA-256 pair before a recovery route can touch the filesystem.
 */
function parseOrganizationMoveJournal(value: unknown, nasPath: string): FileMoveRecord[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Recovery journal is not a valid move list");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Recovery journal entry ${index + 1} is invalid`);
    }
    const move = entry as Record<string, unknown>;
    if (
      typeof move.from !== "string" || !path.isAbsolute(move.from) ||
      typeof move.to !== "string" || !path.isAbsolute(move.to) ||
      typeof move.sourceHash !== "string" || !/^[a-f0-9]{64}$/i.test(move.sourceHash) ||
      typeof move.destHash !== "string" || move.destHash !== move.sourceHash ||
      typeof move.verified !== "boolean" ||
      (move.sourceRelPath !== undefined && typeof move.sourceRelPath !== "string")
    ) {
      throw new Error(`Recovery journal entry ${index + 1} is incomplete or unverified`);
    }
    try {
      resolveWithinRoot(move.from, nasPath);
      resolveWithinRoot(move.to, nasPath);
    } catch {
      throw new Error(`Recovery journal entry ${index + 1} references a path outside the configured library`);
    }
    return {
      from: move.from,
      to: move.to,
      sourceHash: move.sourceHash,
      destHash: move.destHash,
      verified: move.verified as boolean,
      sourceRelPath: move.sourceRelPath as string | undefined,
    };
  });
}

const ORGANIZATION_EXECUTION_LEASE_MS = 5 * 60 * 1000;
const ORGANIZATION_EXECUTION_HEARTBEAT_MS = 30 * 1000;

/**
 * Keep a durable execution lease fresh while an organization worker is alive.
 * A resume request may reclaim an "executing" job only after this heartbeat
 * becomes stale, which distinguishes a crashed worker from a live one.
 */
async function assertOrganizationLease(id: number, nasPath: string, leaseToken: string): Promise<void> {
  const [owner] = await db.select({ id: organizationJobsTable.id })
    .from(organizationJobsTable)
    .where(and(
      eq(organizationJobsTable.id, id),
      eq(organizationJobsTable.nasPath, nasPath),
      eq(organizationJobsTable.leaseToken, leaseToken),
      inArray(organizationJobsTable.status, ["executing", "rolling_back"]),
    ))
    .limit(1);
  if (!owner) throw new Error("Organization worker lease was lost; this worker stopped before making further changes.");
}

function startOrganizationJobHeartbeat(id: number, nasPath: string, leaseToken: string, status: "executing" | "rolling_back" = "executing"): () => void {
  let inFlight = false;
  const timer = setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const [owner] = await db.update(organizationJobsTable)
        .set({ stageUpdatedAt: new Date() })
        .where(and(
          eq(organizationJobsTable.id, id),
          eq(organizationJobsTable.nasPath, nasPath),
          eq(organizationJobsTable.leaseToken, leaseToken),
          eq(organizationJobsTable.status, status),
        ))
        .returning({ id: organizationJobsTable.id });
      if (!owner) logger.warn({ jobId: id, status }, "Organization worker lost its heartbeat lease");
    } catch (error) {
      logger.warn({ err: error, jobId: id, status }, "Organization job heartbeat failed");
    } finally {
      inFlight = false;
    }
  }, ORGANIZATION_EXECUTION_HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

const ZIP_EXTS    = new Set(["zip"]);
const TAR_EXTS    = new Set(["tar","gz","tgz","bz2","tbz2","xz","txz","tar.gz","tar.bz2","tar.xz"]);
const SEVENZIP_EXTS = new Set(["rar","7z","cab","iso"]);

// ── Helpers ────────────────────────────────────────────────────────────────

function getArchiveExt(filename: string): string {
  const fn = filename.toLowerCase();
  if (fn.endsWith(".tar.gz"))  return "tar.gz";
  if (fn.endsWith(".tar.bz2")) return "tar.bz2";
  if (fn.endsWith(".tar.xz"))  return "tar.xz";
  return path.extname(filename).replace(".", "").toLowerCase();
}

type TarCompression = "none" | "gzip" | "bzip2" | "xz";

function getTarCompression(filename: string): TarCompression {
  const fn = filename.toLowerCase();
  if (fn.endsWith(".tar.gz") || fn.endsWith(".tgz") || fn.endsWith(".gz")) return "gzip";
  if (fn.endsWith(".tar.bz2") || fn.endsWith(".tbz2") || fn.endsWith(".bz2")) return "bzip2";
  if (fn.endsWith(".tar.xz") || fn.endsWith(".txz") || fn.endsWith(".xz")) return "xz";
  return "none";
}

/**
 * Make a plain TAR file available to the tar library. tar itself supports gzip,
 * but not bzip2 or xz; those formats are decompressed with argument-array
 * child processes so archive filenames are never interpreted by a shell.
 *
 * The scratch directory is caller-owned. Compressed archive bytes must never
 * be decompressed into the OS temp directory because the result can be large
 * and is part of a NAS-required media operation.
 */
async function withTarInput<T>(
  archivePath: string,
  filename: string,
  scratchDir: string,
  callback: (tarPath: string, options: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  const compression = getTarCompression(filename);
  if (compression === "none") return callback(archivePath, {});
  if (!scratchDir) throw new StoragePolicyError("NAS storage is required for compressed archive decompression.");

  const tarPath = path.join(scratchDir, ".willard-input-" + crypto.randomUUID() + ".tar");
  const child = compression === "gzip" ? null : spawn(compression === "bzip2" ? "bzip2" : "xz", ["-dc", "--", archivePath], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child?.stderr?.setEncoding("utf8");
  child?.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
  const exit = child ? new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error((compression === "bzip2" ? "bzip2" : "xz") + " failed" + (signal ? " (" + signal + ")" : "") + ": " + (stderr.trim() || "exit code " + code)));
    });
  }) : Promise.resolve();

  try {
    const limiter = createArchiveExpansionLimiter(ARCHIVE_LIMITS.maxDecompressedTarBytes);
    const output = fs.createWriteStream(tarPath, { flags: "wx", mode: 0o600 });
    if (compression === "gzip") {
      await pipeline(fs.createReadStream(archivePath), createGunzip(), limiter, output);
    } else {
      if (!child?.stdout) throw new Error("Archive decompressor did not provide output");
      await pipeline(child.stdout, limiter, output);
    }
    await exit;
    return await callback(tarPath, {});
  } catch (error) {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exit.catch(() => {});
    throw error;
  } finally {
    try { fs.rmSync(tarPath, { force: true }); } catch { /* best effort */ }
  }
}

function getFileType(ext: string): string {
  const img   = ["jpg","jpeg","png","gif","bmp","webp","heic","heif","tiff","raw","cr2","nef","arw","dng"];
  const vid   = ["mp4","mkv","avi","mov","wmv","flv","m4v","webm","mpeg","mpg","3gp"];
  const doc   = ["pdf","doc","docx","xls","xlsx","ppt","pptx","odt","ods","odp","txt","rtf","pages","numbers","key","epub","md"];
  const audio = ["mp3","flac","wav","aac","ogg","wma","m4a","aiff"];
  const e = ext.toLowerCase();
  if (img.includes(e))   return "image";
  if (vid.includes(e))   return "video";
  if (doc.includes(e))   return "document";
  if (audio.includes(e)) return "audio";
  return "other";
}

function getFileTypeFromName(filename: string): string {
  return getFileType(path.extname(filename).replace(".", "").toLowerCase());
}

/**
 * Map file type to its canonical NAS destination directory.
 *
 * Canonical defaults (applied when no override is configured in app_settings):
 *   image    → <nasPath>/Media/Photos
 *   video    → <nasPath>/Media/Videos
 *   document → <nasPath>/Documents
 *   other    → <nasPath>/Archives/Extracted/<archiveName>  (archive source)
 *            → <nasPath>/Files                              (folder source)
 *
 * User-configured paths in app_settings always take precedence over canonical defaults.
 */
function routeDestination(
  fileType: string,
  settings: any,
  nasPath: string,
  opts: { archiveName?: string; archiveToWaiting?: boolean } = {}
): string {
  if (opts.archiveToWaiting) return path.join(nasPath, "Waiting to be Organized");
  const override = (key: string): string | null =>
    settings?.[key] && String(settings[key]).trim() ? String(settings[key]).trim() : null;
  switch (fileType) {
    case "image":    return override("photosDestination")    ?? path.join(nasPath, "Media", "Photos");
    case "video":    return override("videosDestination")    ?? path.join(nasPath, "Media", "Videos");
    case "document": return override("documentsDestination") ?? path.join(nasPath, "Documents");
    default:
      return override("otherFilesDestination")
        ?? (opts.archiveName
          ? path.join(nasPath, "Archives", "Extracted", opts.archiveName)
          : path.join(nasPath, "Files"));
  }
}

/** CRC32 lookup table — computed once at module load. */
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

/** Compute CRC32 of a Buffer (same algorithm used by ZIP). */
function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ buf[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** Safe disk-free check — uses spawnSync with argument array; no shell interpolation. */
function getDiskFreeBytes(dirPath: string): number | null {
  try {
    const checkDir = fs.existsSync(dirPath) ? dirPath : path.dirname(dirPath);
    const result = spawnSync("df", ["-B1", checkDir], { encoding: "utf8", stdio: "pipe" });
    if (result.status !== 0 || !result.stdout) return null;
    const lines = result.stdout.trim().split("\n");
    if (lines.length < 2) return null;
    const fields = lines[1].trim().split(/\s+/);
    const n = parseInt(fields[3] ?? "");
    return isNaN(n) ? null : n;
  } catch { return null; }
}


async function peekArchiveEntries(archivePath: string, filename: string, scratchDir: string): Promise<Array<{path: string; sizeBytes: number; isDirectory: boolean; fileType: string}>> {
  const ext    = getArchiveExt(filename);
  const entries: Array<{path: string; sizeBytes: number; isDirectory: boolean; fileType: string}> = [];
  const budget = createArchiveBudget();
  const archiveSnapshot = snapshotArchiveFile(archivePath);

  if (ZIP_EXTS.has(ext)) {
    assertBufferedZipFile(archivePath);
    const zip = new AdmZip(archivePath);
    for (const e of zip.getEntries()) {
      if (isZipSymlinkEntry((e as any).attr)) {
        throw new ArchiveSafetyError(`Archive traversal rejected: symlink entry "${e.entryName}" in ZIP`);
      }
      const sizeBytes = (e.header as any)?.size ?? 0;
      const checked = validateArchiveEntry({ path: e.entryName, sizeBytes, isDirectory: e.isDirectory }, budget);
      entries.push({ path: e.entryName, sizeBytes: checked.sizeBytes, isDirectory: checked.isDirectory, fileType: getFileTypeFromName(e.entryName) });
    }
  } else if (TAR_EXTS.has(ext)) {
    await withTarInput(archivePath, filename, scratchDir, async (tarPath, tarOptions) => {
      let validationError: Error | undefined;
      await tar.list({
        file: tarPath,
        ...tarOptions,
        preservePaths: true,
        strict: true,
        filter: (_p: string, e: any) => {
          if (validationError) return false;
          try {
            if (isTarLinkEntry(e.type)) {
              throw new ArchiveSafetyError(`Archive traversal rejected: link entry "${e.path}" (type: ${e.type}) in TAR`);
            }
            validateArchiveEntry({ path: e.path, sizeBytes: e.size, isDirectory: e.type === "Directory" }, budget);
            return true;
          } catch (error) {
            validationError = error instanceof Error ? error : new Error(String(error));
            return false;
          }
        },
        onentry: (e: any) => entries.push({
          path: e.path,
          sizeBytes: typeof e.size === "number" ? e.size : 0,
          isDirectory: e.type === "Directory",
          fileType: getFileTypeFromName(e.path),
        }),
      });
      if (validationError) throw validationError;
    });
  } else if (SEVENZIP_EXTS.has(ext)) {
    let validationError: Error | undefined;
    await new Promise<void>((resolve, reject) => {
      const s = Seven.list(archivePath, { $bin: getSevenZipPath(), $progress: false, techInfo: true } as any);
      s.on("data", (d: any) => {
        if (d.file !== undefined && !validationError) {
          const info = getSevenZipEntryInfo(d);
          const isDir = info.isDirectory;
          if (info.isLink) {
            validationError = new ArchiveSafetyError(`Archive traversal rejected: link entry "${d.file}" in 7z`);
            return;
          }
          try {
            const checked = validateArchiveEntry({ path: d.file, sizeBytes: info.sizeBytes, isDirectory: isDir }, budget);
            entries.push({ path: d.file, sizeBytes: checked.sizeBytes, isDirectory: isDir, fileType: isDir ? "directory" : getFileTypeFromName(d.file) });
          } catch (error) {
            validationError = error instanceof Error ? error : new Error(String(error));
          }
        }
      });
      s.on("end", () => validationError ? reject(validationError) : resolve());
      s.on("error", (error: Error) => reject(error));
    });
  }
  assertArchiveFileUnchanged(archivePath, archiveSnapshot);
  return entries;
}

/** Open archive TOC and count entries — detects corruption early. */
async function validateArchive(archivePath: string, scratchDir: string): Promise<{ ok: boolean; detail: string; entryCount: number }> {
  try {
    const ext    = getArchiveExt(path.basename(archivePath));
    let count = 0;
    const budget = createArchiveBudget();
    const archiveSnapshot = snapshotArchiveFile(archivePath);

    if (ZIP_EXTS.has(ext)) {
      assertBufferedZipFile(archivePath);
      const zip = new AdmZip(archivePath);
      for (const entry of zip.getEntries()) {
        if (isZipSymlinkEntry((entry as any).attr)) {
          throw new ArchiveSafetyError(`Archive traversal rejected: symlink entry "${entry.entryName}" in ZIP`);
        }
        validateArchiveEntry({
          path: entry.entryName,
          sizeBytes: (entry.header as any)?.size ?? 0,
          isDirectory: entry.isDirectory,
        }, budget);
        count++;
      }
    } else if (TAR_EXTS.has(ext)) {
      await withTarInput(archivePath, path.basename(archivePath), scratchDir, async (tarPath, tarOptions) => {
        let validationError: Error | undefined;
        await tar.list({
          file: tarPath,
          ...tarOptions,
          preservePaths: true,
          strict: true,
          filter: (_p: string, entry: any) => {
            if (validationError) return false;
            try {
              if (isTarLinkEntry(entry.type)) {
                throw new ArchiveSafetyError(`Archive traversal rejected: link entry "${entry.path}" (type: ${entry.type}) in TAR`);
              }
              validateArchiveEntry({
                path: entry.path,
                sizeBytes: entry.size,
                isDirectory: entry.type === "Directory",
              }, budget);
              return true;
            } catch (error) {
              validationError = error instanceof Error ? error : new Error(String(error));
              return false;
            }
          },
          onentry: () => count++,
        });
        if (validationError) throw validationError;
      });
    } else if (SEVENZIP_EXTS.has(ext)) {
      let validationError: Error | undefined;
      await new Promise<void>((resolve, reject) => {
        const s = Seven.list(archivePath, { $bin: getSevenZipPath(), $progress: false, techInfo: true } as any);
        s.on("data", (entry: any) => {
          if (validationError || entry.file === undefined) return;
          const info = getSevenZipEntryInfo(entry);
          if (info.isLink) {
            validationError = new ArchiveSafetyError(`Archive traversal rejected: link entry "${entry.file}" in 7z`);
            return;
          }
          try {
            validateArchiveEntry({
              path: entry.file,
              sizeBytes: info.sizeBytes,
              isDirectory: info.isDirectory,
            }, budget);
            count++;
          } catch (error) {
            validationError = error instanceof Error ? error : new Error(String(error));
          }
        });
        s.on("end", () => validationError ? reject(validationError) : resolve());
        s.on("error", (error: Error) => reject(error));
      });
    } else {
      return { ok: false, detail: `Unsupported format: .${ext}`, entryCount: 0 };
    }
    assertArchiveFileUnchanged(archivePath, archiveSnapshot);
    if (count === 0) return { ok: false, detail: "Archive appears empty or unreadable", entryCount: 0 };
    return { ok: true, detail: `${count} entries readable`, entryCount: count };
  } catch (e: any) {
    return { ok: false, detail: `Archive may be corrupt: ${e.message}`, entryCount: 0 };
  }
}

/**
 * Safe archive extraction with path-traversal, absolute-path, and symlink rejection.
 *
 * Security policy — enforced in two passes:
 *   Pass 1 (enumerate): Read the archive TOC, reject any entry with an absolute path,
 *                       a ".." traversal component, a null byte, or a symlink/hardlink type.
 *                       Uses assertWithinRoot() to canonically verify each resolved path
 *                       stays inside stagingDir even after normalization.
 *   Pass 2 (extract):   Extract ONLY after pass 1 completes without error.
 *                       For ZIP, entries are written individually via getData() (no extractAllTo).
 *                       For TAR, a `filter` callback rejects symlinks at write time as a
 *                       second-layer defence. For 7z, extracted paths are re-verified via
 *                       assertWithinRoot() post-extraction.
 *
 * Integrity policy:
 *   Every file move computes SHA-256 of the source before moving and the destination after
 *   moving.  For ZIP entries, SHA-256 of the uncompressed archive data is compared against
 *   SHA-256 of the written file.  For TAR/7z, per-file SHA-256 is recorded post-extraction
 *   (no in-archive per-file hash available in those formats).
 *   Any hash mismatch or I/O error is treated as fatal — the route aborts and rolls back.
 */
/**
 * Per-file checksum record produced during archive extraction.
 *
 * verificationMethod:
 *   "source-vs-dest"    — ZIP only: SHA-256 of the uncompressed archive-entry buffer is
 *                         compared against SHA-256 of the file as written to disk.
 *                         verified=true means they match.
 *   "post-extract-only" — TAR/7z: the archive library exposes no per-file byte stream,
 *                         so only the destination SHA-256 is available.  This still
 *                         detects truncated writes and I/O errors.  verified=true means
 *                         the destination file was successfully hashed after extraction.
 */
interface ExtractionChecksumRecord {
  relativePath:       string;
  sourceHash:         string;
  destHash:           string;
  verificationMethod: "source-vs-dest" | "post-extract-only";
  verified:           boolean;
}

async function safeExtractArchive(archivePath: string, stagingDir: string, nasRoot: string): Promise<{
  entriesExtracted: number;
  crcValidation: { format: string; checked: number; passed: number; skipped: number; note?: string };
  extractionChecksums: ExtractionChecksumRecord[];
}> {
  const ext    = getArchiveExt(path.basename(archivePath));
  const archiveSnapshot = snapshotArchiveFile(archivePath);
  // Validate the entire parent chain, not only the final staging component.
  // The shared temp parent is private, but revalidate immediately before the
  // destructive reset so stale or replaced paths fail closed.
  stagingDir = ensureDirectoryWithinRoot(stagingDir, nasRoot, 0o700);
  // Staging is disposable. Starting from a fresh directory prevents files
  // left by an interrupted run from becoming unvalidated extraction input.
  fs.rmSync(stagingDir, { recursive: true, force: true });
  stagingDir = ensureDirectoryWithinRoot(stagingDir, nasRoot, 0o700);
  const pass1Budget = createArchiveBudget();

  function assertSafeEntryPath(
    entryPath: string,
    sizeBytes: number | string | undefined,
    isDirectory: boolean,
    budget = pass1Budget,
  ): string {
    return validateArchiveEntry({ path: entryPath, sizeBytes, isDirectory }, budget).normalizedPath;
  }

  let entriesExtracted = 0;

  if (ZIP_EXTS.has(ext)) {
    assertBufferedZipFile(archivePath);
    const zip     = new AdmZip(archivePath);
    const entries = zip.getEntries();

    // Pass 1: validate all entries before writing anything
    for (const e of entries) {
      if (isZipSymlinkEntry((e as any).attr)) // Unix symlink mode
        throw new Error(`Archive traversal rejected: symlink entry "${e.entryName}" in ZIP`);
      assertSafeEntryPath(e.entryName, (e.header as any)?.size ?? 0, e.isDirectory);
    }

    // Pass 2: extract entry by entry with CRC32 + SHA-256 source→destination verification.
    // For each entry:
    //   a) Obtain uncompressed data via getData() — adm-zip checks stored CRC32 internally.
    //   b) Compute SHA-256 of in-memory buffer (sourceHash = archive entry content).
    //   c) Write buffer to disk.
    //   d) Compute SHA-256 of written file (destHash).
    //   e) If hashes differ, throw — catches truncated/corrupted writes.
    assertArchiveFileUnchanged(archivePath, archiveSnapshot);
    let crcChecked = 0; let crcPassed = 0; let crcSkipped = 0;
    const extractionChecksums: ExtractionChecksumRecord[] = [];
    const pass2Budget = createArchiveBudget();
    for (const e of entries) {
      if (e.isDirectory) continue;
      const declaredSize = (e.header as any)?.size ?? 0;
      assertSafeEntryPath(e.entryName, declaredSize, false, pass2Budget);
      if (Number(declaredSize) > ARCHIVE_LIMITS.maxBufferedZipEntryBytes) {
        throw new ArchiveSafetyError(
          `ZIP entry "${e.entryName}" exceeds the ${ARCHIVE_LIMITS.maxBufferedZipEntryBytes / 1024 ** 2} MiB in-memory extraction limit`,
        );
      }
      const outPath = path.join(stagingDir, e.entryName);
      const data = e.getData(); // throws internally on CRC mismatch
      if (data.length > ARCHIVE_LIMITS.maxBufferedZipEntryBytes) {
        throw new ArchiveSafetyError(
          `ZIP entry "${e.entryName}" exceeds the ${ARCHIVE_LIMITS.maxBufferedZipEntryBytes / 1024 ** 2} MiB in-memory extraction limit`,
        );
      }
      const storedCrc = (e.header as any).crc as number | undefined;
      if (typeof storedCrc === "number" && storedCrc !== 0) {
        const computed = crc32(data);
        if (computed !== storedCrc)
          throw new Error(`CRC32 mismatch: entry "${e.entryName}" computed=0x${computed.toString(16)} stored=0x${storedCrc.toString(16)}`);
        crcChecked++; crcPassed++;
      } else {
        crcSkipped++;
      }
      // SHA-256: hash uncompressed buffer before writing
      const sourceHash = sha256Buffer(data);
      writeArchiveFileAtomically(stagingDir, outPath, data);
      // SHA-256: hash written file and compare against buffer hash
      const destHash = await sha256File(outPath);
      if (sourceHash !== destHash) {
        throw new Error(
          `SHA-256 mismatch after extracting "${e.entryName}": ` +
          `archive-data=${sourceHash} written-file=${destHash}. ` +
          `File may be corrupted on write.`
        );
      }
      extractionChecksums.push({ relativePath: e.entryName, sourceHash, destHash, verificationMethod: "source-vs-dest", verified: true });
      entriesExtracted++;
    }
    assertArchiveFileUnchanged(archivePath, archiveSnapshot);
    const extractedTree = inspectExtractedTree(stagingDir);
    const expectedPaths = new Set(entries.filter(e => !e.isDirectory).map(e => path.normalize(e.entryName)));
    const actualPaths = new Set(extractedTree.files.map(file => path.normalize(file.relativePath)));
    if (expectedPaths.size !== actualPaths.size || [...expectedPaths].some(file => !actualPaths.has(file))) {
      throw new Error("Archive extraction produced an unexpected file set");
    }
    return {
      entriesExtracted,
      crcValidation: { format: "zip-crc32+sha256", checked: crcChecked, passed: crcPassed, skipped: crcSkipped },
      extractionChecksums,
    };

  } else if (TAR_EXTS.has(ext)) {
    const filePaths: string[] = [];

    return await withTarInput(archivePath, path.basename(archivePath), stagingDir, async (tarPath, tarOptions) => {
      // Pass 1: preserve raw archive paths while enumerating so the safety
      // check sees traversal instead of tar silently sanitizing it.
      let validationError: Error | undefined;
      await tar.list({
        file: tarPath,
        ...tarOptions,
        preservePaths: true,
        strict: true,
        filter: (_p: string, e: any) => {
          if (validationError) return false;
          try {
            const t = e.type as string;
            if (t === "SymbolicLink" || t === "Link" || t === "HardLink")
              throw new Error(`Archive traversal rejected: link entry "${e.path}" (type: ${t}) in TAR`);
            assertSafeEntryPath(e.path, e.size, t === "Directory");
            return true;
          } catch (err) {
            validationError = err instanceof Error ? err : new Error(String(err));
            return false;
          }
        },
        onentry: (e: any) => {
          if (e.type !== "Directory") filePaths.push(e.path.replace(/\\/g, "/"));
        },
      });
      if (validationError) throw validationError;
      assertArchiveFileUnchanged(archivePath, archiveSnapshot);

      // Pass 2: extract only after every entry passed validation. Preserve raw
      // paths here too, and validate again to defend against a changed archive.
      let extractionValidationError: Error | undefined;
      const pass2Budget = createArchiveBudget();
      await tar.extract({
        file: tarPath,
        cwd: stagingDir,
        ...tarOptions,
        preservePaths: true,
        strict: true,
        unlink: true,
        filter: (_p: string, entry: any) => {
          const t = entry?.type as string | undefined;
          if (extractionValidationError) return false;
          try {
            if (t === "SymbolicLink" || t === "Link" || t === "HardLink")
              return false;
            assertSafeEntryPath(_p, entry?.size, t === "Directory", pass2Budget);
            return true;
          } catch (err) {
            extractionValidationError = err instanceof Error ? err : new Error(String(err));
            return false;
          }
        },
      } as any);
      if (extractionValidationError) throw extractionValidationError;
      assertArchiveFileUnchanged(archivePath, archiveSnapshot);

      const extractedTree = inspectExtractedTree(stagingDir);
      const expectedPaths = new Set(filePaths.map(fp => path.normalize(fp)));
      const actualPaths = new Set(extractedTree.files.map(file => path.normalize(file.relativePath)));
      if (expectedPaths.size !== actualPaths.size || [...expectedPaths].some(file => !actualPaths.has(file))) {
        throw new Error("Archive extraction produced an unexpected file set");
      }

      entriesExtracted = extractedTree.files.length;

      // Post-extraction SHA-256: TAR archives have no per-file payload hash, so we hash each
      // extracted file as written to disk.  There is no archive-level "source hash" to compare
      // against, so verified=false — but destHash is recorded for rollback auditing.
      const extractionChecksumsTar: ExtractionChecksumRecord[] = [];
      for (const file of extractedTree.files) {
        const fp = file.relativePath;
        const outPath = file.fullPath;
        try {
          const destHash = await sha256File(outPath);
          extractionChecksumsTar.push({ relativePath: fp, sourceHash: "", destHash, verificationMethod: "post-extract-only", verified: true });
        } catch {
          // File not found after extraction — will be caught by the count-match check upstream
          extractionChecksumsTar.push({ relativePath: fp, sourceHash: "", destHash: "", verificationMethod: "post-extract-only", verified: false });
        }
      }

      return {
        entriesExtracted,
        crcValidation: { format: "tar-sha256-post-extract", checked: 0, passed: 0, skipped: entriesExtracted, note: "TAR has no per-file payload hash; SHA-256 computed post-extraction for rollback auditing" },
        extractionChecksums: extractionChecksumsTar,
      };
    });

  } else if (SEVENZIP_EXTS.has(ext)) {
    const filePaths: string[] = [];
    let sevenZipCrcCount = 0;
    const sevenZipBudget = createArchiveBudget();

    // Pass 1: enumerate, validate, and record CRC metadata from archive headers
    await new Promise<void>((resolve, reject) => {
      const s = Seven.list(archivePath, { $bin: getSevenZipPath(), $progress: false, techInfo: true } as any);
      let failed = false;
      const fail = (error: unknown) => {
        if (failed) return;
        failed = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      s.on("data", (d: any) => {
        if (d.file === undefined || failed) return;
        const info = getSevenZipEntryInfo(d);
        const isDir = info.isDirectory;
        if (info.isLink) { fail(new Error(`Archive traversal rejected: symlink entry "${d.file}" in 7z`)); return; }
        try {
          const checked = validateArchiveEntry({
            path: d.file,
            sizeBytes: info.sizeBytes,
            isDirectory: isDir,
          }, sevenZipBudget);
          if (!isDir) {
            filePaths.push(checked.normalizedPath);
            if (info.crc !== undefined) sevenZipCrcCount++;
          }
        } catch (error) {
          fail(error);
        }
      });
      s.on("end", () => failed || resolve());
      s.on("error", (e: any) => fail(new Error(`7z list error: ${e?.message ?? e}`)));
    });

    // Pass 2: extract
    assertArchiveFileUnchanged(archivePath, archiveSnapshot);
    await new Promise<void>((resolve, reject) => {
      const s = Seven.extractFull(archivePath, stagingDir, {
        $bin: getSevenZipPath(),
        overwrite: "a",
        // Never let 7-Zip materialize archive-provided symbolic links. The
        // metadata preflight below rejects known link entries; this explicit
        // negative switch is defense in depth for formats/builds that expose
        // incomplete link metadata through the list parser.
        $raw: ["-snl-"],
        $progress: false,
      } as any);
      s.on("end",   resolve);
      s.on("error", (e: any) => reject(new Error(`7z extract error: ${e?.message ?? e}`)));
    });
    assertArchiveFileUnchanged(archivePath, archiveSnapshot);

    // Post-extraction canonical check + SHA-256 per extracted file
    const extractedTree = inspectExtractedTree(stagingDir);
    const expectedPaths = new Set(filePaths.map(fp => path.normalize(fp)));
    const actualPaths = new Set(extractedTree.files.map(file => path.normalize(file.relativePath)));
    if (expectedPaths.size !== actualPaths.size || [...expectedPaths].some(file => !actualPaths.has(file))) {
      throw new Error("Archive extraction produced an unexpected file set");
    }
    const extractionChecksums7z: ExtractionChecksumRecord[] = [];
    for (const file of extractedTree.files) {
      const fp = file.relativePath;
      const outPath = file.fullPath;
      try {
        const destHash = await sha256File(outPath);
        extractionChecksums7z.push({ relativePath: fp, sourceHash: "", destHash, verificationMethod: "post-extract-only", verified: true });
      } catch {
        extractionChecksums7z.push({ relativePath: fp, sourceHash: "", destHash: "", verificationMethod: "post-extract-only", verified: false });
      }
    }
    entriesExtracted = filePaths.length;
    return {
      entriesExtracted,
      crcValidation: {
        format: "7z-sha256-post-extract",
        checked: 0, passed: 0, skipped: entriesExtracted,
        note: `${sevenZipCrcCount}/${filePaths.length} entries have archive CRC metadata; SHA-256 computed post-extraction for rollback auditing`,
      },
      extractionChecksums: extractionChecksums7z,
    };

  } else {
    throw new Error(`Unsupported archive format: .${ext}`);
  }
}

function walkDir(dirPath: string): Array<{fullPath: string; relativePath: string; sizeBytes: number; fileType: string}> {
  return walkDirectoryFiles(dirPath).map(file => ({
    ...file,
    fileType: getFileType(path.extname(file.fullPath).replace(".", "").toLowerCase()),
  }));
}

async function callAiConfidence(planSummary: object): Promise<{ confidence: number; reason: string; recommendation: string } | null> {
  try {
    const c = await openai.chat.completions.create({
      model: "gpt-5-mini",
      messages: [
        {
          role: "system",
          content: 'You are a file organization assistant. Review the proposed routing plan and return ONLY valid JSON with exactly these fields: ' +
            '{"confidence": <number 0-1>, "reason": "<one sentence explaining the confidence score>", "recommendation": "<one actionable suggestion or \'Plan looks good\'>"}'
        },
        { role: "user", content: JSON.stringify(planSummary) },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 200,
    });
    const raw = JSON.parse(c.choices[0]?.message?.content ?? "{}");
    return {
      confidence:     typeof raw.confidence     === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0.5,
      reason:         typeof raw.reason         === "string" ? raw.reason         : "Unable to assess routing quality.",
      recommendation: typeof raw.recommendation === "string" ? raw.recommendation : "Review destination assignments manually.",
    };
  } catch { return null; }
}

function isoTimestamp(): string {
  return new Date().toISOString().replace(/:/g, "-").replace(/\./g, "-").slice(0, 19);
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.post("/organize/jobs", async (req, res) => {
  try {
    const { sourceType, sourcePath, archiveId, archiveDisposition = "keep", conflictPolicy = "keep_existing" } = req.body as any;
    if (!sourceType || !["archive","folder"].includes(sourceType)) {
      res.status(400).json({ error: "sourceType must be 'archive' or 'folder'" }); return;
    }
    if (!sourcePath || typeof sourcePath !== "string") {
      res.status(400).json({ error: "sourcePath is required" }); return;
    }
    const nasPath = await getNasPath();
    if (!nasPath) { res.status(409).json({ error: "No library configured" }); return; }
    let canonicalSourcePath: string;
    try {
      canonicalSourcePath = resolveWithinRoot(sourcePath, nasPath);
      const sourceStat = fs.statSync(canonicalSourcePath);
      if (sourceType === "archive" && !sourceStat.isFile()) throw new Error("archive source must be a file");
      if (sourceType === "folder" && !sourceStat.isDirectory()) throw new Error("folder source must be a directory");
    } catch {
      res.status(403).json({ error: "sourcePath must be an existing path inside the configured library" });
      return;
    }
    const hasArchiveId = archiveId !== undefined && archiveId !== null;
    const parsedArchiveId = hasArchiveId ? parsePositiveIntegerValue(archiveId) : null;
    if (hasArchiveId && parsedArchiveId === null) {
      res.status(400).json({ error: "archiveId must be a positive safe integer" }); return;
    }
    if (sourceType === "folder" && parsedArchiveId !== null) {
      res.status(400).json({ error: "archiveId is only valid for archive sources" }); return;
    }
    if (sourceType === "archive" && parsedArchiveId !== null) {
      const [archive] = await db.select({ path: archivesTable.path })
        .from(archivesTable)
        .where(archiveByIdScope(parsedArchiveId, nasPath))
        .limit(1);
      if (!archive) { res.status(404).json({ error: "Archive not found in the active library" }); return; }
      let archivePath: string;
      try { archivePath = resolveActiveArchivePath(archive.path, nasPath); }
      catch { res.status(403).json({ error: "Archive path is outside the active library" }); return; }
      if (archivePath !== canonicalSourcePath) {
        res.status(400).json({ error: "archiveId does not match sourcePath" }); return;
      }
    }
    const requestedDisposition = parseAllowedString(archiveDisposition, ["waiting", "keep", "move_to_processed", "delete"], "keep");
    if (!requestedDisposition) {
      res.status(400).json({ error: "Invalid archiveDisposition" }); return;
    }
    if (sourceType === "folder" && requestedDisposition !== "keep") {
      res.status(400).json({ error: "archiveDisposition must be 'keep' for folder source jobs" }); return;
    }
    const resolvedDisposition = sourceType === "archive" ? requestedDisposition : "keep";
    if (conflictPolicy === "replace") {
      res.status(400).json({
        error: "Replace is temporarily unavailable until existing destination files can be backed up and recovered safely. Choose Rename or Keep Existing.",
        code: "REPLACE_RECOVERY_UNAVAILABLE",
      });
      return;
    }
    const resolvedPolicy = parseAllowedString(conflictPolicy, ["keep_existing", "rename", "skip"], "keep_existing");
    if (!resolvedPolicy) {
      res.status(400).json({ error: "Invalid conflictPolicy" }); return;
    }
    const [job] = await db.insert(organizationJobsTable)
      .values({ sourceType, sourcePath: canonicalSourcePath, archiveId: parsedArchiveId, archiveDisposition: resolvedDisposition, conflictPolicy: resolvedPolicy, nasPath })
      .returning();
    res.status(201).json(job ? publicOrganizationJob(job) : job);
  } catch { res.status(500).json({ error: "Failed to create organize job" }); }
});

router.get("/organize/jobs", async (_req, res) => {
  try {
    const jobs = await db.select().from(organizationJobsTable).orderBy(desc(organizationJobsTable.createdAt)).limit(50);
    res.json(jobs.map(publicOrganizationJob));
  } catch { res.status(500).json({ error: "Failed to list organize jobs" }); }
});

router.get("/organize/jobs/:id", async (req, res) => {
  try {
    const id = parsePositiveIntegerParam(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid job id" }); return; }
    const nasPath = await getNasPath();
    if (!nasPath) { res.status(404).json({ error: "Storage library is not configured" }); return; }
    const job = await getScopedOrganizationJob(id, nasPath);
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    res.json(publicOrganizationJob(job));
  } catch { res.status(500).json({ error: "Failed to get organize job" }); }
});

router.delete("/organize/jobs/:id", async (req, res) => {
  try {
    const id = parsePositiveIntegerParam(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid job id" }); return; }
    const nasPath = await getNasPath();
    const job = nasPath ? await getScopedOrganizationJob(id, nasPath) : undefined;
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    if (!canDeleteOrganizationJob(job.status, job.fileMoves)) {
      res.status(409).json({
        error: "Cannot delete an active job or discard an unresolved file-move recovery journal. Resume the job or complete rollback first.",
      });
      return;
    }

    // Recheck state and journal in the DELETE predicate so a concurrent
    // execute/resume/rollback cannot lose its recovery row after the read.
    const emptyJournal = or(
      isNull(organizationJobsTable.fileMoves),
      sql`CASE WHEN jsonb_typeof(${organizationJobsTable.fileMoves}) = 'array' THEN jsonb_array_length(${organizationJobsTable.fileMoves}) = 0 ELSE false END`,
    );
    const deletableState = or(
      inArray(organizationJobsTable.status, ["completed", "rolled_back"]),
      and(
        inArray(organizationJobsTable.status, ["pending", "planned", "verified", "failed"]),
        emptyJournal,
      ),
    );
    const [deletedJob] = await db.delete(organizationJobsTable)
      .where(and(
        eq(organizationJobsTable.id, id),
        eq(organizationJobsTable.nasPath, nasPath!),
        deletableState,
      ))
      .returning({ id: organizationJobsTable.id });
    if (!deletedJob) {
      res.status(409).json({ error: "The job became active or acquired recovery records. Refresh before deleting it." });
      return;
    }
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "Failed to delete organize job" }); }
});

router.post("/organize/jobs/:id/analyze", async (req, res) => {
  const id = parsePositiveIntegerParam(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid job id" }); return; }
  try {
    const nasPathForJob = await getNasPath();
    const job = nasPathForJob ? await getScopedOrganizationJob(id, nasPathForJob) : undefined;
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    if (["executing", "analyzing", "rolling_back"].includes(job.status)) {
      res.status(409).json({ error: "Job is already being processed" }); return;
    }

    // Claim analysis with a unique owner token. Concurrent requests may both
    // read the same prior status, but only one can transition it to analyzing.
    // Every later write is fenced by this token so an older request cannot
    // overwrite a newer plan or recovery state.
    const analysisLeaseToken = crypto.randomUUID();
    const [claimedAnalysis] = await db.update(organizationJobsTable)
      .set({ status: "analyzing", leaseToken: analysisLeaseToken, error: null })
      .where(and(
        eq(organizationJobsTable.id, id),
        eq(organizationJobsTable.nasPath, job.nasPath),
        eq(organizationJobsTable.status, job.status),
      ))
      .returning({ id: organizationJobsTable.id });
    if (!claimedAnalysis) {
      res.status(409).json({ error: "This job changed while analysis was starting. Refresh and try again." }); return;
    }

    const failAnalysis = async (message: string) => {
      await db.update(organizationJobsTable)
        .set({ status: "failed", error: message, leaseToken: null })
        .where(and(
          eq(organizationJobsTable.id, id),
          eq(organizationJobsTable.nasPath, job.nasPath),
          eq(organizationJobsTable.leaseToken, analysisLeaseToken),
          eq(organizationJobsTable.status, "analyzing"),
        ));
    };

    const settings = await getActiveAppSettings();
    const nasPath = (settings?.nasPath ?? "").trim();
    if (!nasPath || !path.isAbsolute(nasPath)) {
      await db.update(organizationJobsTable).set({ status: "failed", error: "NAS path is not configured — set an absolute path in Settings before analyzing." }).where(and(
        eq(organizationJobsTable.id, id),
        eq(organizationJobsTable.nasPath, job.nasPath),
        eq(organizationJobsTable.leaseToken, analysisLeaseToken),
        eq(organizationJobsTable.status, "analyzing"),
      ));
      res.status(422).json({ error: "NAS path is not configured. Set an absolute NAS path in Settings before running organize jobs." }); return;
    }
    try { resolveWithinRoot(job.sourcePath, nasPath); }
    catch { await failAnalysis("Job source is outside the configured library"); res.status(403).json({ error: "Job source is outside the configured library" }); return; }

    let entries: Array<{path: string; sizeBytes: number; isDirectory: boolean; fileType: string}> = [];
    let archiveInspectionWarning: string | null = null;

    if (job.sourceType === "archive") {
      const archivePath = resolveActiveArchivePath(job.sourcePath, nasPath);
      if (!fs.existsSync(archivePath) || !fs.statSync(archivePath).isFile()) {
        await db.update(organizationJobsTable).set({ status: "failed", error: "Archive file not found" }).where(and(
        eq(organizationJobsTable.id, id),
        eq(organizationJobsTable.nasPath, job.nasPath),
        eq(organizationJobsTable.leaseToken, analysisLeaseToken),
        eq(organizationJobsTable.status, "analyzing"),
      ));
        res.status(422).json({ error: "Archive file not found on disk" }); return;
      }
      if (job.archiveId) {
        const [arc] = await db.select().from(archivesTable)
          .where(archiveByIdScope(job.archiveId, nasPath))
          .limit(1);
        if (!arc) {
          await failAnalysis("Archive record not found in the active library");
          res.status(404).json({ error: "Archive record not found in the active library" }); return;
        }
        let recordPath: string;
        try { recordPath = resolveActiveArchivePath(arc.path, nasPath); }
        catch {
          await failAnalysis("Archive record is outside the active library");
          res.status(403).json({ error: "Archive record is outside the active library" }); return;
        }
        if (recordPath !== archivePath) {
          await failAnalysis("Archive record does not belong to this source path");
          res.status(403).json({ error: "Archive record does not belong to this source path" }); return;
        }
        if (arc?.peekStatus === "peeked" && Array.isArray(arc.peekEntries) && (arc.peekEntries as any[]).length > 0) {
          entries = (arc.peekEntries as any[]).map((e: any) => ({
            path: e.path ?? e.name ?? "", sizeBytes: e.sizeBytes ?? 0, isDirectory: e.isDirectory ?? false, fileType: e.fileType ?? "other",
          }));
        }
      }
      if (entries.length === 0) {
        const peekScratch = getTempDir(nasPath, `org-peek-${id}`);
        let peekReservation: CapacityReservation | null = null;
        try {
          const archiveBytes = fs.statSync(archivePath).size;
          peekReservation = await reserveCapacity({
            nasPath,
            operation: `Archive inspection #${id}`,
            nasBytes: archiveBytes,
          });
          try {
            entries = await peekArchiveEntries(archivePath, path.basename(archivePath), peekScratch);
          } catch (error) {
            // Keep the job analyzable so the user can explicitly approve the
            // guarded execution path. safeExtractArchive performs the final
            // rejection before any destination is touched.
            if (
              error instanceof ArchiveSafetyError &&
              /archive traversal rejected/i.test(error.message)
            ) {
              archiveInspectionWarning = error.message;
              entries = [];
            } else {
              throw error;
            }
          }
        } catch (error) {
          if (error instanceof CapacityAdmissionError) {
            await db.update(organizationJobsTable).set({ status: "failed", error: error.message }).where(and(
        eq(organizationJobsTable.id, id),
        eq(organizationJobsTable.nasPath, job.nasPath),
        eq(organizationJobsTable.leaseToken, analysisLeaseToken),
        eq(organizationJobsTable.status, "analyzing"),
      ));
            res.status(507).json({ code: "CAPACITY_UNSAFE", error: "Insufficient safe storage capacity", message: error.message });
            return;
          }
          throw error;
        } finally {
          if (peekReservation) releaseCapacity(peekReservation.id);
          cleanTempDir(peekScratch, nasPath);
        }
      }
    } else {
      if (!fs.existsSync(job.sourcePath)) {
        await db.update(organizationJobsTable).set({ status: "failed", error: "Source folder not found" }).where(and(
        eq(organizationJobsTable.id, id),
        eq(organizationJobsTable.nasPath, job.nasPath),
        eq(organizationJobsTable.leaseToken, analysisLeaseToken),
        eq(organizationJobsTable.status, "analyzing"),
      ));
        res.status(422).json({ error: "Source folder not found on disk" }); return;
      }
      if (!fs.statSync(job.sourcePath).isDirectory()) {
        await db.update(organizationJobsTable).set({ status: "failed", error: "sourcePath is not a directory for folder job" }).where(and(
        eq(organizationJobsTable.id, id),
        eq(organizationJobsTable.nasPath, job.nasPath),
        eq(organizationJobsTable.leaseToken, analysisLeaseToken),
        eq(organizationJobsTable.status, "analyzing"),
      ));
        res.status(422).json({ error: "sourcePath must be a directory for folder source jobs" }); return;
      }
      entries = walkDir(job.sourcePath).map(w => ({ path: w.relativePath, sizeBytes: w.sizeBytes, isDirectory: false, fileType: w.fileType }));
    }

    const fileEntries = entries.filter(e => !e.isDirectory);
    const summary = { images: 0, videos: 0, documents: 0, other: 0 };
    const routes: any[] = [];

    // Archive stem for "other" destination scoping (e.g. "backup.tar.gz" → "backup")
    const archiveName = job.sourceType === "archive"
      ? path.parse(path.parse(job.sourcePath).name).name  // strips both .gz and .tar
      : undefined;

    for (const e of fileEntries) {
      const ft = e.fileType === "image" ? "image" : e.fileType === "video" ? "video" : e.fileType === "document" ? "document" : "other";
      (summary as any)[ft === "image" ? "images" : ft === "video" ? "videos" : ft === "document" ? "documents" : "other"]++;
       routes.push({
         relativePath: e.path,
         filename: path.basename(e.path),
         fileType: ft,
         sizeBytes: e.sizeBytes,
         destination: routeDestination(ft, settings, nasPath, {
           archiveName,
           archiveToWaiting: job.sourceType === "archive" && job.archiveDisposition === "waiting",
         }),
       });
    }

    const totalSizeBytes = fileEntries.reduce((s, e) => s + (e.sizeBytes ?? 0), 0);
    const destinations = {
       images:    routeDestination("image",    settings, nasPath, { archiveToWaiting: job.sourceType === "archive" && job.archiveDisposition === "waiting" }),
       videos:    routeDestination("video",    settings, nasPath, { archiveToWaiting: job.sourceType === "archive" && job.archiveDisposition === "waiting" }),
       documents: routeDestination("document", settings, nasPath, { archiveToWaiting: job.sourceType === "archive" && job.archiveDisposition === "waiting" }),
       other:     routeDestination("other",    settings, nasPath, { archiveName, archiveToWaiting: job.sourceType === "archive" && job.archiveDisposition === "waiting" }),
    };

    // Build intra-plan conflict list for AI review input
    const filenameGroups = new Map<string, string[]>();
    for (const r of routes) {
      const key = path.join(r.destination, r.filename);
      if (!filenameGroups.has(key)) filenameGroups.set(key, []);
      filenameGroups.get(key)!.push(r.relativePath);
    }
    const planConflicts = [...filenameGroups.values()].filter(g => g.length > 1).map(g => g[0]);

    const aiPrivacy = await getAiPrivacySettings();
    const safePlanConflicts = planConflicts.filter((conflictPath) =>
      !isMediaExcluded(conflictPath, path.basename(conflictPath), aiPrivacy),
    );
    const aiResult = canSendToAiProvider(aiPrivacy)
      ? await callAiConfidence({
          totalFiles: fileEntries.length,
          summary,
          destinations,
          conflictCount: safePlanConflicts.length,
          conflictExamples: safePlanConflicts.slice(0, 5),
        })
      : null;
    const planJson: any = {
      sourceType: job.sourceType, sourcePath: job.sourcePath,
      totalFiles: fileEntries.length, totalSizeBytes, routes,
      excludeCategories: [], excludePaths: [],
      summary, destinations, archiveDisposition: job.archiveDisposition,
      archiveInspectionWarning,
      aiConfidence:     aiResult?.confidence     ?? null,
      aiReason:         aiResult?.reason         ?? null,
      aiRecommendation: aiResult?.recommendation ?? null,
    };

    const [updated] = await db.update(organizationJobsTable)
      .set({ status: "planned", planJson, leaseToken: null })
      .where(and(
        eq(organizationJobsTable.id, id),
        eq(organizationJobsTable.nasPath, job.nasPath),
        eq(organizationJobsTable.leaseToken, analysisLeaseToken),
        eq(organizationJobsTable.status, "analyzing"),
      ))
      .returning();
    res.json(updated ? publicOrganizationJob(updated) : updated);
  } catch (err) {
    await db.update(organizationJobsTable)
      .set({ status: "failed", error: err instanceof Error ? err.message : "Unknown error", leaseToken: null })
      .where(and(
        eq(organizationJobsTable.id, id),
        eq(organizationJobsTable.nasPath, job.nasPath),
        eq(organizationJobsTable.leaseToken, analysisLeaseToken),
        eq(organizationJobsTable.status, "analyzing"),
      )).catch(() => {});
    res.status(500).json({ error: "Analysis failed" });
  }
});

/** Update plan exclusions. Resets pre-flight so the user re-validates the updated plan. */
router.patch("/organize/jobs/:id/plan", async (req, res) => {
  const id = parsePositiveIntegerParam(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid job id" }); return; }
  let planEditToken = "";
  let planEditNasPath = "";
  try {
    const nasPathForJob = await getNasPath();
    const job = nasPathForJob ? await getScopedOrganizationJob(id, nasPathForJob) : undefined;
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    if (!job.planJson) { res.status(422).json({ error: "Run analyze first" }); return; }
    if (["executing", "analyzing", "rolling_back"].includes(job.status)) {
      res.status(409).json({ error: "This job is currently being processed" }); return;
    }

    // Serialize plan edits against each other and against execution claims.
    planEditToken = crypto.randomUUID();
    planEditNasPath = job.nasPath;
    const [claimedPlanEdit] = await db.update(organizationJobsTable)
      .set({ leaseToken: planEditToken })
      .where(and(
        eq(organizationJobsTable.id, id),
        eq(organizationJobsTable.nasPath, job.nasPath),
        eq(organizationJobsTable.status, job.status),
        isNull(organizationJobsTable.leaseToken),
      ))
      .returning({ id: organizationJobsTable.id });
    if (!claimedPlanEdit) {
      res.status(409).json({ error: "This job changed while the plan was being updated. Refresh and try again." }); return;
    }

    const plan = job.planJson as any;
    const { excludeCategories = [], excludePaths = [] } = req.body as any;
    const excludedPathSet = new Set(excludePaths as string[]);

    const activeRoutes = (plan.routes ?? []).filter((r: any) =>
      !excludeCategories.includes(r.fileType) && !excludedPathSet.has(r.relativePath)
    );

    const activeSummary = { images: 0, videos: 0, documents: 0, other: 0 };
    for (const r of activeRoutes) {
      (activeSummary as any)[r.fileType === "image" ? "images" : r.fileType === "video" ? "videos" : r.fileType === "document" ? "documents" : "other"]++;
    }

    const updatedPlan = {
      ...plan,
      excludeCategories,
      excludePaths,
      activeRoutes,
      activeSummary,
      totalFiles: activeRoutes.length,
      totalSizeBytes: activeRoutes.reduce((s: number, r: any) => s + (r.sizeBytes ?? 0), 0),
    };

    const [updated] = await db.update(organizationJobsTable)
      .set({ status: "planned", planJson: updatedPlan, preflightJson: null, leaseToken: null })
      .where(and(
        eq(organizationJobsTable.id, id),
        eq(organizationJobsTable.nasPath, job.nasPath),
        eq(organizationJobsTable.leaseToken, planEditToken),
        eq(organizationJobsTable.status, job.status),
      ))
      .returning();
    if (!updated) { res.status(409).json({ error: "Plan update lost ownership. Refresh and try again." }); return; }
    res.json(publicOrganizationJob(updated));
  } catch {
    // Do not leave a plan-edit claim behind if validation or persistence fails.
    // The token predicate prevents this cleanup from clearing a newer owner's claim.
    if (planEditToken && planEditNasPath) {
      await db.update(organizationJobsTable)
        .set({ leaseToken: null })
        .where(and(
          eq(organizationJobsTable.id, id),
          eq(organizationJobsTable.nasPath, planEditNasPath),
          eq(organizationJobsTable.leaseToken, planEditToken),
        )).catch(() => {});
    }
    res.status(500).json({ error: "Failed to update plan" });
  }
});

router.post("/organize/jobs/:id/preflight", async (req, res) => {
  const id = parsePositiveIntegerParam(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid job id" }); return; }
  try {
    const nasPathForJob = await getNasPath();
    const job = nasPathForJob ? await getScopedOrganizationJob(id, nasPathForJob) : undefined;
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    if (!job.planJson) { res.status(422).json({ error: "Run analyze first" }); return; }
    if (job.status === "executing") { res.status(409).json({ error: "Job is currently executing" }); return; }

    const plan = job.planJson as any;
    const settings = await getActiveAppSettings();
    const nasPath = (settings?.nasPath ?? "").trim();
    if (!nasPath || !path.isAbsolute(nasPath)) {
      res.status(422).json({ error: "NAS path is not configured. Set an absolute NAS path in Settings before running preflight." }); return;
    }
    const checks: any[] = [];

    // Active routes = plan.activeRoutes (if exclusions applied) or plan.routes
    const activeRoutes: any[] = plan.activeRoutes ?? plan.routes ?? [];

    // 0. Destination configuration warnings — surfaced if settings fields are blank (non-blocking)
    const destConfigKeys = [
      { key: "photosDestination",     category: "image",    label: "Photos destination" },
      { key: "videosDestination",     category: "video",    label: "Videos destination" },
      { key: "documentsDestination",  category: "document", label: "Documents destination" },
      { key: "otherFilesDestination", category: "other",    label: "Other files destination" },
    ] as const;
    for (const { key, category, label } of destConfigKeys) {
      const isBlank = !settings[key]?.trim();
      if (isBlank && activeRoutes.some((r: any) => r.fileType === category)) {
        const defaultDest = routeDestination(category, settings, nasPath);
        checks.push({
          name: label,
          ok: false,
          warning: true,
          detail: `No destination configured — set a custom path in Settings. Without it, files would go to the default: ${defaultDest}`,
        });
      }
    }

    // 1. Source exists and is readable
    let sourceOk = false;
    let sourceDetail = `Not found: ${job.sourcePath}`;
    if (fs.existsSync(job.sourcePath)) {
      try {
        fs.accessSync(job.sourcePath, fs.constants.R_OK);
        const stat = fs.statSync(job.sourcePath);
        // Enforce source type/kind match — archive jobs require a file, folder jobs require a directory
        const kindOk = job.sourceType === "archive" ? stat.isFile() : stat.isDirectory();
        if (!kindOk) {
          sourceDetail = job.sourceType === "archive"
            ? "sourcePath is not a regular file — expected an archive file"
            : "sourcePath is not a directory — expected a folder";
        } else {
          sourceOk = true;
          sourceDetail = job.sourceType === "archive"
            ? `Found (${(stat.size / 1e6).toFixed(1)} MB)`
            : `Found (directory)`;
        }
      } catch { sourceDetail = `Exists but not readable`; }
    }
    checks.push({ name: "Source accessible", ok: sourceOk, detail: sourceDetail });

    // 2. Archive integrity — try to open and count entries
    if (job.sourceType === "archive" && sourceOk) {
      const validationScratch = getTempDir(nasPath, `org-validate-${id}`);
      try {
        const v = await validateArchive(job.sourcePath, validationScratch);
        const traversalWarning = !v.ok && /archive traversal rejected/i.test(v.detail);
        checks.push({
          name: "Archive integrity",
          ok: v.ok,
          warning: traversalWarning,
          detail: v.detail,
        });
      } finally {
        cleanTempDir(validationScratch, nasPath);
      }
    }

    // 3. Destination writability — checked per destination (must be within NAS root)
    const uniqueDests = [...new Set<string>(activeRoutes.map((r: any) => r.destination).filter(Boolean))];
    for (const dest of uniqueDests) {
      let destOk = false;
      let destDetail = "";
      try {
        // Reject destinations outside the configured NAS root before touching disk
        assertWithinRoot(path.resolve(dest), path.resolve(nasPath));
        fs.mkdirSync(dest, { recursive: true });
        const tf = path.join(dest, `.willard_test_${Date.now()}`);
        fs.writeFileSync(tf, ""); fs.unlinkSync(tf);
        destOk = true; destDetail = "Writable";
      } catch (e: any) {
        destDetail = e.message?.includes("outside") ? `Outside NAS root: ${e.message}` : e.message;
      }
      checks.push({ name: `Writable: ${path.basename(dest)}`, ok: destOk, detail: destDetail || dest });
    }

    // 4. Disk space — checked per unique filesystem
    const totalBytes = plan.totalSizeBytes ?? 0;
    const capacity = await evaluateCapacity({
      nasPath,
      operation: `Organization pre-flight #${id}`,
      nasBytes: totalBytes,
    });
    const seenFs = new Set<string>();
    for (const dest of uniqueDests) {
      const checkDir = fs.existsSync(dest) ? dest : path.dirname(dest);
      let fsKey = checkDir;
      try { fsKey = fs.realpathSync(checkDir); } catch { /* best effort */ }
      if (seenFs.has(fsKey)) continue;
      seenFs.add(fsKey);
      const free = getDiskFreeBytes(checkDir);
      let diskOk = true;
      let diskDetail = "Check unavailable on this system";
      if (free !== null) {
        diskOk = free >= totalBytes;
        diskDetail = diskOk
          ? `Need ${(totalBytes / 1e9).toFixed(2)} GB, ${(free / 1e9).toFixed(2)} GB free`
          : `Need ${(totalBytes / 1e9).toFixed(2)} GB but only ${(free / 1e9).toFixed(2)} GB free`;
      }
      checks.push({ name: `Disk space (${path.basename(dest)})`, ok: diskOk, detail: diskDetail });
    }

    // 5a. On-disk collision detection: files that already exist at the destination
    const conflictPolicy: string = (job as any).conflictPolicy ?? "keep_existing";
    let diskCollisionCount = 0;
    const diskCollisionExamples: string[] = [];
    const conflictList: Array<{filename: string; destination: string; conflictType: "disk" | "intra_job"; sources?: string[]}> = [];
    for (const route of activeRoutes) {
      const destPath = path.join(route.destination, route.filename);
      if (fs.existsSync(destPath)) {
        diskCollisionCount++;
        if (diskCollisionExamples.length < 4) diskCollisionExamples.push(route.filename);
        if (conflictList.length < 100) conflictList.push({ filename: route.filename, destination: destPath, conflictType: "disk" });
      }
    }

    // 5b. Intra-job collision detection: two or more source files that map to the same
    //     destination path (e.g. A/photo.jpg + B/photo.jpg both routed to Media/Photos).
    const destPathSeen = new Map<string, string[]>();  // destPath → source relativePaths
    for (const route of activeRoutes) {
      const destPath = path.join(route.destination, route.filename);
      if (!destPathSeen.has(destPath)) destPathSeen.set(destPath, []);
      destPathSeen.get(destPath)!.push(route.relativePath ?? route.filename);
    }
    let intraJobCollisionCount = 0;
    const intraJobCollisionExamples: string[] = [];
    for (const [destPath, sources] of destPathSeen) {
      if (sources.length > 1) {
        intraJobCollisionCount++;
        if (intraJobCollisionExamples.length < 4) intraJobCollisionExamples.push(path.basename(sources[0]));
        if (conflictList.length < 100) conflictList.push({ filename: path.basename(destPath), destination: destPath, conflictType: "intra_job", sources });
      }
    }

    const collisionCount = diskCollisionCount + intraJobCollisionCount;
    const collisionDetails: string[] = [];
    if (diskCollisionCount > 0)
      collisionDetails.push(`${diskCollisionCount} already on disk (${diskCollisionExamples.join(", ")}${diskCollisionCount > 4 ? "…" : ""})`);
    if (intraJobCollisionCount > 0)
      collisionDetails.push(`${intraJobCollisionCount} intra-job conflict${intraJobCollisionCount !== 1 ? "s" : ""} — duplicate basenames routing to same folder (${intraJobCollisionExamples.join(", ")}${intraJobCollisionCount > 4 ? "…" : ""})`);

    // Collisions are warnings (non-blocking) when a conflict policy is set — all four policies
    // handle disk collisions at execute time. Only block when no policy would save the file.
    const conflictPolicyLabel: Record<string, string> = {
      keep_existing: "keep existing (source skipped)",
      replace: "replace existing with source",
      rename: "rename source with suffix",
      skip: "skip source file",
    };
    const policyLabel = conflictPolicyLabel[conflictPolicy] ?? conflictPolicy;
    checks.push({
      name: "File collisions",
      ok: collisionCount === 0,
      warning: collisionCount > 0,  // non-blocking — policy handles them at execute time
      detail: collisionCount === 0
        ? "No filename conflicts"
        : `${collisionCount} conflict${collisionCount !== 1 ? "s" : ""} — will be resolved at execute time (policy: ${policyLabel}). ${collisionDetails.join("; ")}`,
    });

    // allOk: all critical checks pass; warnings (collisions with policy) are non-blocking
    const allOk = checks.every(c => c.ok || c.warning === true);
    checks.push({
      name: "Capacity admission",
      ok: capacity.allowed,
      detail: capacity.message,
      capacity,
    });
    const capacityAllOk = allOk && capacity.allowed;
    const preflightJson = {
      ok: capacityAllOk, checks, diskSpaceRequiredBytes: totalBytes, capacity,
      collisionCount, diskCollisionCount, intraJobCollisionCount,
      conflictPolicy, conflictList,
    };
    const [updated] = await db.update(organizationJobsTable)
      .set({ status: capacityAllOk ? "verified" : "planned", preflightJson, error: capacity.allowed ? null : capacity.message })
      .where(eq(organizationJobsTable.id, id))
      .returning();
    res.json(updated ? publicOrganizationJob(updated) : updated);
  } catch { res.status(500).json({ error: "Preflight check failed" }); }
});

/**
 * Dry-run simulation — reads the plan and returns what WOULD happen without touching the filesystem.
 * Uses existing planJson routes to compute destinations, detect conflicts, and warn about blank settings.
 */
router.get("/organize/jobs/:id/dry-run", async (req, res) => {
  const id = parsePositiveIntegerParam(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid job id" }); return; }
  try {
    const nasPathForJob = await getNasPath();
    const job = nasPathForJob ? await getScopedOrganizationJob(id, nasPathForJob) : undefined;
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    if (!job.planJson) { res.status(422).json({ error: "Run analyze first to build the plan" }); return; }

    const plan = job.planJson as any;
    const settings = await getActiveAppSettings();
    const nasPath = (settings?.nasPath ?? "").trim();

    const activeRoutes: any[] = plan.activeRoutes ?? plan.routes ?? [];

    // ── Stage 1: Blank destination detection (blocking in preflight, warning here) ──
    const warnings: Array<{ category: string; label: string; using: string }> = [];
    const destConfigKeys = [
      { key: "photosDestination",     category: "image",    label: "Photos" },
      { key: "videosDestination",     category: "video",    label: "Videos" },
      { key: "documentsDestination",  category: "document", label: "Documents" },
      { key: "otherFilesDestination", category: "other",    label: "Other Files" },
    ] as const;
    for (const { key, category, label } of destConfigKeys) {
      if (!settings[key]?.trim() && activeRoutes.some((r: any) => r.fileType === category)) {
        warnings.push({ category, label, using: routeDestination(category, settings, nasPath) });
      }
    }

    // ── Stage 2: Per-file move simulation ──
    // Build full move plan: source relativePath → destination absolute path
    interface MoveAction {
      source: string;       // relative path in archive/folder
      filename: string;
      fileType: string;
      sizeBytes: number;
      destinationDir: string;
      destinationPath: string;  // absolute destination
      conflictType: "none" | "disk" | "intra_job";
    }

    const movePlan: MoveAction[] = [];
    const destSeen = new Map<string, string>();  // destAbsPath → first source
    let diskConflictCount = 0;
    let intraConflictCount = 0;
    const diskConflictExamples: string[]  = [];
    const intraConflictExamples: string[] = [];

    for (const route of activeRoutes) {
      const destPath = path.join(route.destination, route.filename);
      let conflictType: MoveAction["conflictType"] = "none";

      if (destSeen.has(destPath)) {
        intraConflictCount++;
        if (intraConflictExamples.length < 8) intraConflictExamples.push(route.filename);
        conflictType = "intra_job";
      } else {
        destSeen.set(destPath, route.relativePath);
        if (fs.existsSync(destPath)) {
          diskConflictCount++;
          if (diskConflictExamples.length < 8) diskConflictExamples.push(route.filename);
          conflictType = "disk";
        }
      }

      movePlan.push({
        source: route.relativePath,
        filename: route.filename,
        fileType: route.fileType,
        sizeBytes: route.sizeBytes ?? 0,
        destinationDir: route.destination,
        destinationPath: destPath,
        conflictType,
      });
    }

    // ── Stage 3: Folder creation plan ──
    // Show which folders need to be created vs which already exist
    const uniqueDests = [...new Set(activeRoutes.map((r: any) => r.destination))];
    const foldersToCreate = uniqueDests.map(dir => ({
      path: dir,
      exists: fs.existsSync(dir),
    }));

    // ── Stage 4: Archive extraction note ──
    const extractionNote = job.sourceType === "archive"
      ? `Archive will be extracted to a temporary staging area, then ${activeRoutes.length} file${activeRoutes.length !== 1 ? "s" : ""} will be routed to their destinations. The original archive is NOT deleted during execution${job.archiveDisposition === "delete" ? " (deletion requires explicit confirmation after verification)" : ""}.`
      : `Folder source — files will be copied to staging first. Source folder is never modified. ${activeRoutes.length} file${activeRoutes.length !== 1 ? "s" : ""} will be routed to their destinations.`;

    // ── Stage 5: Per-type summary ──
    const byType = { images: 0, videos: 0, documents: 0, other: 0 };
    for (const r of activeRoutes) {
      if      (r.fileType === "image")    byType.images++;
      else if (r.fileType === "video")    byType.videos++;
      else if (r.fileType === "document") byType.documents++;
      else                                byType.other++;
    }

    const dryRunConflictPolicy: string = (job as any).conflictPolicy ?? "keep_existing";
    res.json({
      ok: diskConflictCount === 0 && intraConflictCount === 0 && warnings.length === 0,
      extractionNote,
      summary: {
        filesToProcess: activeRoutes.length,
        foldersTotal: uniqueDests.length,
        foldersExisting: foldersToCreate.filter(f => f.exists).length,
        foldersNew: foldersToCreate.filter(f => !f.exists).length,
        totalBytes: plan.totalSizeBytes ?? 0,
        byType,
        destinations: plan.destinations ?? {},
      },
      // Full per-file move plan (capped at 200 for payload size; use summary for the rest)
      movePlan: movePlan.slice(0, 200),
      movePlanTotal: movePlan.length,
      // Folder creation plan
      foldersToCreate,
      // Conflict details
      diskConflictCount,
      diskConflictExamples,
      intraConflictCount,
      intraConflictExamples,
      conflictPolicy: dryRunConflictPolicy,
      // Blank destination warnings
      warnings,
      sourceType: job.sourceType,
    });
  } catch {
    res.status(500).json({ error: "Dry-run simulation failed" });
  }
});

router.post("/organize/jobs/:id/execute-token", async (req, res) => {
  const id = parsePositiveIntegerParam(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid job id" }); return; }
  
  try {
    const nasPath = await getNasPath();
    const job = nasPath ? await getScopedOrganizationJob(id, nasPath) : undefined;
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    if (job.status !== "verified" || !job.planJson) {
      res.status(409).json({ error: "Pre-flight must pass before executing" });
      return;
    }
    const token = await issueActionToken(req, "organize-execute", String(id));
    res.json({ token, expiresInSeconds: 300 });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not authorize execution" });
  }
});

/**
 * SSE execution stream.
 * - Folder jobs: COPY to staging first; source is never touched during execute.
 * - Any unexpected collision during execute is treated as a FATAL error (triggers rollback).
 * - Archive disposition `delete` is NOT applied here — it requires explicit second confirmation
 *   via POST /organize/jobs/:id/apply-disposition after reviewing the completion summary.
 * - Archive disposition `move_to_processed` is applied automatically after 100% verification.
 */
router.get("/organize/jobs/:id/execute", async (req, res) => {
  const id = parsePositiveIntegerParam(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid job id" }); return; }

  if (!await consumeActionToken(req, req.query.token, "organize-execute", String(id))) {
    res.status(403).json({ error: "A valid one-time execution token is required." });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (event: string, data: object) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const tempDirs: string[] = [];
  let cleanupNasPath = "";
  const fileMoves: FileMoveRecord[] = [];
  let logStream: fs.WriteStream | null = null;
  let logPath = "";
  const correlationId = req.id;
  const operationLogger = logger.child({ correlationId, operation: "organize", jobId: id });
  let capacityReservation: CapacityReservation | null = null;
  let stopHeartbeat: (() => void) | null = null;
  let executionLeaseToken = "";
  let logWriteFailureReported = false;
  const opLog = (line: string) => {
    try {
      logStream?.write(redactText(line) + "\n");
    } catch (error) {
      if (!logWriteFailureReported) {
        logWriteFailureReported = true;
        operationLogger.warn({ err: error }, "Organization operation log write failed");
      }
    }
  };

  try {
    const nasPathForJob = await getNasPath();
    const job = nasPathForJob ? await getScopedOrganizationJob(id, nasPathForJob) : undefined;
    if (!job)                   { send("error", { message: "Job not found" });                          res.end(); return; }
    if (job.status === "executing") { send("error", { message: "Job is already executing" });           res.end(); return; }
    if (!job.planJson)          { send("error", { message: "Run analyze first" });                      res.end(); return; }
    if (job.status !== "verified") { send("error", { message: "Pre-flight must pass before executing" }); res.end(); return; }

    const plan = job.planJson as any;
    const settings = await getActiveAppSettings();
    const nasPath = (settings?.nasPath ?? "").trim();
    if (!nasPath || !path.isAbsolute(nasPath)) {
      send("error", { message: "NAS path is not configured. Set an absolute NAS path in Settings before executing." }); res.end(); return;
    }
    cleanupNasPath = nasPath;
    let canonicalJobSourcePath: string;
    try { canonicalJobSourcePath = resolveActiveArchivePath(job.sourcePath, nasPath); }
    catch { send("error", { message: "Job source is outside the configured library" }); res.end(); return; }

    // Claim the job atomically before capacity reservation or staging. Two
    // requests can both read "verified"; only one may transition it to
    // "executing" and own the deterministic per-job staging directory.
    executionLeaseToken = crypto.randomUUID();
    const [claimedJob] = await db.update(organizationJobsTable)
      .set({ status: "executing", lastStage: "claiming", stageUpdatedAt: new Date(), leaseToken: executionLeaseToken })
      .where(and(
        eq(organizationJobsTable.id, id),
        eq(organizationJobsTable.nasPath, nasPath),
        eq(organizationJobsTable.status, "verified"),
      ))
      .returning({ id: organizationJobsTable.id });
    if (!claimedJob) {
      send("error", { message: "Job is already executing or is no longer verified." });
      res.end();
      return;
    }
    stopHeartbeat = startOrganizationJobHeartbeat(id, nasPath, executionLeaseToken);

    // Active routes respect any category/path exclusions set via PATCH /plan
    const excludedCategories = new Set<string>(plan.excludeCategories ?? []);
    const excludedPaths      = new Set<string>(plan.excludePaths ?? []);
    const activeRoutes: any[] = (plan.routes ?? []).filter((r: any) =>
      !excludedCategories.has(r.fileType) && !excludedPaths.has(r.relativePath)
    );
    const expectedTotal = activeRoutes.length;
    const requiredNasBytes = activeRoutes.reduce((sum, route) => sum + Math.max(0, Number(route.sizeBytes) || 0), 0);
    try {
      capacityReservation = await reserveCapacity({
        nasPath,
        operation: `Organization job #${id}`,
        nasBytes: requiredNasBytes,
      });
    } catch (error) {
      const admission = error instanceof CapacityAdmissionError ? error.admission : null;
      const message = error instanceof Error ? error.message : "Organization capacity admission failed";
      stopHeartbeat?.();
      stopHeartbeat = null;
      await db.update(organizationJobsTable)
        .set({ status: "verified", error: message, stageUpdatedAt: new Date(), leaseToken: null })
        .where(and(
          eq(organizationJobsTable.id, id),
          eq(organizationJobsTable.nasPath, nasPath),
          eq(organizationJobsTable.leaseToken, executionLeaseToken),
          eq(organizationJobsTable.status, "executing"),
        ));
      send("error", { code: "CAPACITY_UNSAFE", message, capacity: admission });
      return;
    }

    // Archive name (stem without extensions) used for "other" destination scoping
    const archiveName = job.sourceType === "archive"
      ? path.parse(path.parse(job.sourcePath).name).name
      : undefined;

    // Open per-file operation log
    const ts = isoTimestamp();
    try {
      const logsDir = ensureDirectoryWithinRoot(path.join(getWillardAIDir(nasPath), "logs"), nasPath);
      pruneOperationalFiles(logsDir, "org-", 30);
      logPath = path.join(logsDir, `org-${ts}-${id}.log`);
      logStream = fs.createWriteStream(logPath, { flags: "a", mode: 0o600 });
      try { fs.chmodSync(logPath, 0o600); } catch { /* best effort */ }
      opLog(`=== Organization Job #${id} started ${new Date().toISOString()} correlation=${correlationId} ===`);
      opLog(`Source type: ${job.sourceType}`);
      opLog(`Active routes: ${expectedTotal} / ${plan.routes?.length ?? 0} total`);
    } catch (error) {
      operationLogger.warn({ err: error }, "Organization operation log could not be opened");
    }

    // The job was claimed atomically before capacity admission; do not issue
    // a second unconditional status update that could overwrite a concurrent recovery transition.

    // Stage checkpoint helper — fire-and-forget; persists lastStage + stageUpdatedAt for Recovery Center
    const setStage = async (stage: string): Promise<void> => {
      try {
        const [owned] = await db.update(organizationJobsTable)
          .set({ lastStage: stage, stageUpdatedAt: new Date() })
          .where(and(
            eq(organizationJobsTable.id, id),
            eq(organizationJobsTable.nasPath, nasPath),
            eq(organizationJobsTable.leaseToken, executionLeaseToken),
            eq(organizationJobsTable.status, "executing"),
          ))
          .returning({ id: organizationJobsTable.id });
        if (!owned) throw new Error("Organization worker lease was lost before its stage checkpoint.");
      } catch (e: any) {
        if (e instanceof Error && e.message.includes("lease was lost")) throw e;
        opLog(`WARN: Stage checkpoint '${stage}' failed: ${e.message ?? String(e)}`);
      }
    };
    await setStage("staging");
    send("status", { stage: "staging", message: "Preparing staging area…", progress: 2 });

    const tempDir = getTempDir(nasPath, `org-${id}`);
    tempDirs.push(tempDir);

    let sourceFiles: Array<{fullPath: string; relativePath: string; fileType: string; sizeBytes: number}> = [];
    let crcValidation: { format: string; checked: number; passed: number; skipped: number; note?: string } | null = null;
    let archiveExtractionChecksums: ExtractionChecksumRecord[] = [];

    if (job.sourceType === "archive") {
      send("status", { stage: "extracting", message: "Extracting archive to staging area…", progress: 5 });
      if (!fs.existsSync(canonicalJobSourcePath) || !fs.statSync(canonicalJobSourcePath).isFile()) {
        throw new Error(`Archive not found: ${canonicalJobSourcePath}`);
      }
      if (job.archiveId) {
        const [archive] = await db.select({ path: archivesTable.path })
          .from(archivesTable)
          .where(archiveByIdScope(job.archiveId, nasPath))
          .limit(1);
        if (!archive || resolveActiveArchivePath(archive.path, nasPath) !== canonicalJobSourcePath) {
          throw new Error("Archive record is not available in the active library");
        }
      }
      opLog("EXTRACT: archive extraction started");
      const extractResult = await safeExtractArchive(canonicalJobSourcePath, tempDir, nasPath);
      crcValidation = extractResult.crcValidation;
      archiveExtractionChecksums = extractResult.extractionChecksums ?? [];
      const { entriesExtracted } = extractResult;
      opLog(`EXTRACT_OK: ${entriesExtracted} entries — CRC ${crcValidation.format}: checked=${crcValidation.checked} passed=${crcValidation.passed} skipped=${crcValidation.skipped}${crcValidation.note ? ` (${crcValidation.note})` : ""}`);
      send("status", { stage: "scanning",   message: "Scanning extracted files…",          progress: 25 });
      sourceFiles = walkDir(tempDir).map(w => ({ fullPath: w.fullPath, relativePath: w.relativePath, fileType: w.fileType, sizeBytes: w.sizeBytes }));
    } else {
      // FOLDER: stage (copy) so source directory is never modified during execute
      if (!fs.existsSync(job.sourcePath)) throw new Error(`Source folder not found: ${job.sourcePath}`);
      const walked = walkDir(job.sourcePath);
      send("status", { stage: "staging", message: `Copying ${walked.length} files to staging area…`, progress: 5 });
      const stagingBase = path.join(tempDir, "staged");
      let staged = 0;
      for (const w of walked) {
        const dest = path.join(stagingBase, w.relativePath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(w.fullPath, dest);
        staged++;
        if (staged % 20 === 0) send("status", { stage: "staging", message: `Staged ${staged}/${walked.length}…`, progress: 5 + Math.round((staged / walked.length) * 17) });
      }
      opLog(`STAGE: Copied ${staged} files to staging`);
      sourceFiles = walkDir(stagingBase).map(w => ({ fullPath: w.fullPath, relativePath: w.relativePath, fileType: w.fileType, sizeBytes: w.sizeBytes }));
      send("status", { stage: "scanning", message: `Staged ${sourceFiles.length} files`, progress: 24 });
    }

    // FATAL if staged count does not exactly match plan (indicates extraction failure or plan drift)
    if (expectedTotal > 0) {
      const applicableStaged = sourceFiles.filter(sf => {
        const ft = sf.fileType === "image" ? "image" : sf.fileType === "video" ? "video" : sf.fileType === "document" ? "document" : "other";
        return !excludedCategories.has(ft) && !excludedPaths.has(sf.relativePath);
      });
      if (applicableStaged.length !== expectedTotal) {
        throw new Error(
          `Staged file count mismatch: plan expected ${expectedTotal} files but ${applicableStaged.length} ` +
          `were found after ${job.sourceType === "archive" ? "extraction" : "staging"}. ` +
          `Re-run Analyze to refresh the plan before executing.`
        );
      }
      opLog(`COUNT_OK: ${applicableStaged.length} staged files match plan exactly`);
    }

    const total = expectedTotal;
    let moved = 0;
    let excluded = 0;
    let conflictSkipped = 0;
    const conflictPolicy: string = (job as any).conflictPolicy ?? "keep_existing";
    const conflictResolutions: Array<{filename: string; destDir: string; action: string; resolvedTo?: string}> = [];

    // Build a frozen destination map from the approved plan routes.
    // Execute MUST drive moves from the plan the user reviewed + preflight verified —
    // never recompute from current settings (settings can change between steps).
    const planDestMap = new Map<string, string>();
    for (const r of (plan.routes ?? [])) {
      if (r.relativePath && r.destination) planDestMap.set(r.relativePath, r.destination);
    }

    await setStage("moving");
    send("status", { stage: "moving", message: `Moving ${total} files…`, progress: 26, total });
    opLog(`MOVE_START: routing ${total} active files from frozen plan destinations (conflict policy: ${conflictPolicy})`);

    for (let i = 0; i < sourceFiles.length; i++) {
      const sf = sourceFiles[i];
      const ft = sf.fileType === "image" ? "image" : sf.fileType === "video" ? "video" : sf.fileType === "document" ? "document" : "other";

      // Respect plan exclusions
      if (excludedCategories.has(ft) || excludedPaths.has(sf.relativePath)) {
        excluded++;
        opLog("EXCLUDE: file excluded by the approved plan");
        continue;
      }

      // Use frozen plan destination — fall back to recomputed only if relativePath not in plan
      // (should never happen after count-match validation above, but guard defensively)
      const planDest = planDestMap.get(sf.relativePath);
      if (!planDest) {
        throw new Error(
          `File ${sf.relativePath} has no frozen destination in plan. ` +
          `Re-run Analyze to refresh the plan before executing.`
        );
      }
      const destDir  = planDest;
      let destFile   = path.join(destDir, path.basename(sf.relativePath));

      // Enforce NAS root boundary — destination must be within configured nasPath
      assertWithinRoot(path.resolve(destDir), path.resolve(nasPath));
      ensureDataDirectoryWithinRoot(destDir, nasPath);

      // Apply conflict policy when destination file already exists
      if (fs.existsSync(destFile)) {
        const filename = path.basename(sf.relativePath);
        if (conflictPolicy === "replace") {
          throw new Error(
            "Replace is temporarily unavailable because this operation cannot yet preserve the existing destination for crash recovery. " +
            "Choose Rename or Keep Existing; no destination file was changed.",
          );
        } else if (conflictPolicy === "rename") {
          const ext  = path.extname(filename);
          const base = filename.slice(0, filename.length - ext.length);
          let suffix = 1;
          while (fs.existsSync(destFile)) {
            destFile = path.join(destDir, `${base}_${suffix}${ext}`);
            suffix++;
          }
          opLog("CONFLICT_RENAME: destination renamed to resolve a collision");
          conflictResolutions.push({ filename, destDir, action: "rename", resolvedTo: path.basename(destFile) });
          // fall through to move with renamed path
        } else {
          // keep_existing or skip: leave destination untouched, skip source
          opLog(`CONFLICT_SKIP: existing destination skipped (policy: ${conflictPolicy})`);
          conflictResolutions.push({ filename, destDir, action: conflictPolicy });
          conflictSkipped++;
          if ((i + 1) % 5 === 0 || moved + excluded + conflictSkipped === total) {
            const pct = 26 + Math.round(((moved + excluded + conflictSkipped) / total) * 55);
            send("progress", { index: i + 1, total, filename, moved, progress: pct });
          }
          continue;
        }
      }

      // Persist a move intent BEFORE touching either filesystem path. If the
      // process exits between the move and its verified checkpoint, Recovery
      // Center still knows the source, destination, and expected checksum.
      const sourceHash = await sha256File(sf.fullPath);
      const intent: FileMoveRecord = {
        from: sf.fullPath,
        to: destFile,
        sourceHash,
        destHash: sourceHash,
        verified: false,
        sourceRelPath: sf.relativePath,
      };
      fileMoves.push(intent);
      try {
        const [owned] = await db.update(organizationJobsTable)
          .set({ fileMoves: fileMoves as any })
          .where(and(
            eq(organizationJobsTable.id, id),
            eq(organizationJobsTable.nasPath, nasPath),
            eq(organizationJobsTable.leaseToken, executionLeaseToken),
            eq(organizationJobsTable.status, "executing"),
          ))
          .returning({ id: organizationJobsTable.id });
        if (!owned) throw new Error("Organization worker lease was lost before the move intent was saved.");
      } catch (e: any) {
        fileMoves.pop();
        throw new Error(`File-move intent checkpoint failed: ${e.message ?? String(e)}`, { cause: e });
      }

      // verifiedMove computes the source hash again, performs an exclusive
      // no-replace move, and verifies the destination bytes.
      await assertOrganizationLease(id, nasPath, executionLeaseToken);
      const record = await verifiedMove(sf.fullPath, destFile, {
        sourceRelPath: sf.relativePath,
        expectedSourceHash: sourceHash,
        beforeMove: async () => {
          await assertOrganizationLease(id, nasPath, executionLeaseToken);
          ensureDataDirectoryWithinRoot(destDir, nasPath);
        },
        beforeRestore: async () => {
          await assertOrganizationLease(id, nasPath, executionLeaseToken);
          ensureDataDirectoryWithinRoot(path.dirname(sf.fullPath), nasPath);
        },
      });
      fileMoves[fileMoves.length - 1] = record;
      moved++;

      opLog("MOVE_OK [sha256]: move verified");

      // Replace the durable intent with the completed, checksum-verified move.
      try {
        const [owned] = await db.update(organizationJobsTable)
          .set({ fileMoves: fileMoves as any })
          .where(and(
            eq(organizationJobsTable.id, id),
            eq(organizationJobsTable.nasPath, nasPath),
            eq(organizationJobsTable.leaseToken, executionLeaseToken),
            eq(organizationJobsTable.status, "executing"),
          ))
          .returning({ id: organizationJobsTable.id });
        if (!owned) throw new Error("Organization worker lease was lost before its verified move was saved.");
      } catch (e: any) {
        // The persisted intent remains sufficient for crash recovery. The
        // in-memory verified record lets this process roll the move back now.
        throw new Error(`File-move recovery checkpoint failed: ${e.message ?? String(e)}`, { cause: e });
      }

      if ((i + 1) % 5 === 0 || moved + excluded + conflictSkipped === total) {
        const pct = 26 + Math.round(((moved + excluded + conflictSkipped) / total) * 55);
        send("progress", { index: i + 1, total, filename: path.basename(sf.relativePath), moved, progress: pct });
      }
    }

    // ── Stage 6: Strict verification — 100% of moved files must exist + per-dest recount ──
    await setStage("verifying");
    send("status", { stage: "verifying", message: "Verifying all moved files at destination…", progress: 83 });

    // Invariant: moved + conflict-skipped must equal total active routes
    if (moved + conflictSkipped !== total) {
      throw new Error(`Move count mismatch: moved ${moved} + skipped ${conflictSkipped} = ${moved + conflictSkipped} but plan expected ${total}. Investigation required.`);
    }

    // Re-hash every destination at the completion boundary. Inline verification
    // proves the bytes immediately after each move; this second pass catches
    // later modification before the job is reported as completed.
    let checksumVerifiedCount = 0;
    const unverified: string[] = [];
    for (const mv of fileMoves) {
      if (!fs.existsSync(mv.to)) {
        unverified.push(mv.to);
        opLog("VERIFY_FAIL: destination file missing");
        continue;
      }
      const actualHash = await sha256File(mv.to);
      if (actualHash !== mv.sourceHash) {
        unverified.push(mv.to);
        opLog("VERIFY_FAIL: destination checksum mismatch");
        continue;
      }
      checksumVerifiedCount++;
    }
    const checksumUnverifiedCount = fileMoves.length - checksumVerifiedCount;
    if (unverified.length > 0) {
      throw new Error(`Verification failed: ${unverified.length}/${fileMoves.length} moved files missing or checksum-mismatched at destination.`);
    }
    opLog(`VERIFY_FILES: ${fileMoves.length}/${fileMoves.length} at destination — sha256-verified: ${checksumVerifiedCount}, failed-verification: ${checksumUnverifiedCount}`);

    // Per-destination directory recount — groups moved files by dest dir and recounts each
    const destCountMap = new Map<string, { expected: number; found: number }>();
    for (const mv of fileMoves) {
      const dir = path.dirname(mv.to);
      if (!destCountMap.has(dir)) destCountMap.set(dir, { expected: 0, found: 0 });
      destCountMap.get(dir)!.expected++;
      if (fs.existsSync(mv.to)) destCountMap.get(dir)!.found++;
    }
    const destVerification: Array<{ dir: string; expected: number; found: number; ok: boolean }> = [];
    for (const [dir, counts] of destCountMap) {
      const ok = counts.found === counts.expected;
      destVerification.push({ dir: path.basename(dir), expected: counts.expected, found: counts.found, ok });
      opLog(`VERIFY_DEST: destination group expected=${counts.expected} found=${counts.found} ok=${ok}`);
    }
    const destVerifyFailed = destVerification.filter(d => !d.ok);
    if (destVerifyFailed.length > 0) {
      throw new Error(
        `Destination recount failed: ${destVerifyFailed.map(d => `${d.dir}: expected ${d.expected}, found ${d.found}`).join("; ")}`
      );
    }
    opLog(`VERIFY_DEST_OK: ${destVerification.length} destination group(s) all match`);

    // ── Archive disposition (post 100% verification) ─────────────────────────
    let dispositionApplied = "kept";
    let dispositionPending = false;
    let dispositionError: string | null = null;
    let dispositionSourceHash: string | null = null;

    if (job.sourceType === "archive" && job.archiveDisposition !== "keep") {
      if (job.archiveDisposition === "delete") {
        // REQUIRES explicit second confirmation — do NOT delete automatically
        dispositionPending = true;
        opLog("DISPOSITION_PENDING: delete requires explicit confirmation via apply-disposition endpoint");
        send("status", { stage: "disposition", message: "Archive delete requires your confirmation — see summary", progress: 92 });
      } else if (job.archiveDisposition === "move_to_processed") {
        send("status", { stage: "disposition", message: "Moving archive to processed folder…", progress: 92 });
        try {
          const processedDir = ensureDirectoryWithinRoot(path.join(getWillardAIDir(nasPath), "archive-index", "processed"), nasPath);
          const dest = path.join(processedDir, path.basename(job.sourcePath));
          dispositionSourceHash = await sha256File(job.sourcePath);
          await assertOrganizationLease(id, nasPath, executionLeaseToken);
          moveFileNoReplace(job.sourcePath, dest);
          const destinationHash = await sha256File(dest);
          if (destinationHash !== dispositionSourceHash) {
            try {
              await assertOrganizationLease(id, nasPath, executionLeaseToken);
              moveFileNoReplace(dest, job.sourcePath);
            } catch (restoreError) {
              throw new Error("Archive move checksum verification failed and the archive could not be restored: " + (restoreError instanceof Error ? restoreError.message : String(restoreError)));
            }
            throw new Error("Archive move checksum verification failed; the original archive was restored.");
          }
          dispositionApplied = "moved_to:" + dest;
          opLog("DISPOSE_MOVE: archive moved to processed folder and SHA-256 verified");
        } catch (e: any) {
          dispositionPending = true;
          dispositionError = redactText(e instanceof Error ? e.message : String(e));
          opLog("DISPOSE_MOVE_FAIL: " + dispositionError);
          send("status", { stage: "disposition_failed", message: "Archive could not be moved to processed. Retry from the completed job report.", progress: 92 });
        }
      }
    }

    // ── Report ───────────────────────────────────────────────────────────────
    send("status", { stage: "report", message: "Writing job report…", progress: 95 });

    const completedAt = new Date();
    const conflictsTotal   = conflictResolutions.length;
    const conflictsSkipped = conflictResolutions.filter(c => c.action === "keep_existing" || c.action === "skip").length;
    const conflictsReplaced = conflictResolutions.filter(c => c.action === "replace").length;
    const conflictsRenamed  = conflictResolutions.filter(c => c.action === "rename").length;
    if (conflictsTotal > 0) opLog(`CONFLICTS: total=${conflictsTotal} skipped=${conflictsSkipped} replaced=${conflictsReplaced} renamed=${conflictsRenamed} policy=${conflictPolicy}`);

    // Per-file verification summary for the report (cap at 500 to avoid oversized JSONB)
    const fileVerifications = fileMoves.slice(0, 500).map(m => ({
      filename:        path.basename(m.to),
      destination:     m.to,
      sourceHash:      m.sourceHash,
      destHash:        m.destHash,
      verified:        m.verified,
      verificationMethod: "sha256",
    }));

    const report: any = {
      jobId: id, completedAt: completedAt.toISOString(),
      sourceType: job.sourceType, sourcePath: job.sourcePath, archiveDisposition: job.archiveDisposition,
      conflictPolicy,
      filesFound: sourceFiles.length, filesMoved: moved, filesExcluded: excluded,
      filesVerified: fileMoves.length, dispositionApplied, dispositionPending, dispositionError, dispositionSourceHash,
      // Checksum verification summary
      checksumVerifiedCount,
      checksumUnverifiedCount,
      fileVerifications,         // per-file SHA-256 results (capped at 500)
      conflictsTotal, conflictsSkipped, conflictsReplaced, conflictsRenamed,
      conflictResolutions: conflictResolutions.slice(0, 200), // cap log size
      destinations: plan.destinations,
      destVerification,
      archiveCrcValidation: crcValidation,
      archiveExtractionChecksums: archiveExtractionChecksums.length > 0 ? archiveExtractionChecksums : undefined,
      aiConfidence: plan.aiConfidence, aiNotes: plan.aiNotes,
      logPath,
    };

    let reportPath = "";
    try {
      const reportsDir = ensureDirectoryWithinRoot(path.join(getWillardAIDir(nasPath), "reports"), nasPath);
      reportPath = path.join(reportsDir, `org-${ts}-${id}.json`);
      const safeReport = redactOperationalData(report);
      fs.writeFileSync(reportPath, JSON.stringify(safeReport, null, 2), { encoding: "utf-8", mode: 0o600 });
      try { fs.chmodSync(reportPath, 0o600); } catch { /* best effort */ }
      pruneOperationalFiles(reportsDir, "org-", 30);
      opLog("REPORT: report written with sensitive identifiers redacted");
    } catch (reportError) {
      operationLogger.error({ err: reportError }, "Organization report export failed");
      opLog("WARN: report export failed; job completion remains recorded");
    }

    opLog(`=== Job #${id} COMPLETED ${completedAt.toISOString()} — moved:${moved} excluded:${excluded} sha256-ok:${checksumVerifiedCount} failed-verify:${checksumUnverifiedCount} ===`);
    logStream?.end();

    const safeReport = redactOperationalData(report) as Record<string, unknown>;
    const [completedJob] = await db.update(organizationJobsTable).set({
      status: "completed",
      fileMoves: fileMoves as any,
      reportJson: safeReport as any,
      reportPath: reportPath || null,
      completedAt,
      leaseToken: null,
    }).where(and(
      eq(organizationJobsTable.id, id),
      eq(organizationJobsTable.nasPath, nasPath),
      eq(organizationJobsTable.leaseToken, executionLeaseToken),
      eq(organizationJobsTable.status, "executing"),
    )).returning({ id: organizationJobsTable.id });
    if (!completedJob) throw new Error("Organization worker lease was lost before completion could be committed.");
    void requestLibraryBackup("completed organization job");

    send("complete", { ...safeReport, progress: 100 });

  } catch (err) {
    const errMsg = redactText(err instanceof Error ? err.message : "Unknown error");
    operationLogger.error({ err, phase: "execute_failed", rolledBackMoves: fileMoves.length }, "Organization job failed; rollback started");
    opLog(`ERROR: ${errMsg}`);
    send("status", { stage: "rolling_back", message: "Error — rolling back all moves…", progress: -1 });

    // Do not let a worker that lost ownership roll back files now owned by a replacement.
    try {
      await assertOrganizationLease(id, cleanupNasPath, executionLeaseToken);
    } catch {
      send("error", { message: "This worker lost ownership of the job. Its recovery journal was preserved for the current owner.", rolledBack: 0 });
      return;
    }

    // rollbackMoves reverses in LIFO order, verifies each restored file against sourceHash
    let rolledBack = 0;
    try {
      rolledBack = await rollbackMoves(fileMoves, line => opLog(line), async (move) => {
        await assertOrganizationLease(id, cleanupNasPath, executionLeaseToken);
        ensureDataDirectoryWithinRoot(path.dirname(move.from), cleanupNasPath);
        ensureDataDirectoryWithinRoot(path.dirname(move.to), cleanupNasPath);
      });
    } catch {
      send("error", { message: "This worker lost ownership during rollback. Remaining recovery records were preserved.", rolledBack });
      return;
    }
    opLog(`=== Job #${id} ROLLED_BACK ${rolledBack}/${fileMoves.length} moves reversed ===`);
    logStream?.end();

    const rollbackComplete = rolledBack === fileMoves.length;
    const recoveryError = rollbackComplete
      ? errMsg
      : `${errMsg} Rollback incomplete: ${rolledBack}/${fileMoves.length} files were restored; manual recovery is required.`;
    await db.update(organizationJobsTable).set({
      status: rollbackComplete ? "rolled_back" : "failed",
      error: recoveryError,
      fileMoves: fileMoves as any,
      completedAt: new Date(),
      leaseToken: null,
    }).where(and(
      eq(organizationJobsTable.id, id),
      eq(organizationJobsTable.nasPath, cleanupNasPath),
      eq(organizationJobsTable.leaseToken, executionLeaseToken),
      eq(organizationJobsTable.status, "executing"),
    )).catch(() => {});

    send("error", { message: errMsg, rolledBack });
  } finally {
    stopHeartbeat?.();
    if (capacityReservation) releaseCapacity(capacityReservation.id);
    for (const td of tempDirs) cleanTempDir(td, cleanupNasPath);
    res.end();
  }
});

/**
 * Apply archive disposition after the user explicitly confirms.
 * Only valid for completed jobs with archiveDisposition === "delete".
 * The body must include { confirm: true } to proceed.
 */
router.post("/organize/jobs/:id/apply-disposition", async (req, res) => {
  const id = parsePositiveIntegerParam(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid job id" }); return; }
  try {
    const nasPath = await getNasPath();
    if (!nasPath) { res.status(409).json({ error: "No library configured" }); return; }
    const job = await getScopedOrganizationJob(id, nasPath);
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    if (job.status !== "completed") { res.status(409).json({ error: "Job must be completed before applying disposition" }); return; }
    // Do not accept truthy strings/numbers for a destructive or file-moving action.
    if (req.body?.confirm !== true) {
      res.status(400).json({ error: "confirm: true is required to execute an archive disposition" }); return;
    }

    if (job.sourceType !== "archive") {
      res.status(400).json({ error: "Disposition is only valid for archive source jobs" }); return;
    }
    if (job.archiveDisposition !== "delete" && job.archiveDisposition !== "move_to_processed") {
      res.status(409).json({ error: "This job has no pending archive disposition" }); return;
    }

    let sourcePath: string;
    try { sourcePath = resolveActiveArchivePath(job.sourcePath, nasPath); }
    catch { res.status(403).json({ error: "sourcePath is outside the active library — disposition refused" }); return; }

    const report = job.reportJson && typeof job.reportJson === "object" && !Array.isArray(job.reportJson)
      ? job.reportJson as Record<string, unknown>
      : {};
    const previousResult = typeof report.dispositionApplied === "string" ? report.dispositionApplied : "";
    const alreadyApplied = report.dispositionPending === false && (
      previousResult === "deleted" ||
      previousResult === "already_gone" ||
      previousResult.startsWith("moved_to:")
    );
    if (alreadyApplied) {
      res.json({ ok: true, dispositionResult: previousResult, sourcePath, alreadyApplied: true });
      return;
    }

    let dispositionResult = "kept";
    let sourceHash: string | null = typeof report.dispositionSourceHash === "string"
      ? report.dispositionSourceHash
      : null;

    if (job.archiveDisposition === "delete") {
      if (!fs.existsSync(sourcePath)) {
        dispositionResult = "already_gone";
      } else {
        const srcStat = fs.lstatSync(sourcePath);
        if (!srcStat.isFile() || srcStat.isSymbolicLink()) {
          res.status(400).json({ error: "sourcePath is not a regular non-symlink file — refusing to delete" }); return;
        }
        assertWithinRoot(path.resolve(sourcePath), path.resolve(nasPath));
        fs.unlinkSync(sourcePath);
        dispositionResult = "deleted";
      }
    } else {
      const processedDir = ensureDirectoryWithinRoot(path.join(getWillardAIDir(nasPath), "archive-index", "processed"), nasPath);
      const dest = path.join(processedDir, path.basename(sourcePath));

      if (!fs.existsSync(sourcePath)) {
        // Recover an interrupted move only when its recorded checksum proves
        // that the processed copy is the same archive this job intended to move.
        if (!fs.existsSync(dest) || !sourceHash || await sha256File(dest) !== sourceHash) {
          res.status(409).json({ error: "The original archive is missing and the processed copy cannot be verified. No disposition status was changed." });
          return;
        }
      } else {
        const srcStat = fs.lstatSync(sourcePath);
        if (!srcStat.isFile() || srcStat.isSymbolicLink()) {
          res.status(400).json({ error: "sourcePath is not a regular non-symlink file — refusing to move" }); return;
        }
        assertWithinRoot(path.resolve(sourcePath), path.resolve(nasPath));
        if (fs.existsSync(dest)) {
          res.status(409).json({ error: "A file with the same name already exists in the processed folder. No file was overwritten." });
          return;
        }
        sourceHash = await sha256File(sourcePath);
        moveFileNoReplace(sourcePath, dest);
        const destinationHash = await sha256File(dest);
        if (destinationHash !== sourceHash) {
          try {
            moveFileNoReplace(dest, sourcePath);
          } catch (restoreError) {
            throw new Error("Processed archive checksum verification failed and the original could not be restored: " + (restoreError instanceof Error ? restoreError.message : String(restoreError)));
          }
          throw new Error("Processed archive checksum verification failed; the original archive was restored.");
        }
      }
      dispositionResult = "moved_to:" + dest;
    }

    const nextReport = {
      ...report,
      dispositionApplied: dispositionResult,
      dispositionPending: false,
      dispositionError: null,
      dispositionSourceHash: sourceHash,
      dispositionUpdatedAt: new Date().toISOString(),
    };
    const [updatedJob] = await db.update(organizationJobsTable)
      .set({ reportJson: nextReport as any })
      .where(and(
        eq(organizationJobsTable.id, id),
        eq(organizationJobsTable.nasPath, nasPath),
        eq(organizationJobsTable.status, "completed"),
      ))
      .returning({ id: organizationJobsTable.id });
    if (!updatedJob) throw new Error("Archive disposition completed, but its result could not be saved. Reopen the report and verify the archive location.");

    res.json({ ok: true, dispositionResult, sourcePath });
  } catch (e: any) {
    if (e?.code === "EEXIST") {
      res.status(409).json({ error: "The processed destination already exists. No file was overwritten." });
      return;
    }
    res.status(500).json({ error: e.message ?? "Failed to apply disposition" });
  }
});

// ── Recovery Center ────────────────────────────────────────────────────────────

/**
 * List jobs that are stuck in non-terminal states.
 * "executing" means the server likely crashed mid-run.
 */
router.get("/organize/recovery", async (_req, res) => {
  try {
    const nasPath = await getNasPath();
    if (!nasPath) { res.json({ interrupted: [] }); return; }
    const staleBefore = new Date(Date.now() - ORGANIZATION_EXECUTION_LEASE_MS);
    const jobs = await db
      .select()
      .from(organizationJobsTable)
      .where(and(
        eq(organizationJobsTable.nasPath, nasPath),
        or(
          and(
            eq(organizationJobsTable.status, "failed"),
            isNotNull(organizationJobsTable.lastStage),
          ),
          and(
            inArray(organizationJobsTable.status, ["executing", "rolling_back"]),
            or(
              isNull(organizationJobsTable.stageUpdatedAt),
              lt(organizationJobsTable.stageUpdatedAt, staleBefore),
            ),
          ),
        ),
      ))
      .orderBy(desc(organizationJobsTable.createdAt))
      .limit(50);
    res.json({ interrupted: jobs.map(publicOrganizationJob) });
  } catch { res.status(500).json({ error: "Failed to query recovery data" }); }
});

/**
 * Roll back an interrupted job using its stored (partial) fileMoves.
 * Valid for jobs in "executing" or "failed" status only.
 */
router.post("/organize/jobs/:id/rollback", async (req, res) => {
  const id = parsePositiveIntegerParam(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid job id" }); return; }
  let stopHeartbeat: (() => void) | null = null;
  let nasPath = "";
  let rollbackLeaseToken = "";
  try {
    const configuredNasPath = await getNasPath();
    if (!configuredNasPath) { res.status(404).json({ error: "Storage library is not configured" }); return; }
    nasPath = configuredNasPath;
    const job = await getScopedOrganizationJob(id, nasPath);
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    if (!["executing", "failed", "rolling_back"].includes(job.status)) {
      res.status(409).json({ error: `Job status is '${job.status}' — only interrupted or failed jobs can be rolled back here` }); return;
    }
    let moves: FileMoveRecord[];
    try {
      moves = parseOrganizationMoveJournal(job.fileMoves, nasPath);
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : "Recovery journal is invalid" });
      return;
    }

    // Rollback moves files and changes the recovery journal. Claim it only
    // after the previous worker is failed or its heartbeat has expired.
    const staleBefore = new Date(Date.now() - ORGANIZATION_EXECUTION_LEASE_MS);
    rollbackLeaseToken = crypto.randomUUID();
    const [claimedRollback] = await db.update(organizationJobsTable)
      .set({ status: "rolling_back", lastStage: "rolling_back", stageUpdatedAt: new Date(), leaseToken: rollbackLeaseToken })
      .where(and(
        eq(organizationJobsTable.id, id),
        eq(organizationJobsTable.nasPath, nasPath),
        or(
          eq(organizationJobsTable.status, "failed"),
          and(
            inArray(organizationJobsTable.status, ["executing", "rolling_back"]),
            or(
              isNull(organizationJobsTable.stageUpdatedAt),
              lt(organizationJobsTable.stageUpdatedAt, staleBefore),
            ),
          ),
        ),
      ))
      .returning({ id: organizationJobsTable.id });
    if (!claimedRollback) {
      res.status(409).json({ error: "This job is still running. Wait for its heartbeat to expire before rolling it back." });
      return;
    }
    stopHeartbeat = startOrganizationJobHeartbeat(id, nasPath, rollbackLeaseToken, "rolling_back");

    const logs: string[] = [];
    await assertOrganizationLease(id, nasPath, rollbackLeaseToken);
    const rolledBack = await rollbackMoves(moves, line => logs.push(line), async (move) => {
      await assertOrganizationLease(id, nasPath, rollbackLeaseToken);
      ensureDataDirectoryWithinRoot(path.dirname(move.from), nasPath);
      ensureDataDirectoryWithinRoot(path.dirname(move.to), nasPath);
    });
    const isComplete = rolledBack === moves.length;

    // Only mark rolled_back when ALL moves were reversed.
    // Partial rollback keeps failed status so the user knows manual intervention is needed.
    const [updatedRollback] = await db.update(organizationJobsTable).set({
      status: isComplete ? "rolled_back" : "failed",
      error: isComplete
        ? `Rolled back via Recovery Center: ${rolledBack}/${moves.length} move(s) reversed.`
        : `Partial rollback: only ${rolledBack}/${moves.length} move(s) reversed — manual intervention may be required.`,
      completedAt: isComplete ? new Date() : null,
      leaseToken: null,
    }).where(and(
      eq(organizationJobsTable.id, id),
      eq(organizationJobsTable.nasPath, nasPath),
      eq(organizationJobsTable.leaseToken, rollbackLeaseToken),
      eq(organizationJobsTable.status, "rolling_back"),
    )).returning({ id: organizationJobsTable.id });
    if (!updatedRollback) {
      res.status(409).json({ error: "Rollback worker lost ownership before its final recovery status could be saved. The recovery journal remains available." });
      return;
    }

    res.json({ ok: isComplete, rolledBack, total: moves.length, partial: !isComplete, logs });
  } catch (e: any) {
    if (nasPath) {
      try {
        await db.update(organizationJobsTable)
          .set({ status: "failed", error: e.message ?? "Rollback failed", stageUpdatedAt: new Date(), leaseToken: null })
          .where(and(
            eq(organizationJobsTable.id, id),
            eq(organizationJobsTable.nasPath, nasPath),
            eq(organizationJobsTable.leaseToken, rollbackLeaseToken),
            eq(organizationJobsTable.status, "rolling_back"),
          ));
      } catch (persistError) {
        logger.error({ err: persistError, jobId: id }, "Could not persist organization rollback failure");
      }
    }
    res.status(500).json({ error: e.message ?? "Rollback failed" });
  } finally {
    stopHeartbeat?.();
  }
});

/**
 * Reset an interrupted job back to "verified" so the user can re-execute.
 * Clears partial fileMoves so a fresh run starts cleanly.
 */
router.post("/organize/jobs/:id/reset", async (req, res) => {
  const id = parsePositiveIntegerParam(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid job id" }); return; }
  try {
    const nasPath = await getNasPath();
    if (!nasPath) { res.status(404).json({ error: "Storage library is not configured" }); return; }
    const job = await getScopedOrganizationJob(id, nasPath);
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    if (!["executing", "failed"].includes(job.status)) {
      res.status(409).json({ error: `Job status is '${job.status}' — only interrupted or failed jobs can be reset` }); return;
    }
    if (!job.planJson || !job.preflightJson) {
      res.status(409).json({ error: "Job is missing plan or preflight data — delete and recreate it" }); return;
    }
    if (job.fileMoves !== null && job.fileMoves !== undefined &&
        (!Array.isArray(job.fileMoves) || job.fileMoves.length > 0)) {
      res.status(409).json({
        error: "This job still has file-move recovery records. Resume it or complete rollback in Recovery Center before resetting; the move journal will not be discarded.",
      });
      return;
    }

    // Reset is destructive to the recovery journal. Only allow it after a
    // failed job or an executing job whose heartbeat has gone stale.
    const staleBefore = new Date(Date.now() - ORGANIZATION_EXECUTION_LEASE_MS);
    const [resetJob] = await db.update(organizationJobsTable).set({
      status: "verified",
      error: null,
      fileMoves: null,
      lastStage: "reset",
      stageUpdatedAt: new Date(),
    }).where(and(
      eq(organizationJobsTable.id, id),
      eq(organizationJobsTable.nasPath, nasPath),
      or(
        isNull(organizationJobsTable.fileMoves),
        sql`CASE WHEN jsonb_typeof(${organizationJobsTable.fileMoves}) = 'array' THEN jsonb_array_length(${organizationJobsTable.fileMoves}) = 0 ELSE false END`,
      ),
      or(
        eq(organizationJobsTable.status, "failed"),
        and(
          eq(organizationJobsTable.status, "executing"),
          or(
            isNull(organizationJobsTable.stageUpdatedAt),
            lt(organizationJobsTable.stageUpdatedAt, staleBefore),
          ),
        ),
      ),
    )).returning({ id: organizationJobsTable.id });

    if (!resetJob) {
      res.status(409).json({ error: "This job is still executing. Wait for its heartbeat to expire before resetting it." });
      return;
    }

    res.json({ ok: true, status: "verified" });
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? "Reset failed" });
  }
});

router.post("/organize/jobs/:id/resume-token", async (req, res) => {
  const id = parsePositiveIntegerParam(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid job id" }); return; }
  
  try {
    const nasPath = await getNasPath();
    const job = nasPath ? await getScopedOrganizationJob(id, nasPath) : undefined;
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    if (!["executing", "failed"].includes(job.status) || !job.planJson) {
      res.status(409).json({ error: "Only interrupted jobs with a plan can be resumed" });
      return;
    }
    const token = await issueActionToken(req, "organize-resume", String(id));
    res.json({ token, expiresInSeconds: 300 });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not authorize resume" });
  }
});

/**
 * Resume an interrupted job from where it left off (SSE).
 * Re-stages the source, skips files already at their destinations per stored fileMoves,
 * moves the remaining files with SHA-256 verification, then marks the job complete.
 */
router.get("/organize/jobs/:id/resume", async (req, res) => {
  const id = parsePositiveIntegerParam(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid job id" }); return; }

  if (!await consumeActionToken(req, req.query.token, "organize-resume", String(id))) {
    res.status(403).json({ error: "A valid one-time resume token is required." });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (event: string, data: object) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const tempDirs: string[] = [];
  let cleanupNasPath = "";
  const newMoves: FileMoveRecord[] = [];
  // Declared outside try so catch can restore DB fileMoves to pre-resume baseline on failure
  let existingMoves: FileMoveRecord[] = [];
  let capacityReservation: CapacityReservation | null = null;
  let stopHeartbeat: (() => void) | null = null;
  let resumeLeaseToken = "";

  try {
    const [job] = await db.select().from(organizationJobsTable).where(eq(organizationJobsTable.id, id)).limit(1);
    if (!job)                                              { send("error", { message: "Job not found" });                                    res.end(); return; }
    if (!["executing", "failed"].includes(job.status))    { send("error", { message: `Cannot resume a job with status '${job.status}' — only interrupted (executing or failed) jobs can be resumed` }); res.end(); return; }
    if (!job.planJson)                                     { send("error", { message: "Job has no plan — delete and recreate it" });           res.end(); return; }

    const plan = job.planJson as any;
    const settings = await getActiveAppSettings();
    const nasPath = (settings?.nasPath ?? "").trim();
    if (!nasPath || !path.isAbsolute(nasPath)) {
      send("error", { message: "NAS path is not configured" }); res.end(); return;
    }
    cleanupNasPath = nasPath;
    try { resolveWithinRoot(job.sourcePath, nasPath); }
    catch { send("error", { message: "Job source is outside the configured library" }); res.end(); return; }
    try {
      existingMoves = parseOrganizationMoveJournal(job.fileMoves, nasPath);
    } catch (error) {
      send("error", { message: error instanceof Error ? error.message : "Recovery journal is invalid" });
      res.end();
      return;
    }
    if (existingMoves.some((move) => !move.verified)) {
      send("error", { message: "This job has a pending file-move intent from an interrupted attempt. Complete rollback in Recovery Center before resuming." });
      res.end();
      return;
    }

    // Resume only a failed job or an executing job whose heartbeat has gone
    // stale. The conditional update is the cross-process compare-and-swap:
    // only one resume request can acquire the lease.
    const staleBefore = new Date(Date.now() - ORGANIZATION_EXECUTION_LEASE_MS);
    resumeLeaseToken = crypto.randomUUID();
    const [claimedResume] = await db.update(organizationJobsTable)
      .set({ status: "executing", lastStage: "resuming", stageUpdatedAt: new Date(), leaseToken: resumeLeaseToken })
      .where(and(
        eq(organizationJobsTable.id, id),
        eq(organizationJobsTable.nasPath, nasPath),
        or(
          eq(organizationJobsTable.status, "failed"),
          and(
            eq(organizationJobsTable.status, "executing"),
            or(
              isNull(organizationJobsTable.stageUpdatedAt),
              lt(organizationJobsTable.stageUpdatedAt, staleBefore),
            ),
          ),
        ),
      ))
      .returning({ id: organizationJobsTable.id });
    if (!claimedResume) {
      send("error", { message: "This organization job is already running. Wait for it to stop before resuming." });
      res.end();
      return;
    }
    stopHeartbeat = startOrganizationJobHeartbeat(id, nasPath, resumeLeaseToken);

    const excludedCategories = new Set<string>(plan.excludeCategories ?? []);
    const excludedPaths = new Set<string>(plan.excludePaths ?? []);
    const activeRoutes: any[] = (plan.routes ?? []).filter((r: any) =>
      !excludedCategories.has(r.fileType) && !excludedPaths.has(r.relativePath)
    );
    const requiredNasBytes = activeRoutes.reduce((sum, route) => sum + Math.max(0, Number(route.sizeBytes) || 0), 0);
    try {
      capacityReservation = await reserveCapacity({
        nasPath,
        operation: `Resume organization job #${id}`,
        nasBytes: requiredNasBytes,
      });
    } catch (error) {
      const admission = error instanceof CapacityAdmissionError ? error.admission : null;
      const message = error instanceof Error ? error.message : "Organization resume capacity admission failed";
      stopHeartbeat?.();
      stopHeartbeat = null;
      await db.update(organizationJobsTable)
        .set({ status: job.status, lastStage: job.lastStage, stageUpdatedAt: job.stageUpdatedAt, error: message, leaseToken: null })
        .where(and(
          eq(organizationJobsTable.id, id),
          eq(organizationJobsTable.nasPath, nasPath),
          eq(organizationJobsTable.leaseToken, resumeLeaseToken),
          eq(organizationJobsTable.status, "executing"),
        ));
      send("error", { code: "CAPACITY_UNSAFE", message, capacity: admission });
      return;
    }

    // The job was claimed atomically before capacity admission; do not
    // issue an unconditional status update that could overwrite the lease.

    // Stage checkpoint helper for resume — awaited, non-throwing
    const setStage = async (stage: string): Promise<void> => {
      try {
        const [owned] = await db.update(organizationJobsTable)
          .set({ lastStage: stage, stageUpdatedAt: new Date() })
          .where(and(
            eq(organizationJobsTable.id, id),
            eq(organizationJobsTable.nasPath, nasPath),
            eq(organizationJobsTable.leaseToken, resumeLeaseToken),
            eq(organizationJobsTable.status, "executing"),
          ))
          .returning({ id: organizationJobsTable.id });
        if (!owned) throw new Error("Organization resume worker lost its lease.");
      } catch (e: any) {
        if (e instanceof Error && e.message.includes("lost its lease")) throw e;
        send("log", { message: `WARN: Stage checkpoint '${stage}' failed: ${e.message ?? String(e)}` });
      }
    };

    // Existing partial moves from the interrupted run
    // Primary idempotency: by sourceRelPath (rename-safe — stored since last execute).
    // Fallback: by destination path for legacy records that predate sourceRelPath.
    const alreadyMovedRelPaths = new Set<string>(
      existingMoves.filter((m: any) => m.sourceRelPath != null).map((m: any) => m.sourceRelPath as string)
    );
    const alreadyMovedDests = new Set<string>(existingMoves.map(m => m.to));

    await setStage("staging");
    send("status", { stage: "staging", message: `Resuming — ${existingMoves.length} file(s) already at destination, re-staging source…`, progress: 2 });

    const planDestMap = new Map<string, string>();
    for (const r of (plan.routes ?? [])) {
      if (r.relativePath && r.destination) planDestMap.set(r.relativePath, r.destination);
    }

    const tempDir = getTempDir(nasPath, `org-resume-${id}`);
    tempDirs.push(tempDir);

    let sourceFiles: Array<{fullPath: string; relativePath: string; fileType: string; sizeBytes: number}> = [];

    if (job.sourceType === "archive") {
      await setStage("extracting");
      send("status", { stage: "extracting", message: "Re-extracting archive to staging area…", progress: 5 });
      if (!fs.existsSync(job.sourcePath)) { send("error", { message: `Archive not found: ${job.sourcePath}` }); res.end(); return; }
      const extractResult = await safeExtractArchive(job.sourcePath, tempDir, nasPath);
      const { entriesExtracted } = extractResult;
      send("status", { stage: "scanning", message: `Extracted ${entriesExtracted} entries, scanning…`, progress: 24 });
      sourceFiles = walkDir(tempDir).map(w => ({ fullPath: w.fullPath, relativePath: w.relativePath, fileType: w.fileType, sizeBytes: w.sizeBytes }));
    } else {
      if (!fs.existsSync(job.sourcePath)) { send("error", { message: `Source folder not found: ${job.sourcePath}` }); res.end(); return; }
      const walked = walkDir(job.sourcePath);
      const stagingBase = path.join(tempDir, "staged");
      let staged = 0;
      for (const w of walked) {
        const dest = path.join(stagingBase, w.relativePath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(w.fullPath, dest);
        staged++;
        if (staged % 20 === 0) send("status", { stage: "staging", message: `Staged ${staged}/${walked.length}…`, progress: 5 + Math.round((staged / walked.length) * 17) });
      }
      sourceFiles = walkDir(stagingBase).map(w => ({ fullPath: w.fullPath, relativePath: w.relativePath, fileType: w.fileType, sizeBytes: w.sizeBytes }));
    }

    const total = activeRoutes.length;
    const conflictPolicy: string = (job as any).conflictPolicy ?? "keep_existing";

    let moved = 0;
    let skippedAlready = 0;
    let conflictSkipped = 0;
    let excluded = 0;

    await setStage("moving");
    send("status", { stage: "moving", message: `Moving remaining files (${existingMoves.length} already done)…`, progress: 26, total });

    for (let i = 0; i < sourceFiles.length; i++) {
      const sf = sourceFiles[i];
      const ft = sf.fileType === "image" ? "image" : sf.fileType === "video" ? "video" : sf.fileType === "document" ? "document" : "other";

      if (excludedCategories.has(ft) || excludedPaths.has(sf.relativePath)) { excluded++; continue; }

      const planDest = planDestMap.get(sf.relativePath);
      if (!planDest) { excluded++; continue; }

      const destDir = planDest;
      let destFile  = path.join(destDir, path.basename(sf.relativePath));

      assertWithinRoot(path.resolve(destDir), path.resolve(nasPath));

      // Already moved in the interrupted run — skip.
      // Prefer sourceRelPath matching (rename-safe); fall back to dest-path for legacy records.
      const alreadyMoved = alreadyMovedRelPaths.has(sf.relativePath) ||
        (alreadyMovedRelPaths.size === 0 && alreadyMovedDests.has(destFile));
      if (alreadyMoved) {
        skippedAlready++;
        if ((i + 1) % 5 === 0) {
          const pct = 26 + Math.round(((moved + skippedAlready + conflictSkipped + excluded) / total) * 55);
          send("progress", { index: i + 1, total, filename: path.basename(sf.relativePath), moved: existingMoves.length + moved, skippedAlready, progress: pct });
        }
        continue;
      }

      // Conflict handling for files not yet moved
      if (fs.existsSync(destFile)) {
        if (conflictPolicy === "replace") {
          throw new Error(
            "Replace is temporarily unavailable because this operation cannot yet preserve the existing destination for crash recovery. " +
            "Choose Rename or Keep Existing; no destination file was changed.",
          );
        } else if (conflictPolicy === "rename") {
          const ext  = path.extname(path.basename(sf.relativePath));
          const base = path.basename(sf.relativePath).slice(0, path.basename(sf.relativePath).length - ext.length);
          let suffix = 1;
          while (fs.existsSync(destFile)) {
            destFile = path.join(destDir, `${base}_${suffix}${ext}`);
            suffix++;
          }
        } else {
          conflictSkipped++;
          continue;
        }
      }

      ensureDataDirectoryWithinRoot(destDir, nasPath);
      const sourceHash = await sha256File(sf.fullPath);
      const intent: FileMoveRecord = {
        from: sf.fullPath,
        to: destFile,
        sourceHash,
        destHash: sourceHash,
        verified: false,
        sourceRelPath: sf.relativePath,
      };
      newMoves.push(intent);

      // Persist the intent before moving so a crash between filesystem mutation
      // and the verified checkpoint still leaves a recoverable journal entry.
      const intentJournal = [...existingMoves, ...newMoves];
      try {
        const [owned] = await db.update(organizationJobsTable)
          .set({ fileMoves: intentJournal as any })
          .where(and(
            eq(organizationJobsTable.id, id),
            eq(organizationJobsTable.nasPath, nasPath),
            eq(organizationJobsTable.leaseToken, resumeLeaseToken),
            eq(organizationJobsTable.status, "executing"),
          ))
          .returning({ id: organizationJobsTable.id });
        if (!owned) throw new Error("Organization resume worker lost its lease before saving its move intent.");
      } catch (e: any) {
        newMoves.pop();
        throw new Error(`Resume move-intent checkpoint failed: ${e.message ?? String(e)}`, { cause: e });
      }

      await assertOrganizationLease(id, nasPath, resumeLeaseToken);
      const record = await verifiedMove(sf.fullPath, destFile, {
        sourceRelPath: sf.relativePath,
        expectedSourceHash: sourceHash,
        beforeMove: async () => {
          await assertOrganizationLease(id, nasPath, resumeLeaseToken);
          ensureDataDirectoryWithinRoot(destDir, nasPath);
        },
        beforeRestore: async () => {
          await assertOrganizationLease(id, nasPath, resumeLeaseToken);
          ensureDataDirectoryWithinRoot(path.dirname(sf.fullPath), nasPath);
        },
      });
      newMoves[newMoves.length - 1] = record;
      moved++;

      // Replace the durable intent with the checksum-verified move record.
      const merged = [...existingMoves, ...newMoves];
      try {
        const [owned] = await db.update(organizationJobsTable)
          .set({ fileMoves: merged as any })
          .where(and(
            eq(organizationJobsTable.id, id),
            eq(organizationJobsTable.nasPath, nasPath),
            eq(organizationJobsTable.leaseToken, resumeLeaseToken),
            eq(organizationJobsTable.status, "executing"),
          ))
          .returning({ id: organizationJobsTable.id });
        if (!owned) throw new Error("Organization resume worker lost its lease before saving the verified move.");
      } catch (e: any) {
        // The persisted intent remains sufficient for Recovery Center rollback.
        throw new Error(`Resume file-move recovery checkpoint failed: ${e.message ?? String(e)}`, { cause: e });
      }

      if ((i + 1) % 5 === 0 || moved + skippedAlready + conflictSkipped + excluded >= sourceFiles.length) {
        const pct = 26 + Math.round(((moved + skippedAlready + conflictSkipped + excluded) / total) * 55);
        send("progress", { index: i + 1, total, filename: path.basename(sf.relativePath), moved: existingMoves.length + moved, skippedAlready, progress: pct });
      }
    }

    // ── Plan coverage invariant (mirrors execute route's count check) ──────────
    // Every active planned route must be accounted for as moved (existing + new) or
    // conflict-skipped.  If coverage is short, the re-staged source changed after the
    // original job was planned; fail rather than silently mark incomplete work as done.
    const allMoves: FileMoveRecord[] = [...existingMoves, ...newMoves];
    const planCoverage = allMoves.length + conflictSkipped;
    if (planCoverage !== total) {
      throw new Error(
        `Resume coverage check failed: ${allMoves.length} moved + ${conflictSkipped} conflict-skipped = ${planCoverage} ` +
        `but plan had ${total} active route(s). ` +
        `${total - planCoverage} planned file(s) could not be located in the re-staged source — ` +
        `the source may have changed since the original job was planned.`
      );
    }

    await setStage("verifying");
    send("status", { stage: "verifying", message: "Verifying all files at destination…", progress: 85 });

    const unverified: string[] = [];
    let checksumVerified = 0;
    for (const mv of allMoves) {
      if (!fs.existsSync(mv.to)) {
        unverified.push(mv.to);
        continue;
      }
      const actualHash = await sha256File(mv.to);
      if (actualHash !== mv.sourceHash) {
        unverified.push(mv.to);
        continue;
      }
      checksumVerified++;
    }
    if (unverified.length > 0) {
      throw new Error(`Verification failed: ${unverified.length}/${allMoves.length} moved files missing or checksum-mismatched at destination`);
    }

    const completedAt = new Date();
    const report: any = {
      jobId: id, status: "completed", completedAt: completedAt.toISOString(),
      sourcePath: job.sourcePath, sourceType: job.sourceType,
      moved: allMoves.length, skippedAlready, conflictSkipped, excluded,
      checksumVerified, resumedFrom: existingMoves.length,
    };

    const [completedJob] = await db.update(organizationJobsTable).set({
      status: "completed",
      fileMoves: allMoves as any,
      reportJson: report as any,
      completedAt,
      leaseToken: null,
    }).where(and(
      eq(organizationJobsTable.id, id),
      eq(organizationJobsTable.nasPath, nasPath),
      eq(organizationJobsTable.leaseToken, resumeLeaseToken),
      eq(organizationJobsTable.status, "executing"),
    )).returning({ id: organizationJobsTable.id });
    if (!completedJob) throw new Error("Organization resume worker lost its lease before completion could be committed.");
    void requestLibraryBackup("completed organization recovery");

    send("complete", { ...report, progress: 100 });

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    send("status", { stage: "rolling_back", message: "Resume error — rolling back new moves…", progress: -1 });

    // A worker that lost ownership must not undo files handled by its replacement.
    try {
      await assertOrganizationLease(id, cleanupNasPath, resumeLeaseToken);
    } catch {
      send("error", { message: "This resume worker lost ownership. Its durable recovery journal was preserved.", rolledBack: 0 });
      return;
    }

    // Roll back only the moves performed in THIS resume pass (existingMoves stay at destination)
    let rolledBack = 0;
    try {
      rolledBack = await rollbackMoves(newMoves, () => {}, async (move) => {
        await assertOrganizationLease(id, cleanupNasPath, resumeLeaseToken);
        ensureDataDirectoryWithinRoot(path.dirname(move.from), cleanupNasPath);
        ensureDataDirectoryWithinRoot(path.dirname(move.to), cleanupNasPath);
      });
    } catch {
      send("error", { message: "This resume worker lost ownership during rollback. Remaining recovery records were preserved.", rolledBack });
      return;
    }
    const resumeRollbackComplete = rolledBack === newMoves.length;
    // Only discard this pass's journal when every new move was restored and
    // checksum-verified. Keep all records if rollback is partial so Recovery
    // Center still has the evidence needed for manual/repeated recovery.
    const retainedMoves = resumeRollbackComplete ? existingMoves : [...existingMoves, ...newMoves];
    const recoveryError = resumeRollbackComplete
      ? `Resume failed: ${errMsg}. Rolled back ${rolledBack}/${newMoves.length} new move(s) from this resume pass.`
      : `Resume failed: ${errMsg}. Rollback incomplete: ${rolledBack}/${newMoves.length} new move(s) restored; the full move journal was retained for manual recovery.`;
    await db.update(organizationJobsTable).set({
      status: "failed",
      fileMoves: retainedMoves as any,
      error: recoveryError,
      leaseToken: null,
    }).where(and(
      eq(organizationJobsTable.id, id),
      eq(organizationJobsTable.nasPath, cleanupNasPath),
      eq(organizationJobsTable.leaseToken, resumeLeaseToken),
      eq(organizationJobsTable.status, "executing"),
    )).catch(() => {});

    send("error", { message: errMsg, rolledBack });
  } finally {
    stopHeartbeat?.();
    if (capacityReservation) releaseCapacity(capacityReservation.id);
    for (const td of tempDirs) cleanTempDir(td, cleanupNasPath);
    res.end();
  }
});

export default router;
