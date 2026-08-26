/**
 * Recovery Center integration coverage.
 *
 * These tests leave a job in the same persisted shape a process crash would
 * leave behind, then exercise the real rollback and resume HTTP endpoints.
 *
 * Run with:
 *   node --experimental-strip-types --test src/__tests__/organize-recovery.test.ts
 */

import { describe, test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  db,
  pool,
  appSettingsTable,
  organizationJobsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  sha256File,
  verifiedMove,
  type FileMoveRecord,
} from "../lib/organize-helpers.ts";

const API_BASE = process.env["WILLARD_API_URL"]
  ?? (process.env["REPLIT_DEV_DOMAIN"]
    ? `https://${process.env["REPLIT_DEV_DOMAIN"]}`
    : "http://localhost:8080");
const PASSWORD = "willard123";

let nasPath = "";
let cookie = "";
const jobIds: number[] = [];
let testRoot = "";

async function post(route: string, body: unknown): Promise<Response> {
  const response = await fetch(`${API_BASE}/api${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const setCookie = response.headers.get("set-cookie")?.match(/willard\.sid=[^;]+/);
  if (setCookie) cookie = setCookie[0];
  return response;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

async function createRecoveryJob(
  sourcePath: string,
  routes: Array<{ relativePath: string; destination: string; fileType?: string }>,
  fileMoves: FileMoveRecord[],
): Promise<number> {
  const [job] = await db.insert(organizationJobsTable).values({
    status: "executing",
    sourceType: "folder",
    sourcePath,
    nasPath,
    conflictPolicy: "keep_existing",
    planJson: {
      routes: routes.map(route => ({
        ...route,
        filename: path.basename(route.relativePath),
        sizeBytes: 1,
        fileType: route.fileType ?? "other",
      })),
    },
    preflightJson: { ok: true },
    fileMoves: fileMoves as any,
    lastStage: "moving",
  }).returning({ id: organizationJobsTable.id });
  assert.ok(job, "recovery job should be inserted");
  jobIds.push(job.id);
  return job.id;
}

describe("organize Recovery Center crash recovery", { concurrency: false }, () => {
  before(async () => {
    const [settings] = await db
      .select({ configuredNasPath: appSettingsTable.nasPath })
      .from(appSettingsTable)
      .limit(1);
    nasPath = settings?.configuredNasPath?.trim() ?? "";
    assert.ok(nasPath, "A configured test library is required");
    assert.ok(fs.existsSync(nasPath), "The configured test library must be reachable");
    testRoot = fs.mkdtempSync(path.join(nasPath, ".willard-organize-recovery-"));

    const auth = await post("/auth/login", { password: PASSWORD });
    assert.equal(auth.status, 200, `Login failed: ${await auth.text()}`);
  });

  after(async () => {
    for (const id of jobIds) {
      await db.delete(organizationJobsTable).where(eq(organizationJobsTable.id, id));
    }
    fs.rmSync(testRoot, { recursive: true, force: true });
    await pool.end();
  });

  test("persists verified moves before an interrupted execute", async () => {
    const sourceDir = path.join(testRoot, "checkpoint-source");
    const destination = path.join(testRoot, "checkpoint-destination");
    const stagedDir = path.join(testRoot, "checkpoint-staged");
    const sourceFiles = ["first.txt", "second.txt", "third.txt"].map((name, i) => {
      const source = path.join(sourceDir, name);
      writeFile(source, `checkpoint-${i}`);
      return source;
    });
    const originalHashes = await Promise.all(sourceFiles.map(sha256File));

    const jobId = await createRecoveryJob(
      sourceDir,
      sourceFiles.map(file => ({
        relativePath: path.basename(file),
        destination,
      })),
      [],
    );

    const persistedMoves: FileMoveRecord[] = [];
    for (let i = 0; i < 2; i++) {
      const staged = path.join(stagedDir, path.basename(sourceFiles[i]!));
      writeFile(staged, fs.readFileSync(sourceFiles[i]!, "utf8"));
      const record = await verifiedMove(
        staged,
        path.join(destination, path.basename(sourceFiles[i]!)),
        { sourceRelPath: path.basename(sourceFiles[i]!) },
      );
      persistedMoves.push(record);
      await db.update(organizationJobsTable)
        .set({ fileMoves: persistedMoves as any, lastStage: "moving" })
        .where(eq(organizationJobsTable.id, jobId));
    }

    // Simulate the process disappearing immediately after the second checkpoint.
    const [persisted] = await db
      .select()
      .from(organizationJobsTable)
      .where(eq(organizationJobsTable.id, jobId));
    assert.equal(persisted?.status, "executing");
    assert.equal((persisted?.fileMoves as FileMoveRecord[]).length, 2);
    assert.deepEqual(
      (persisted?.fileMoves as FileMoveRecord[]).map(move => move.sourceHash),
      originalHashes.slice(0, 2),
    );
  });

  test("POST rollback reverses every persisted move and preserves source hashes", async () => {
    const sourceDir = path.join(testRoot, "rollback-source");
    const destination = path.join(testRoot, "rollback-destination");
    const stagedDir = path.join(testRoot, "rollback-staged");
    const names = ["alpha.txt", "beta.txt", "gamma.txt"];
    const moves: FileMoveRecord[] = [];

    for (const name of names) {
      const staged = path.join(stagedDir, name);
      writeFile(staged, `rollback-${name}`);
      moves.push(await verifiedMove(staged, path.join(destination, name), {
        sourceRelPath: name,
      }));
    }

    const originalHashes = moves.map(move => move.sourceHash);
    const jobId = await createRecoveryJob(
      sourceDir,
      names.map(relativePath => ({ relativePath, destination })),
      moves,
    );

    const response = await post(`/organize/jobs/${jobId}/rollback`, {});
    const body = await response.json() as {
      ok: boolean;
      rolledBack: number;
      total: number;
      partial: boolean;
      logs: string[];
    };
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.rolledBack, names.length);
    assert.equal(body.total, names.length);
    assert.equal(body.partial, false);
    assert.ok(body.logs.some(log => log.startsWith("ROLLBACK_VERIFY_OK:")));
    for (let i = 0; i < moves.length; i++) {
      assert.ok(fs.existsSync(moves[i]!.from), `move ${i} restored`);
      assert.equal(await sha256File(moves[i]!.from), originalHashes[i]);
      assert.ok(!fs.existsSync(moves[i]!.to), `move ${i} destination removed`);
    }

    const [updated] = await db
      .select({ status: organizationJobsTable.status })
      .from(organizationJobsTable)
      .where(eq(organizationJobsTable.id, jobId));
    assert.equal(updated?.status, "rolled_back");
  });

  test("GET resume SSE moves remaining files and persists existing plus new moves", async () => {
    const sourceDir = path.join(testRoot, "resume-source");
    const destination = path.join(testRoot, "resume-destination");
    const stagedDir = path.join(testRoot, "resume-staged");
    const names = ["already.txt", "remaining-a.txt", "remaining-b.txt"];
    for (const name of names) writeFile(path.join(sourceDir, name), `resume-${name}`);

    const existingStaged = path.join(stagedDir, names[0]!);
    writeFile(existingStaged, `resume-${names[0]}`);
    const existingMove = await verifiedMove(
      existingStaged,
      path.join(destination, names[0]!),
      { sourceRelPath: names[0] },
    );
    const jobId = await createRecoveryJob(
      sourceDir,
      names.map(relativePath => ({ relativePath, destination })),
      [existingMove],
    );

    const missingToken = await fetch(`${API_BASE}/api/organize/jobs/${jobId}/resume`, {
      headers: { Cookie: cookie },
    });
    assert.equal(missingToken.status, 403);
    await missingToken.text();

    const tokenResponse = await post(`/organize/jobs/${jobId}/resume-token`, {});
    const tokenBody = await tokenResponse.json() as { token?: string; error?: string };
    assert.equal(tokenResponse.status, 200, tokenBody.error ?? "Resume token request failed");
    assert.ok(tokenBody.token, "Resume token should be returned");

    const authorizedUrl = `${API_BASE}/api/organize/jobs/${jobId}/resume?token=${encodeURIComponent(tokenBody.token)}`;
    const response = await fetch(authorizedUrl, {
      headers: { Cookie: cookie },
    });
    const stream = await response.text();
    assert.equal(response.status, 200, stream);
    assert.match(stream, /event: complete/);
    assert.match(stream, /"resumedFrom":1/);
    assert.match(stream, /"progress":100/);

    const [completed] = await db
      .select()
      .from(organizationJobsTable)
      .where(eq(organizationJobsTable.id, jobId));
    assert.equal(completed?.status, "completed");
    const finalMoves = completed?.fileMoves as FileMoveRecord[];
    assert.equal(finalMoves.length, 3);
    assert.equal(finalMoves[0]?.from, existingMove.from);
    assert.equal(finalMoves[0]?.to, existingMove.to);
    assert.deepEqual(
      finalMoves.map(move => move.sourceRelPath),
      names,
    );
    for (const name of names) {
      assert.ok(fs.existsSync(path.join(destination, name)), `${name} moved`);
    }
    assert.equal(finalMoves.filter(move => move.verified).length, 3);

    const replay = await fetch(authorizedUrl, { headers: { Cookie: cookie } });
    assert.equal(replay.status, 403);
    await replay.text();
  });
});