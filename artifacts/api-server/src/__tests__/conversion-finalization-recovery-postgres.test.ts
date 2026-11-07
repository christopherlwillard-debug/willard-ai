import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { db, pool, conversionJobsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { recoverInterruptedConversionJobs } from "../lib/conversion-recovery.ts";
import { sha256File, type FileMoveRecord } from "../lib/organize-helpers.ts";

async function ensureConversionJobsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversion_jobs (
      id serial PRIMARY KEY,
      status text NOT NULL DEFAULT 'pending',
      approved_exts jsonb NOT NULL DEFAULT '[]'::jsonb,
      backup_dir text,
      nas_path text NOT NULL,
      total_files integer NOT NULL DEFAULT 0,
      processed_files integer NOT NULL DEFAULT 0,
      succeeded_files integer NOT NULL DEFAULT 0,
      failed_files integer NOT NULL DEFAULT 0,
      skipped_files integer NOT NULL DEFAULT 0,
      result_json jsonb,
      error text,
      cancelled_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(),
      completed_at timestamp
    )
  `);
}

function createFixture(): { root: string; original: string; backup: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-finalization-recovery-pg-"));
  const original = path.join(root, "photos", "original.jpg");
  const backup = path.join(root, "WillardAI", "conversions", "job-1", ".originals", "photos", "original.jpg");
  fs.mkdirSync(path.dirname(original), { recursive: true });
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.writeFileSync(original, "original media bytes");
  return {
    root,
    original,
    backup,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

async function insertAwaitingJob(nasPath: string, move: FileMoveRecord): Promise<number> {
  const [job] = await db.insert(conversionJobsTable).values({
    status: "awaiting_action",
    approvedExts: [],
    nasPath,
    resultJson: {
      files: [],
      totalSaved: 0,
      stagingDir: path.join(nasPath, "WillardAI", "conversions", "job-1"),
      finalizationJournal: [move],
      finalizationRecoveryMoves: [],
    },
  }).returning({ id: conversionJobsTable.id });
  assert.ok(job);
  return job.id;
}

after(async () => {
  await pool.end();
});

test("startup recovery restores a moved original from a persisted pre-move journal", async () => {
  await ensureConversionJobsTable();
  const fixture = createFixture();
  let jobId = 0;
  try {
    const sourceHash = await sha256File(fixture.original);
    fs.renameSync(fixture.original, fixture.backup);
    const move: FileMoveRecord = {
      from: fixture.original,
      to: fixture.backup,
      sourceHash,
      destHash: "",
      verified: false,
    };
    jobId = await insertAwaitingJob(fixture.root, move);

    const recovered = await recoverInterruptedConversionJobs();
    assert.equal(recovered, 1);
    const [job] = await db.select().from(conversionJobsTable).where(eq(conversionJobsTable.id, jobId));
    const result = job?.resultJson as {
      finalizationJournal?: unknown[];
      finalizationRecoveryMoves?: unknown[];
    } | null;
    assert.equal(job?.status, "awaiting_action");
    assert.deepEqual(result?.finalizationJournal, []);
    assert.deepEqual(result?.finalizationRecoveryMoves, []);
    assert.equal(fs.readFileSync(fixture.original, "utf8"), "original media bytes");
    assert.equal(fs.existsSync(fixture.backup), false);
  } finally {
    if (jobId) await db.delete(conversionJobsTable).where(eq(conversionJobsTable.id, jobId));
    fixture.cleanup();
  }
});

test("startup recovery preserves a changed backup and durably blocks automatic finalization", async () => {
  await ensureConversionJobsTable();
  const fixture = createFixture();
  let jobId = 0;
  try {
    const sourceHash = await sha256File(fixture.original);
    fs.renameSync(fixture.original, fixture.backup);
    fs.writeFileSync(fixture.backup, "changed after move");
    const move: FileMoveRecord = {
      from: fixture.original,
      to: fixture.backup,
      sourceHash,
      destHash: "",
      verified: false,
    };
    jobId = await insertAwaitingJob(fixture.root, move);

    const recovered = await recoverInterruptedConversionJobs();
    assert.equal(recovered, 0);
    const [job] = await db.select().from(conversionJobsTable).where(eq(conversionJobsTable.id, jobId));
    const result = job?.resultJson as {
      finalizationJournal?: unknown[];
      finalizationRecoveryMoves?: unknown[];
      finalizationError?: string;
    } | null;
    assert.equal(job?.status, "awaiting_action");
    assert.equal(result?.finalizationJournal?.length, 1);
    assert.equal(result?.finalizationRecoveryMoves?.length, 1);
    assert.match(result?.finalizationError ?? "", /manual recovery/i);
    assert.equal(fs.existsSync(fixture.original), false);
    assert.equal(fs.readFileSync(fixture.backup, "utf8"), "changed after move");
  } finally {
    if (jobId) await db.delete(conversionJobsTable).where(eq(conversionJobsTable.id, jobId));
    fixture.cleanup();
  }
});
