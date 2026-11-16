/**
 * Safe finalization for staged media conversions.
 *
 * Originals are first moved to a recoverable backup location. Staged outputs
 * are then published with verified, no-overwrite moves. Any ordinary runtime
 * failure rolls the completed moves back in reverse order and preserves the
 * staging directory for another attempt.
 *
 * A process crash between filesystem mutation and the next database update is
 * still outside this in-memory rollback boundary; this helper is not a durable
 * crash-recovery journal.
 */
import * as fs from "fs";
import * as path from "path";
import { assertWithinRoot, ensureDirectoryWithinRoot } from "./nas-storage.ts";
import {
  rollbackMoves,
  sha256File,
  verifiedMove,
  type FileMoveRecord,
} from "./organize-helpers.ts";

export type ConversionFinalizeAction = "recycle" | "replace" | "keep-both" | "archive";

export interface ConversionFinalizeFile {
  filePath: string;
  stagedPath?: string;
  status: string;
}

export interface ConversionFinalizeInput {
  action: ConversionFinalizeAction;
  nasPath: string;
  stagingDir: string;
  trashBase: string;
  archiveBase: string;
  files: ConversionFinalizeFile[];
  /** Test seam for simulating a destination appearing after preflight. */
  beforeMoveHook?: (move: { from: string; to: string; kind: "backup" | "publish"; index: number }) => void | Promise<void>;
  /** Persist the source identity before any filesystem mutation. */
  onMoveIntent?: (move: FileMoveRecord) => void | Promise<void>;
  /** Persist the verified result after each filesystem mutation. */
  onMoveComplete?: (move: FileMoveRecord) => void | Promise<void>;
  /** Cross-process ownership check, run immediately before each move. */
  assertOwnership?: () => void;
}

export interface ConversionFinalizeOutcome {
  originalPath: string;
  outputPath: string;
  action: ConversionFinalizeAction;
}

export interface ConversionFinalizeResult {
  outcomes: ConversionFinalizeOutcome[];
  moves: FileMoveRecord[];
}

export class ConversionFinalizationError extends Error {
  readonly rollbackComplete: boolean;
  readonly recoveryMoves: FileMoveRecord[];
  readonly journalMoves: FileMoveRecord[];

  constructor(
    message: string,
    rollbackComplete: boolean,
    recoveryMoves: FileMoveRecord[] = [],
    journalMoves: FileMoveRecord[] = [],
  ) {
    super(message);
    this.name = "ConversionFinalizationError";
    this.rollbackComplete = rollbackComplete;
    this.recoveryMoves = recoveryMoves;
    this.journalMoves = journalMoves;
  }
}

interface PlannedFile {
  originalPath: string;
  stagedPath: string;
  outputPath: string;
  backupPath?: string;
  originalHash?: string;
  stagedHash: string;
}

