import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ConversionFinalizationError,
  finalizeConversionFiles,
  recoverConversionFinalizationMoves,
} from "../lib/conversion-finalize.ts";
import { sha256File, type FileMoveRecord } from "../lib/organize-helpers.ts";

interface Fixture {
  root: string;
  stagingDir: string;
  trashBase: string;
  archiveBase: string;
  cleanup: () => void;
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-conversion-finalize-"));
  const stagingDir = path.join(root, "WillardAI", "conversions", "job-1");
  const trashBase = path.join(root, "WillardAI", ".Trash", "test");
  const archiveBase = path.join(root, "WillardAI", "archive");
  fs.mkdirSync(stagingDir, { recursive: true });
  return {
    root,
    stagingDir,
    trashBase,
    archiveBase,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function write(filePath: string, contents: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function input(
  f: Fixture,
  action: "recycle" | "replace" | "keep-both" | "archive",
  files: Array<{ filePath: string; stagedPath: string; status: string }>,
  beforeMoveHook?: Parameters<typeof finalizeConversionFiles>[0]["beforeMoveHook"],
  journalHooks?: Pick<Parameters<typeof finalizeConversionFiles>[0], "onMoveIntent" | "onMoveComplete">,
) {
  return {
    action,
    nasPath: f.root,
    stagingDir: f.stagingDir,
    trashBase: f.trashBase,
    archiveBase: f.archiveBase,
    files,
    beforeMoveHook,
    ...journalHooks,
  } as const;
}

test("replace preserves the original in staging until the verified output is published", async () => {
  const f = fixture();
  try {
    const original = write(path.join(f.root, "photos", "portrait.png"), "original bytes");
    const staged = write(path.join(f.stagingDir, "photos", "portrait.jpg"), "converted bytes");

    const result = await finalizeConversionFiles(input(f, "replace", [
      { filePath: original, stagedPath: staged, status: "success" },
    ]));

    const output = path.join(f.root, "photos", "portrait.jpg");
    assert.equal(fs.readFileSync(output, "utf8"), "converted bytes");
    assert.equal(fs.existsSync(original), false, "cross-format replace publishes under the converted extension");
    assert.equal(
      fs.readFileSync(path.join(f.stagingDir, ".originals", "photos", "portrait.png"), "utf8"),
      "original bytes",
    );
    assert.equal(result.outcomes.length, 1);
    assert.equal(result.moves.length, 2);
  } finally {
    f.cleanup();
  }
});

test("a missing staged output fails preflight without touching any original", async () => {
  const f = fixture();
  try {
    const original = write(path.join(f.root, "photos", "missing.jpg"), "original bytes");
    const missingStage = path.join(f.stagingDir, "photos", "missing.jpg");

    await assert.rejects(
      () => finalizeConversionFiles(input(f, "replace", [
        { filePath: original, stagedPath: missingStage, status: "success" },
      ])),
      (error: unknown) => error instanceof ConversionFinalizationError && error.rollbackComplete,
    );

    assert.equal(fs.readFileSync(original, "utf8"), "original bytes");
    assert.equal(fs.existsSync(path.join(f.stagingDir, ".originals")), false);
  } finally {
    f.cleanup();
  }
});

test("an existing cross-format output is never overwritten and originals remain untouched", async () => {
  const f = fixture();
  try {
    const original = write(path.join(f.root, "videos", "clip.avi"), "original video");
    const staged = write(path.join(f.stagingDir, "videos", "clip.mp4"), "converted video");
    const collision = write(path.join(f.root, "videos", "clip.mp4"), "independent existing video");

    await assert.rejects(
      () => finalizeConversionFiles(input(f, "archive", [
        { filePath: original, stagedPath: staged, status: "success" },
      ])),
      /output already exists/,
    );

    assert.equal(fs.readFileSync(original, "utf8"), "original video");
    assert.equal(fs.readFileSync(staged, "utf8"), "converted video");
    assert.equal(fs.readFileSync(collision, "utf8"), "independent existing video");
    assert.equal(fs.existsSync(path.join(f.archiveBase, "videos", "clip.avi")), false);
  } finally {
    f.cleanup();
  }
});

test("keep-both never overwrites an existing optimized sibling", async () => {
  const f = fixture();
  try {
    const original = write(path.join(f.root, "photos", "portrait.png"), "original bytes");
    const staged = write(path.join(f.stagingDir, "photos", "portrait.webp"), "converted bytes");
    const collision = write(path.join(f.root, "photos", "portrait_optimized.webp"), "existing sibling");

    await assert.rejects(
      () => finalizeConversionFiles(input(f, "keep-both", [
        { filePath: original, stagedPath: staged, status: "success" },
      ])),
      /output already exists/,
    );

    assert.equal(fs.readFileSync(original, "utf8"), "original bytes");
    assert.equal(fs.readFileSync(staged, "utf8"), "converted bytes");
    assert.equal(fs.readFileSync(collision, "utf8"), "existing sibling");
  } finally {
    f.cleanup();
  }
});

test("a mid-finalization destination race rolls every completed move back and preserves the competing file", async () => {
  const f = fixture();
  try {
    const original1 = write(path.join(f.root, "photos", "one.jpg"), "original one");
    const original2 = write(path.join(f.root, "photos", "two.avi"), "original two");
    const staged1 = write(path.join(f.stagingDir, "photos", "one.jpg"), "converted one");
    const staged2 = write(path.join(f.stagingDir, "photos", "two.mp4"), "converted two");
    const competing = path.join(f.root, "photos", "two.mp4");
    let created = false;

    await assert.rejects(
      () => finalizeConversionFiles(input(f, "archive", [
        { filePath: original1, stagedPath: staged1, status: "success" },
        { filePath: original2, stagedPath: staged2, status: "success" },
      ], ({ kind, index }) => {
        if (kind === "publish" && index === 3 && !created) {
          write(competing, "concurrent winner");
          created = true;
        }
      })),
      (error: unknown) => error instanceof ConversionFinalizationError && error.rollbackComplete,
    );

    assert.equal(fs.readFileSync(original1, "utf8"), "original one");
    assert.equal(fs.readFileSync(original2, "utf8"), "original two");
    assert.equal(fs.readFileSync(staged1, "utf8"), "converted one");
    assert.equal(fs.readFileSync(staged2, "utf8"), "converted two");
    assert.equal(fs.readFileSync(competing, "utf8"), "concurrent winner");
    assert.equal(fs.existsSync(path.join(f.archiveBase, "photos", "one.jpg")), false);
    assert.equal(fs.existsSync(path.join(f.archiveBase, "photos", "two.avi")), false);
  } finally {
    f.cleanup();
  }
});

test("recycle uses the application's recoverable trash instead of an unrollbackable OS recycle side effect", async () => {
  const f = fixture();
  try {
    const original = write(path.join(f.root, "documents", "scan.pdf"), "original document");
    const staged = write(path.join(f.stagingDir, "documents", "scan.pdf"), "converted document");

    const result = await finalizeConversionFiles(input(f, "recycle", [
      { filePath: original, stagedPath: staged, status: "success" },
    ]));

    assert.equal(fs.readFileSync(original, "utf8"), "converted document");
    assert.equal(fs.readFileSync(path.join(f.trashBase, "documents", "scan.pdf"), "utf8"), "original document");
    assert.equal(result.outcomes[0]?.action, "recycle");
  } finally {
    f.cleanup();
  }
});


test("finalization persists each move intent before mutation and checkpoints its verified result", async () => {
  const f = fixture();
  try {
    const original = write(path.join(f.root, "photos", "portrait.png"), "original bytes");
    const staged = write(path.join(f.stagingDir, "photos", "portrait.jpg"), "converted bytes");
    const events: string[] = [];
    const journal: FileMoveRecord[] = [];

    await finalizeConversionFiles(input(f, "replace", [
      { filePath: original, stagedPath: staged, status: "success" },
    ], undefined, {
      onMoveIntent: async (move) => {
        events.push(`intent:${path.basename(move.from)}`);
        assert.equal(move.verified, false);
        assert.equal(move.destHash, "");
        assert.equal(fs.existsSync(move.from), true, "source must exist when intent is checkpointed");
        assert.equal(fs.existsSync(move.to), false, "destination must not exist before the intent checkpoint");
        journal.push(move);
      },
      onMoveComplete: async (move) => {
        events.push(`complete:${path.basename(move.from)}`);
        const index = journal.findIndex((entry) => entry.from === move.from && entry.to === move.to);
        assert.ok(index >= 0, "completion must follow a persisted intent");
        assert.equal(move.verified, true);
        assert.equal(fs.existsSync(move.to), true);
        journal[index] = move;
      },
    }));

    assert.deepEqual(events, [
      "intent:portrait.png",
      "complete:portrait.png",
      "intent:portrait.jpg",
      "complete:portrait.jpg",
    ]);
    assert.equal(journal.length, 2);
    assert.ok(journal.every((move) => move.verified));
  } finally {
    f.cleanup();
  }
});

test("startup recovery restores an original moved after its durable intent checkpoint", async () => {
  const f = fixture();
  try {
    const original = write(path.join(f.root, "photos", "portrait.png"), "original bytes");
    const backup = path.join(f.stagingDir, ".originals", "photos", "portrait.png");
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    const sourceHash = await sha256File(original);

    // Simulate process termination after the filesystem move but before the
    // completion checkpoint could update the database journal.
    fs.renameSync(original, backup);
    const recovery = await recoverConversionFinalizationMoves([{
      from: original,
      to: backup,
      sourceHash,
      destHash: "",
      verified: false,
    }], f.root);

    assert.equal(recovery.complete, true);
    assert.equal(recovery.rollbackCount, 1);
    assert.deepEqual(recovery.unresolvedMoves, []);
    assert.equal(fs.readFileSync(original, "utf8"), "original bytes");
    assert.equal(fs.existsSync(backup), false);
  } finally {
    f.cleanup();
  }
});

test("startup recovery safely clears an intent when its filesystem move never started", async () => {
  const f = fixture();
  try {
    const original = write(path.join(f.root, "photos", "portrait.png"), "original bytes");
    const backup = path.join(f.stagingDir, ".originals", "photos", "portrait.png");
    const sourceHash = await sha256File(original);

    const recovery = await recoverConversionFinalizationMoves([{
      from: original,
      to: backup,
      sourceHash,
      destHash: "",
      verified: false,
    }], f.root);

    assert.equal(recovery.complete, true);
    assert.equal(recovery.rollbackCount, 1);
    assert.equal(fs.readFileSync(original, "utf8"), "original bytes");
    assert.equal(fs.existsSync(backup), false);
  } finally {
    f.cleanup();
  }
});

test("startup recovery preserves a changed backup and reports manual recovery", async () => {
  const f = fixture();
  try {
    const original = write(path.join(f.root, "photos", "portrait.png"), "original bytes");
    const backup = path.join(f.stagingDir, ".originals", "photos", "portrait.png");
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    const sourceHash = await sha256File(original);
    fs.renameSync(original, backup);
    fs.writeFileSync(backup, "unexpected changed bytes");

    const recovery = await recoverConversionFinalizationMoves([{
      from: original,
      to: backup,
      sourceHash,
      destHash: "",
      verified: false,
    }], f.root);

    assert.equal(recovery.complete, false);
    assert.equal(recovery.unresolvedMoves.length, 1);
    assert.equal(fs.existsSync(original), false);
    assert.equal(fs.readFileSync(backup, "utf8"), "unexpected changed bytes");
  } finally {
    f.cleanup();
  }
});

test("startup recovery refuses journal paths outside the active library root", async () => {
  const f = fixture();
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "willard-conversion-outside-"));
  try {
    const outside = write(path.join(outsideRoot, "protected.bin"), "do not touch");
    const destination = path.join(f.stagingDir, "protected.bin");
    const sourceHash = await sha256File(outside);

    const recovery = await recoverConversionFinalizationMoves([{
      from: outside,
      to: destination,
      sourceHash,
      destHash: "",
      verified: false,
    }], f.root);

    assert.equal(recovery.complete, false);
    assert.equal(recovery.unresolvedMoves.length, 1);
    assert.equal(fs.readFileSync(outside, "utf8"), "do not touch");
    assert.equal(fs.existsSync(destination), false);
  } finally {
    f.cleanup();
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});
