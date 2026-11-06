import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import { getSevenZipPath } from "./sevenzip.ts";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import {
  ARCHIVE_LIMITS,
  createArchiveExpansionLimiter,
} from "./archive-safety.ts";
import { StoragePolicyError } from "./storage-policy.ts";

export type TarCompression = "none" | "gzip" | "bzip2" | "xz";
export type TarInputFailureKind = "input" | "tar-parse";

/** Resolve compression from the full filename so double extensions are not lost. */
export function getTarCompression(filename: string): TarCompression {
  const name = path.basename(filename).toLowerCase();
  if (name.endsWith(".tar.gz") || name.endsWith(".tgz") || name.endsWith(".gz")) return "gzip";
  if (name.endsWith(".tar.bz2") || name.endsWith(".tbz2") || name.endsWith(".bz2")) return "bzip2";
  if (name.endsWith(".tar.xz") || name.endsWith(".txz") || name.endsWith(".xz")) return "xz";
  return "none";
}

/**
 * A bare .gz/.bz2/.xz file may be a compressed document rather than a TAR.
 * Only a successfully decompressed, unparseable, empty listing qualifies;
 * named TAR wrappers and decompressor failures must remain errors.
 */
export function shouldTreatAsStandaloneCompressedFile(
  filename: string,
  entryCount: number,
  failureKind: TarInputFailureKind | null,
): boolean {
  if (entryCount !== 0 || failureKind !== "tar-parse") return false;
  const name = path.basename(filename).toLowerCase();
  return /\.(?:gz|bz2|xz)$/.test(name) && !/\.tar\.(?:gz|bz2|xz)$/.test(name);
}

/**
 * Make a plain TAR file available to the tar library. tar itself supports
 * gzip, but not bzip2 or xz; those formats are decompressed with argument-array
 * child processes so archive filenames are never interpreted by a shell.
 *
 * The scratch directory is caller-owned. Compressed archive bytes must never
 * be decompressed into the OS temp directory because the result can be large
 * and is part of a NAS-required media operation.
 */
export async function withTarInput<T>(
  archivePath: string,
  filename: string,
  scratchDir: string,
  callback: (tarPath: string, options: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  const compression = getTarCompression(filename);
  if (compression === "none") return callback(archivePath, {});
  if (!scratchDir) throw new StoragePolicyError("NAS storage is required for compressed archive decompression.");

  const tarPath = path.join(scratchDir, ".willard-input-" + crypto.randomUUID() + ".tar");
  const child = compression === "gzip"
    ? null
    : spawn(getSevenZipPath(), ["x", "-so", archivePath, "-y"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
  let stderr = "";
  child?.stderr?.setEncoding("utf8");
  child?.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  const exit = child
    ? new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => {
          if (code === 0) resolve();
          else reject(new Error(
            "7-Zip " + compression + " decompression failed" +
            (signal ? " (" + signal + ")" : "") +
            ": " + (stderr.trim() || "exit code " + code),
          ));
        });
      })
    : Promise.resolve();

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