function lstatIfExists(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

function requireRegularFile(filePath: string, label: string): fs.Stats {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file: ${filePath}`);
  }
  return stat;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function moveAndTrack(
  from: string,
  to: string,
  expectedHash: string,
  moves: FileMoveRecord[],
  beforeMoveHook: ConversionFinalizeInput["beforeMoveHook"],
  onMoveIntent: ConversionFinalizeInput["onMoveIntent"],
  onMoveComplete: ConversionFinalizeInput["onMoveComplete"],
  assertOwnership: ConversionFinalizeInput["assertOwnership"],
  kind: "backup" | "publish",
): Promise<void> {
  const index = moves.length;
  const intent: FileMoveRecord = {
    from,
    to,
    sourceHash: expectedHash,
    destHash: "",
    verified: false,
  };

  // The database checkpoint must complete before the first link/copy/unlink.
  // If the process stops after this point, startup recovery can inspect both
  // paths and decide whether the move happened.
  await onMoveIntent?.(intent);
  moves.push(intent);

  try {
    await beforeMoveHook?.({ from, to, kind, index });
    assertOwnership?.();
    const record = await verifiedMove(from, to, { expectedSourceHash: expectedHash });
    moves[index] = record;
    // If this checkpoint fails, the pre-move intent is still durable and the
    // in-memory record is available for immediate rollback.
    await onMoveComplete?.(record);
  } catch (error) {
    // Keep the pre-move intent even if verifiedMove could not complete. The
    // rollback helper distinguishes an untouched source from a completed move
    // by checking both paths and the expected source hash.
    throw error;
  }
}

async function findUnrestoredMoves(moves: FileMoveRecord[]): Promise<FileMoveRecord[]> {
  const unresolved: FileMoveRecord[] = [];
  for (const move of moves) {
    try {
      const source = requireRegularFile(move.from, "Rollback source");
      if (source.isSymbolicLink() || await sha256File(move.from) !== move.sourceHash) {
        unresolved.push(move);
      }
    } catch {
      unresolved.push(move);
    }
  }
  return unresolved;
}

export async function finalizeConversionFiles(
  input: ConversionFinalizeInput,
): Promise<ConversionFinalizeResult> {
  const moves: FileMoveRecord[] = [];
  try {
    assertWithinRoot(input.stagingDir, input.nasPath);
    const stagingStat = lstatIfExists(input.stagingDir);
    if (!stagingStat?.isDirectory() || stagingStat.isSymbolicLink()) {
      throw new Error("Conversion staging path is not a regular directory");
    }

    const plans: PlannedFile[] = [];
    const outputKeys = new Set<string>();

    for (const file of input.files) {
      if (file.status !== "success") continue;
      if (!file.stagedPath) throw new Error(`Successful conversion is missing its staged path: ${file.filePath}`);

      const originalPath = path.resolve(file.filePath);
      const stagedPath = path.resolve(file.stagedPath);
      assertWithinRoot(originalPath, input.nasPath);
      assertWithinRoot(stagedPath, input.stagingDir);
      requireRegularFile(originalPath, "Original media");
      requireRegularFile(stagedPath, "Staged conversion");

      const originalExt = path.extname(originalPath).slice(1).toLowerCase();
      const convertedExt = path.extname(stagedPath).slice(1).toLowerCase();
      if (!convertedExt) throw new Error(`Converted file has no extension: ${stagedPath}`);

      const crossFormat = convertedExt !== originalExt;
      const stem = path.basename(originalPath, path.extname(originalPath));
      const directory = path.dirname(originalPath);
      const relativePath = path.relative(path.resolve(input.nasPath), originalPath);
      if (!isInside(input.nasPath, originalPath) || !relativePath) {
        throw new Error(`Original media path is not a child of the active library: ${originalPath}`);
      }

      const outputPath = input.action === "keep-both"
        ? path.join(directory, `${stem}_optimized.${convertedExt}`)
        : crossFormat
          ? path.join(directory, `${stem}.${convertedExt}`)
          : originalPath;
      assertWithinRoot(outputPath, input.nasPath);

      const outputKey = process.platform === "win32" ? outputPath.toLowerCase() : outputPath;
      if (outputKeys.has(outputKey)) throw new Error(`Multiple conversions target the same output path: ${outputPath}`);
      outputKeys.add(outputKey);

      if (outputPath !== originalPath && lstatIfExists(outputPath)) {
        throw new Error(`Conversion output already exists; no files were changed: ${outputPath}`);
      }

      let backupPath: string | undefined;
      if (input.action === "replace") {
        backupPath = path.join(input.stagingDir, ".originals", relativePath);
        assertWithinRoot(backupPath, input.nasPath);
        assertWithinRoot(backupPath, input.stagingDir);
      } else if (input.action === "recycle") {
        // Use the application's recoverable trash on every platform. This
        // avoids a Windows Recycle Bin side effect that cannot be rolled back
        // deterministically if publishing the converted file then fails.
        backupPath = path.join(input.trashBase, relativePath);
        assertWithinRoot(backupPath, input.nasPath);
      } else if (input.action === "archive") {
        backupPath = path.join(input.archiveBase, relativePath);
        assertWithinRoot(backupPath, input.nasPath);
      }

      if (backupPath && lstatIfExists(backupPath)) {
        throw new Error(`Original backup destination already exists; no files were changed: ${backupPath}`);
      }

      plans.push({
        originalPath,
        stagedPath,
        outputPath,
        backupPath,
        originalHash: backupPath ? await sha256File(originalPath) : undefined,
        stagedHash: await sha256File(stagedPath),
      });
    }

    const outcomes: ConversionFinalizeOutcome[] = [];
    for (const plan of plans) {
      if (plan.backupPath && plan.originalHash) {
        input.assertOwnership?.();
        ensureDirectoryWithinRoot(path.dirname(plan.backupPath), input.nasPath);
        await moveAndTrack(
          plan.originalPath,
          plan.backupPath,
          plan.originalHash,
          moves,
          input.beforeMoveHook,
          input.onMoveIntent,
          input.onMoveComplete,
          input.assertOwnership,
          "backup",
        );
      }

      // The original directory already exists because preflight verified the
      // original file. verifiedMove publishes with exclusive no-replace rules.
      await moveAndTrack(
        plan.stagedPath,
        plan.outputPath,
        plan.stagedHash,
        moves,
        input.beforeMoveHook,
        input.onMoveIntent,
        input.onMoveComplete,
        input.assertOwnership,
        "publish",
      );
      outcomes.push({
        originalPath: plan.originalPath,
        outputPath: plan.outputPath,
        action: input.action,
      });
    }

    return { outcomes, moves };
  } catch (error) {
    let rollbackCount = 0;
    try {
      input.assertOwnership?.();
      rollbackCount = await rollbackMoves(moves);
    } catch {
      // The per-file verification below determines whether manual recovery is
      // still required. If ownership was lost, do not mutate files during rollback.
    }
    const recoveryMoves = await findUnrestoredMoves(moves);
    const rollbackComplete = recoveryMoves.length === 0 && rollbackCount === moves.length;
    throw new ConversionFinalizationError(
      `${errorMessage(error)}${rollbackComplete ? " All completed file moves were restored; staged conversions are preserved." : " Automatic rollback was incomplete; preserve all remaining files for manual recovery."}`,
      rollbackComplete,
      recoveryMoves,
      moves,
    );
  }
}

/**
 * Reconcile a persisted pre-move journal after a process restart. Every path is
 * revalidated against the active library root before rollback; malformed or
 * out-of-root records are retained for manual recovery and never touched.
 */
export async function recoverConversionFinalizationMoves(
  moves: FileMoveRecord[],
  nasPath: string,
  assertOwnership?: () => void,
): Promise<{ complete: boolean; rollbackCount: number; unresolvedMoves: FileMoveRecord[] }> {
  const safeMoves: FileMoveRecord[] = [];
  const unresolvedMoves: FileMoveRecord[] = [];

  for (const move of moves) {
    try {
      if (
        !move ||
        typeof move.from !== "string" ||
        typeof move.to !== "string" ||
        !/^[a-f0-9]{64}$/i.test(move.sourceHash)
      ) {
        throw new Error("Malformed conversion finalization journal entry");
      }
      assertWithinRoot(move.from, nasPath);
      assertWithinRoot(move.to, nasPath);
      safeMoves.push(move);
    } catch {
      unresolvedMoves.push(move);
    }
  }

  let rollbackCount = 0;
  try {
    for (const move of [...safeMoves].reverse()) {
      assertOwnership?.();
      rollbackCount += await rollbackMoves([move]);
    }
  } catch {
    // The verification pass below decides whether any source remains missing
    // or changed. Do not discard an entry merely because one rollback threw.
  }

  assertOwnership?.();
  const unresolvedSafeMoves = await findUnrestoredMoves(safeMoves);
  unresolvedMoves.push(...unresolvedSafeMoves);
  if (rollbackCount !== safeMoves.length && unresolvedSafeMoves.length === 0) {
    // A count mismatch is itself a failed recovery invariant. Retain every
    // involved record rather than clearing a journal on an ambiguous result.
    unresolvedMoves.push(...safeMoves);
  }
  const complete = unresolvedMoves.length === 0 && rollbackCount === safeMoves.length;
  return { complete, rollbackCount, unresolvedMoves };
}
