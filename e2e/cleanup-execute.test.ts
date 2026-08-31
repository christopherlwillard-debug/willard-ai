/**
 * E2E integration test: Cleanup execute endpoint moves files and records history.
 *
 * Covers the three "done looks like" criteria from Task #182:
 *   1. POST /cleanup/execute with a real file ID moves the file to
 *      WillardAI/.Trash and returns recycled=1 with no errors.
 *   2. GET /cleanup/history returns the session recorded during execute.
 *   3. The file is physically present in .Trash with the fileId-prefixed
 *      name that prevents basename collisions.
 *   4. media_files.last_scan_action is set to 'RECYCLED' (verified via psql).
 *
 * Setup strategy
 * ──────────────
 *   • Creates a private temp NAS directory under the workspace root (same
 *     btrfs volume as the app's working directory) to avoid cross-device
 *     rename failures (EXDEV) when /tmp is on a separate btrfs volume.
 *   • Copies two real JPEG files from test-media/Photos/ into the temp NAS
 *     dir so the scanner also adds them to media_files (needed for the
 *     last_scan_action DB assertion).
 *   • Runs a FULL scan, filters duplicate groups to files inside tempNasDir
 *     to avoid EXDEV from stale indexed_files rows pointing at other paths.
 *   • Restores the original NAS path and removes the temp dir in `after()`.
 *
 * Run with:
 *   node --experimental-strip-types --test --test-concurrency=1 e2e/cleanup-execute.test.ts
 */

import { describe, test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { acquireLibraryTestLock } from "../artifacts/api-server/src/__tests__/test-library-lock.ts";

// ─── Configuration ─────────────────────────────────────────────────────────

const REPLIT_BASE = process.env["REPLIT_DEV_DOMAIN"]
  ? `https://${process.env["REPLIT_DEV_DOMAIN"]}`
  : undefined;

const API_BASE =
  process.env["WILLARD_API_URL"] ?? REPLIT_BASE ?? "http://localhost:8080";

const TEST_PASSWORD = "willard123";

/** Path to a real JPEG that we copy twice to create identical duplicate files. */
const SOURCE_JPEG = path.join(
  process.cwd(),
  "test-media",
  "Photos",
  "city.jpg",
);

// ─── HTTP helpers ───────────────────────────────────────────────────────────

let sessionCookie = "";

function authHeaders(): Record<string, string> {
  return sessionCookie ? { Cookie: sessionCookie } : {};
}

function captureSessionCookie(res: Response): void {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return;
  const match = setCookie.match(/willard\.sid=[^;]+/);
  if (match) sessionCookie = match[0];
}

async function apiGet(p: string): Promise<Response> {
  const res = await fetch(`${API_BASE}/api${p}`, { headers: authHeaders() });
  captureSessionCookie(res);
  return res;
}

async function apiOrganizeExecute(jobId: number): Promise<Response> {
  const tokenResponse = await apiPost(
    `/organize/jobs/${jobId}/execute-token`,
    {},
  );
  const tokenResult = await readJson<{ token?: string; error?: string }>(
    tokenResponse,
  );
  assert.strictEqual(
    tokenResult.status,
    200,
    `Could not authorize organize execution: ${tokenResult.text}`,
  );
  assert.ok(
    tokenResult.body.token,
    "Organize execution token should be returned",
  );
  return apiGet(
    `/organize/jobs/${jobId}/execute?token=${encodeURIComponent(tokenResult.body.token)}`,
  );
}

async function apiPost(
  p: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const res = await fetch(`${API_BASE}/api${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  captureSessionCookie(res);
  return res;
}

async function apiPut(
  p: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const res = await fetch(`${API_BASE}/api${p}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  captureSessionCookie(res);
  return res;
}

/** Read the full response body once and return both status and parsed JSON. */
async function readJson<T>(
  res: Response,
): Promise<{ status: number; body: T; text: string }> {
  const text = await res.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = text as unknown as T;
  }
  return { status: res.status, body, text };
}

// ─── Polling helper ─────────────────────────────────────────────────────────

async function pollUntil<T>(
  getter: () => Promise<T>,
  condition: (v: T) => boolean,
  { timeoutMs = 90_000, intervalMs = 2_000, description = "condition" } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await getter();
    if (condition(v)) return v;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

/** Query the PostgreSQL DB via psql and return trimmed stdout. */
function queryDb(sql: string): string {
  const dbUrl = process.env["DATABASE_URL"] ?? "";
  return execFileSync(
    "psql",
    ["--no-psqlrc", "--tuples-only", "--command", sql, "--dbname", dbUrl],
    {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "pipe"],
      timeout: 30_000,
      env: { ...process.env, PGCONNECT_TIMEOUT: "10" },
    },
  ).trim();
}

// ─── State shared across tests ──────────────────────────────────────────────

/** Temp NAS dir lives under the workspace so it shares the btrfs volume with the app. */
const TEMP_NAS_BASE = path.join(process.cwd(), ".tmp-cleanup-test");

let tempNasDir = "";
let originalNasPath = "";
let deleteFileId = -1;
let deletedFilePath = "";
let releaseLibraryTestLock: (() => void) | undefined;

// ─── Suite ──────────────────────────────────────────────────────────────────

describe("Cleanup execute API", { concurrency: false }, () => {
  before(async () => {
    releaseLibraryTestLock = await acquireLibraryTestLock();
    // ── 1. Authenticate ────────────────────────────────────────────────────
    const statusRes = await fetch(`${API_BASE}/api/auth/status`);
    assert.strictEqual(statusRes.status, 200, "Auth status should be 200");
    const status = (await statusRes.json()) as {
      setup: boolean;
      authenticated: boolean;
    };

    if (status.setup) {
      const r = await apiPost("/auth/setup", { password: TEST_PASSWORD });
      assert.ok(r.ok, `Auth setup failed: ${await r.text()}`);
    } else {
      const r = await apiPost("/auth/login", { password: TEST_PASSWORD });
      assert.ok(
        r.ok,
        `Login failed (password must be "${TEST_PASSWORD}"): ${await r.text()}`,
      );
    }
    assert.ok(sessionCookie, "Session cookie must be set after auth");

    // ── 2. Save original NAS path so we can restore it ────────────────────
    const settingsRes = await apiGet("/settings");
    if (settingsRes.ok) {
      const settings = (await settingsRes.json()) as { nasPath?: string };
      originalNasPath = settings.nasPath ?? "";
    }

    // ── 3. Create temp NAS with two identical JPEG files ──────────────────
    //
    // Using real JPEGs (copied from test-media/Photos/) ensures the media
    // scanner adds them to `media_files`, making the RECYCLED DB assertion
    // meaningful.  Two identical copies → same SHA-256 → one duplicate group.
    assert.ok(
      fs.existsSync(SOURCE_JPEG),
      `Source JPEG not found at ${SOURCE_JPEG}`,
    );

    const ts = Date.now();
    tempNasDir = path.join(TEMP_NAS_BASE, `run-${ts}`);
    const photosDir = path.join(tempNasDir, "Photos");
    fs.mkdirSync(photosDir, { recursive: true });

    fs.copyFileSync(SOURCE_JPEG, path.join(photosDir, "photo_original.jpg"));
    fs.copyFileSync(SOURCE_JPEG, path.join(photosDir, "photo_copy.jpg"));

    // ── 4. Point app to temp NAS ───────────────────────────────────────────
    const nasRes = await apiPut("/settings", { nasPath: tempNasDir });
    assert.ok(nasRes.ok, `Failed to set NAS path: ${await nasRes.text()}`);

    // ── 5. Trigger a FULL scan ─────────────────────────────────────────────
    const scanRes = await apiPost("/library/scan", { profile: "FULL" });
    const scanBody = await scanRes.text();
    assert.ok(
      scanRes.status === 202 || scanRes.status === 200,
      `Scan trigger returned ${scanRes.status}: ${scanBody}`,
    );
    const scanJob = JSON.parse(scanBody) as { jobId?: number };
    assert.ok(scanJob.jobId, "Canonical scan should return a job id");

    // ── 6. Wait for scan to complete ───────────────────────────────────────
    await pollUntil(
      async () =>
        (await (await apiGet(`/library/jobs/${scanJob.jobId}`)).json()) as {
          status: string;
        },
      (s) =>
        !["RUNNING", "PAUSED", "INTERRUPTED_BY_RESTART"].includes(s.status),
      { timeoutMs: 90_000, intervalMs: 2_000, description: "scan to finish" },
    );

    // ── 7. Find a duplicate group whose files are all in tempNasDir ────────
    //
    // The duplicates endpoint returns ALL groups from indexed_files, not just
    // the current NAS.  Filter to avoid stale cross-device-path entries that
    // would cause fs.renameSync to fail with EXDEV.
    const dupRes = await apiGet("/cleanup/duplicates?limit=100");
    assert.strictEqual(dupRes.status, 200);
    const dupData = (await dupRes.json()) as {
      groups: Array<{
        hash: string;
        files: Array<{ id: number; path: string; filename: string }>;
      }>;
    };

    // Filter to groups that have at least one file inside tempNasDir.
    // We do NOT require every file to be in tempNasDir because city.jpg may
    // already be indexed from previous scans (test-media NAS), which would
    // make the group contain files from both NAS roots.  We only need to find
    // a file in tempNasDir to delete — its rename stays on the same volume.
    const groupsWithTempFiles = dupData.groups.filter((g) =>
      g.files.some(
        (f) => typeof f.path === "string" && f.path.startsWith(tempNasDir),
      ),
    );

    assert.ok(
      groupsWithTempFiles.length > 0,
      `Expected >= 1 duplicate group with a file in ${tempNasDir}. Total groups: ${dupData.groups.length}. ` +
        "Check that the scan completed and the two identical JPEGs were indexed.",
    );

    const group = groupsWithTempFiles[0];

    // Select the file from tempNasDir as the delete target so the rename
    // stays within the temp volume (avoids EXDEV cross-device errors).
    const targetFile = group.files.find(
      (f) => typeof f.path === "string" && f.path.startsWith(tempNasDir),
    );
    assert.ok(
      targetFile !== undefined,
      "Expected at least one file inside tempNasDir in the group",
    );

    deleteFileId = targetFile.id;
    deletedFilePath = targetFile.path;
    assert.ok(deleteFileId > 0, "deleteFileId must be positive");
    assert.ok(
      fs.existsSync(deletedFilePath),
      `File to delete must exist on disk: ${deletedFilePath}`,
    );

    // ── 8. Seed a media_files row for the delete target ───────────────────
    //
    // Media enrichment may run async or skip files it already knows by hash,
    // so photo_copy.jpg might not appear in media_files on its own.  We insert
    // a controlled row (pre-seeded as 'VERIFIED') so the execute UPDATE is
    // exercised against a real row and can flip it to 'RECYCLED'.
    const relPath = deletedFilePath
      .slice(tempNasDir.length + 1) // strip leading "tempNasDir/"
      .replace(/\\/g, "/"); // normalise on Windows
    const fileName = path.basename(deletedFilePath);

    const escapedNasDir = tempNasDir.replace(/'/g, "''");
    const escapedRel = relPath.replace(/'/g, "''");
    const escapedName = fileName.replace(/'/g, "''");

    queryDb(
      `INSERT INTO media_files (nas_path, relative_path, name, size_bytes, last_scan_action) ` +
        `VALUES ('${escapedNasDir}', '${escapedRel}', '${escapedName}', 0, 'VERIFIED') ` +
        `ON CONFLICT DO NOTHING`,
    );
  });

  after(async () => {
    try {
      if (originalNasPath) {
        await apiPut("/settings", { nasPath: originalNasPath }).catch(() => {});
      }
      try {
        fs.rmSync(tempNasDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      try {
        if (
          fs.existsSync(TEMP_NAS_BASE) &&
          fs.readdirSync(TEMP_NAS_BASE).length === 0
        ) {
          fs.rmdirSync(TEMP_NAS_BASE);
        }
      } catch {
        /* ignore */
      }
    } catch {
      /* best effort cleanup */
    } finally {
      releaseLibraryTestLock?.();
      releaseLibraryTestLock = undefined;
    }
  });

  // ── Test 1: execute returns recycled=1 with no errors ────────────────────

  test("execute returns recycled=1 and an empty errors array", async () => {
    const res = await apiPost("/cleanup/execute", {
      deleteFileIds: [deleteFileId],
    });
    const { status, body } = await readJson<{
      recycled: number;
      recoveredBytes: number;
      errors: string[];
    }>(res);

    assert.strictEqual(status, 200, `Expected 200, got ${status}`);
    assert.strictEqual(
      body.recycled,
      1,
      `Expected recycled=1. Errors: ${JSON.stringify(body.errors)}`,
    );
    assert.deepEqual(
      body.errors,
      [],
      `Expected no errors, got: ${JSON.stringify(body.errors)}`,
    );
    assert.ok(
      body.recoveredBytes >= 0,
      "recoveredBytes should be non-negative",
    );
  });

  // ── Test 2: a rescan must not re-index the recycled file ───────────────────
  test("rescan does not bring the recycled file back into duplicate groups", async () => {
    const scanRes = await apiPost("/library/scan", { profile: "FULL" });
    const scanText = await scanRes.text();
    assert.ok(scanRes.status === 202 || scanRes.status === 200, scanText);
    const scanJob = JSON.parse(scanText) as { jobId?: number };
    assert.ok(scanJob.jobId, "Rescan should return a job id");

    const finished = await pollUntil(
      async () =>
        (await (await apiGet(`/library/jobs/${scanJob.jobId}`)).json()) as {
          status: string;
        },
      (job) =>
        !["RUNNING", "PAUSED", "INTERRUPTED_BY_RESTART"].includes(job.status),
      { timeoutMs: 90_000, intervalMs: 2_000, description: "rescan to finish" },
    );
    assert.ok(
      !["FAILED", "CANCELLED"].includes(finished.status),
      `Rescan failed: ${finished.status}`,
    );

    const dupRes = await apiGet("/cleanup/duplicates?limit=100");
    assert.strictEqual(dupRes.status, 200);
    const dupData = (await dupRes.json()) as {
      groups: Array<{ files: Array<{ path: string }> }>;
    };
    const recycledPath = deletedFilePath.replace(/\\/g, "/");
    assert.ok(
      !dupData.groups.some((group) =>
        group.files.some(
          (file) => file.path?.replace(/\\/g, "/") === recycledPath,
        ),
      ),
      `Recycled path was re-indexed into duplicate groups: ${recycledPath}`,
    );
  });

  // ── Test 3: file is physically in .Trash with collision-safe name ─────────

  test("file is moved to .Trash with fileId-prefixed basename (no collision)", () => {
    const trashRoot = path.join(tempNasDir, "WillardAI", ".Trash");

    assert.ok(fs.existsSync(trashRoot), `Expected .Trash at ${trashRoot}`);

    const trashSessionDirs = fs.readdirSync(trashRoot);
    assert.ok(
      trashSessionDirs.length > 0,
      "Expected at least one timestamped session dir in .Trash",
    );

    let found = false;
    for (const sessionDir of trashSessionDirs) {
      const sessionPath = path.join(trashRoot, sessionDir);
      if (!fs.statSync(sessionPath).isDirectory()) continue;
      if (
        fs
          .readdirSync(sessionPath)
          .some((e) => e.startsWith(`${deleteFileId}_`))
      ) {
        found = true;
        break;
      }
    }

    assert.ok(
      found,
      `Expected file with prefix "${deleteFileId}_" inside a .Trash session dir. ` +
        `Session dirs: ${JSON.stringify(fs.readdirSync(trashRoot))}`,
    );
  });

  // ── Test 4: history records the session ───────────────────────────────────

  test("GET /cleanup/history returns the session from the execute call", async () => {
    const res = await apiGet("/cleanup/history");
    const { status, body } = await readJson<{
      sessions: Array<{
        ts: string;
        recycled: number;
        platform: string;
        files: Array<{ path: string; sizeBytes: number }>;
        errors: string[];
      }>;
    }>(res);

    assert.strictEqual(status, 200);
    assert.ok(body.sessions.length > 0, "Expected at least 1 history session");

    const ourSession = body.sessions.find((s) =>
      s.recycled === 1 &&
      s.files.length === 1 &&
      s.errors.length === 0 &&
      s.files[0]?.path === "[REDACTED]",
    );

    assert.ok(
      ourSession !== undefined,
      `Expected a history session for a file in ${tempNasDir}`,
    );
    assert.strictEqual(
      ourSession.recycled,
      1,
      `Session recycled should be 1, got ${ourSession.recycled}`,
    );
    assert.strictEqual(
      ourSession.files[0]?.path,
      "[REDACTED]",
      "private cleanup history must not persist the source path",
    );
    assert.deepEqual(ourSession.errors, [], "Session should have no errors");
    assert.ok(
      !isNaN(new Date(ourSession.ts).getTime()),
      "Session ts must be a valid timestamp",
    );
    assert.strictEqual(
      ourSession.files.length,
      1,
      "Session should record exactly 1 file",
    );
  });

  // ── Test 4: media_files.last_scan_action = 'RECYCLED' (DB assertion) ──────

  test("media_files.last_scan_action is set to RECYCLED after execute", () => {
    // Escape the path for safe SQL embedding (single-quote escaping only)
    const escapedPath = deletedFilePath.replace(/'/g, "''");
    const query =
      `SELECT COALESCE(last_scan_action, 'NOT_SET') ` +
      `FROM media_files ` +
      `WHERE REPLACE(nas_path || '/' || relative_path, chr(92), '/') ` +
      `      = REPLACE('${escapedPath}', chr(92), '/') ` +
      `LIMIT 1`;

    let result: string;
    try {
      result = queryDb(query);
    } catch (err: any) {
      assert.fail(`psql query failed: ${err.message}`);
    }

    assert.ok(
      result.includes("RECYCLED"),
      `Expected media_files.last_scan_action = 'RECYCLED' for ${deletedFilePath}, ` +
        `got: "${result}". ` +
        "Check that the scanner indexed the JPEG into media_files before execute was called.",
    );
  });

  // ── Test 5: approved archive waits for organization ──────────────────────

  test("approved archive routes extracted files to Waiting to be Organized and keeps the archive", async () => {
    const archivePath = path.join(tempNasDir, "approved-archive.zip");
    const waitingDir = path.join(tempNasDir, "Waiting to be Organized");
    const files = [
      {
        entry: "photos/approved.jpg",
        content: Buffer.from("approved-photo-content"),
      },
      {
        entry: "notes/readme.txt",
        content: Buffer.from("approved-note-content"),
      },
    ];
    const archiveInputDir = path.join(tempNasDir, "approved-archive-input");
    for (const file of files) {
      const inputPath = path.join(archiveInputDir, file.entry);
      fs.mkdirSync(path.dirname(inputPath), { recursive: true });
      fs.writeFileSync(inputPath, file.content);
    }
    execFileSync("zip", ["-q", "-r", archivePath, "photos", "notes"], {
      cwd: archiveInputDir,
    });
    fs.rmSync(archiveInputDir, { recursive: true, force: true });

    const createRes = await apiPost("/organize/jobs", {
      sourceType: "archive",
      sourcePath: archivePath,
      archiveDisposition: "waiting",
    });
    const created = await readJson<{ id: number }>(createRes);
    assert.strictEqual(
      created.status,
      201,
      `Archive job creation failed: ${created.text}`,
    );

    const analyzeRes = await apiPost(
      `/organize/jobs/${created.body.id}/analyze`,
      {},
    );
    const analyzed = await readJson<{
      status: string;
      planJson?: {
        routes: Array<{ destination: string; filename: string }>;
        destinations: {
          images: string;
          videos: string;
          documents: string;
          other: string;
        };
      };
    }>(analyzeRes);
    assert.strictEqual(
      analyzed.status,
      200,
      `Archive analysis failed: ${analyzed.text}`,
    );
    assert.ok(analyzed.body.planJson, "Analysis should return the saved plan");

    const plan = analyzed.body.planJson!;
    const expectedWaiting = path.resolve(waitingDir);
    assert.deepEqual(
      plan.routes.map((route) => path.resolve(route.destination)),
      files.map(() => expectedWaiting),
      "every approved archive route must use Waiting to be Organized",
    );
    assert.deepEqual(
      Object.values(plan.destinations).map((destination) =>
        path.resolve(destination),
      ),
      [expectedWaiting, expectedWaiting, expectedWaiting, expectedWaiting],
      "all planned destination summaries must use Waiting to be Organized",
    );
    assert.ok(
      plan.routes.every(
        (route) => !route.destination.includes(path.join("Media", "Photos")),
      ),
      "approved archive contents must not route directly into media folders",
    );

    const preflightRes = await apiPost(
      `/organize/jobs/${created.body.id}/preflight`,
      {},
    );
    const preflight = await readJson<{ status: string }>(preflightRes);
    assert.strictEqual(
      preflight.status,
      200,
      `Archive preflight failed: ${preflight.text}`,
    );

    const executeRes = await apiOrganizeExecute(created.body.id);
    const executeText = await executeRes.text();
    assert.strictEqual(
      executeRes.status,
      200,
      "Archive execution should return an SSE stream",
    );
    assert.match(
      executeText,
      /event: complete/,
      `Archive execution did not complete: ${executeText}`,
    );
    assert.doesNotMatch(
      executeText,
      /event: error/,
      "Archive execution must not report an error",
    );

    for (const file of files) {
      const destination = path.join(waitingDir, path.basename(file.entry));
      assert.ok(
        fs.existsSync(destination),
        `Extracted file should arrive at ${destination}`,
      );
      assert.deepEqual(
        fs.readFileSync(destination),
        file.content,
        "Extracted bytes must be intact",
      );
    }
    assert.ok(
      fs.existsSync(archivePath),
      "The approved source archive must remain present",
    );
    assert.ok(
      !fs.existsSync(path.join(tempNasDir, "Media", "Photos", "approved.jpg")),
      "Approved archive content must not be placed in Media/Photos",
    );

    const jobRes = await apiGet(`/organize/jobs/${created.body.id}`);
    const job = (await jobRes.json()) as {
      status: string;
      reportJson?: {
        filesVerified: number;
        checksumVerifiedCount: number;
        archiveExtractionChecksums?: Array<{ verified: boolean }>;
      };
    };
    assert.strictEqual(job.status, "completed");
    assert.equal(job.reportJson?.filesVerified, files.length);
    assert.equal(job.reportJson?.checksumVerifiedCount, files.length);
    assert.equal(
      job.reportJson?.archiveExtractionChecksums?.filter(
        (checksum) => checksum.verified,
      ).length,
      files.length,
      "each extracted archive entry must pass integrity verification",
    );
  });

  // ── Test 6: TAR archives use the same waiting + integrity safeguards ──────

  test("approved TAR and compressed TAR archives wait safely with verified contents", async () => {
    const waitingDir = path.join(tempNasDir, "Waiting to be Organized");
    const variants = [
      { suffix: "tar", extension: "tar", createFlag: "-cf" },
      { suffix: "tgz", extension: "tgz", createFlag: "-czf" },
    ];

    for (const variant of variants) {
      const archivePath = path.join(
        tempNasDir,
        `approved-${variant.suffix}.${variant.extension}`,
      );
      const archiveInputDir = path.join(
        tempNasDir,
        `approved-${variant.suffix}-input`,
      );
      const files = [
        {
          entry: `photos/approved-${variant.suffix}.jpg`,
          content: Buffer.from(`${variant.suffix}-photo-content`),
        },
        {
          entry: `notes/readme-${variant.suffix}.txt`,
          content: Buffer.from(`${variant.suffix}-note-content`),
        },
      ];

      for (const file of files) {
        const inputPath = path.join(archiveInputDir, file.entry);
        fs.mkdirSync(path.dirname(inputPath), { recursive: true });
        fs.writeFileSync(inputPath, file.content);
      }
      execFileSync(
        "tar",
        [
          variant.createFlag,
          archivePath,
          "-C",
          archiveInputDir,
          "photos",
          "notes",
        ],
        { cwd: archiveInputDir },
      );
      fs.rmSync(archiveInputDir, { recursive: true, force: true });

      const createRes = await apiPost("/organize/jobs", {
        sourceType: "archive",
        sourcePath: archivePath,
        archiveDisposition: "waiting",
      });
      const created = await readJson<{ id: number }>(createRes);
      assert.strictEqual(
        created.status,
        201,
        `TAR job creation failed: ${created.text}`,
      );

      const analyzeRes = await apiPost(
        `/organize/jobs/${created.body.id}/analyze`,
        {},
      );
      const analyzed = await readJson<{
        status: string;
        planJson?: {
          routes: Array<{ destination: string }>;
          destinations: {
            images: string;
            videos: string;
            documents: string;
            other: string;
          };
        };
      }>(analyzeRes);
      assert.strictEqual(
        analyzed.status,
        200,
        `TAR analysis failed: ${analyzed.text}`,
      );
      assert.ok(
        analyzed.body.planJson,
        "TAR analysis should return the saved plan",
      );

      const plan = analyzed.body.planJson!;
      const expectedWaiting = path.resolve(waitingDir);
      assert.deepEqual(
        plan.routes.map((route) => path.resolve(route.destination)),
        files.map(() => expectedWaiting),
        `${variant.extension} routes must use Waiting to be Organized`,
      );
      assert.deepEqual(
        Object.values(plan.destinations).map((destination) =>
          path.resolve(destination),
        ),
        [expectedWaiting, expectedWaiting, expectedWaiting, expectedWaiting],
        `${variant.extension} destination summaries must use Waiting to be Organized`,
      );

      const preflightRes = await apiPost(
        `/organize/jobs/${created.body.id}/preflight`,
        {},
      );
      assert.strictEqual(
        preflightRes.status,
        200,
        `TAR preflight failed: ${await preflightRes.text()}`,
      );

      const executeRes = await apiOrganizeExecute(created.body.id);
      const executeText = await executeRes.text();
      assert.strictEqual(executeRes.status, 200);
      assert.match(
        executeText,
        /event: complete/,
        `${variant.extension} execution did not complete`,
      );
      assert.doesNotMatch(
        executeText,
        /event: error/,
        `${variant.extension} execution must not report an error`,
      );

      for (const file of files) {
        const destination = path.join(waitingDir, path.basename(file.entry));
        assert.ok(
          fs.existsSync(destination),
          `Extracted ${variant.extension} file should arrive at ${destination}`,
        );
        assert.deepEqual(
          fs.readFileSync(destination),
          file.content,
          "TAR extracted bytes must be intact",
        );
      }
      assert.ok(
        fs.existsSync(archivePath),
        `${variant.extension} source archive must remain present`,
      );

      const jobRes = await apiGet(`/organize/jobs/${created.body.id}`);
      const job = (await jobRes.json()) as {
        status: string;
        reportJson?: {
          filesVerified: number;
          checksumVerifiedCount: number;
          archiveExtractionChecksums?: Array<{
            verified: boolean;
            verificationMethod: string;
          }>;
          archiveCrcValidation?: { format: string };
        };
      };
      assert.strictEqual(job.status, "completed");
      assert.equal(job.reportJson?.filesVerified, files.length);
      assert.equal(job.reportJson?.checksumVerifiedCount, files.length);
      assert.equal(
        job.reportJson?.archiveExtractionChecksums?.filter(
          (checksum) => checksum.verified,
        ).length,
        files.length,
        "each TAR entry must have a post-extraction checksum",
      );
      assert.ok(
        job.reportJson?.archiveExtractionChecksums?.every(
          (checksum) => checksum.verificationMethod === "post-extract-only",
        ),
        "TAR checksums must identify their post-extraction verification method",
      );
      assert.match(
        job.reportJson?.archiveCrcValidation?.format ?? "",
        /tar-sha256-post-extract/,
      );
    }
  });

  // ── Test 7: TAR traversal protection rejects before extraction ────────────

  test("TAR traversal is rejected before extraction and the source remains intact", async () => {
    const archivePath = path.join(tempNasDir, "malicious-archive.tar");
    const archiveInputDir = path.join(tempNasDir, "malicious-archive-input");
    const outsidePath = path.join(tempNasDir, "tar-escape.txt");
    const waitingDir = path.join(tempNasDir, "Waiting to be Organized");
    const waitingEntriesBefore = new Set(fs.readdirSync(waitingDir));
    fs.mkdirSync(archiveInputDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveInputDir, "escape.txt"),
      "must not escape staging",
    );
    execFileSync(
      "tar",
      [
        "-cf",
        archivePath,
        "-C",
        archiveInputDir,
        "--transform=s|^|../|",
        "escape.txt",
      ],
      { cwd: archiveInputDir },
    );
    fs.rmSync(archiveInputDir, { recursive: true, force: true });
    fs.rmSync(outsidePath, { force: true });

    const createRes = await apiPost("/organize/jobs", {
      sourceType: "archive",
      sourcePath: archivePath,
      archiveDisposition: "waiting",
    });
    const created = await readJson<{ id: number }>(createRes);
    assert.strictEqual(
      created.status,
      201,
      `TAR traversal job creation failed: ${created.text}`,
    );

    const analyzeRes = await apiPost(
      `/organize/jobs/${created.body.id}/analyze`,
      {},
    );
    assert.strictEqual(
      analyzeRes.status,
      200,
      `TAR traversal analysis failed: ${await analyzeRes.text()}`,
    );
    const preflightRes = await apiPost(
      `/organize/jobs/${created.body.id}/preflight`,
      {},
    );
    assert.strictEqual(
      preflightRes.status,
      200,
      `TAR traversal preflight failed: ${await preflightRes.text()}`,
    );

    const executeRes = await apiOrganizeExecute(created.body.id);
    const executeText = await executeRes.text();
    assert.strictEqual(executeRes.status, 200);
    assert.match(
      executeText,
      /event: error/,
      "TAR traversal must fail during safe extraction",
    );
    assert.match(executeText, /traversal rejected/i);
    assert.ok(
      fs.existsSync(archivePath),
      "A rejected TAR archive must remain present",
    );
    assert.ok(
      !fs.existsSync(outsidePath),
      "TAR traversal must not write outside the staging area",
    );
    const waitingEntriesAfter = fs.readdirSync(waitingDir);
    assert.deepEqual(
      waitingEntriesAfter.filter((entry) => !waitingEntriesBefore.has(entry)),
      [],
      "TAR traversal must not partially move files",
    );
  });

  // ── Test 8: extraction failure rolls back without consuming source ────────

  test("TAR extraction failure after approval leaves no partial moves and preserves source", async () => {
    const archivePath = path.join(tempNasDir, "truncated-archive.tgz");
    const archiveInputDir = path.join(tempNasDir, "truncated-archive-input");
    const destination = path.join(
      tempNasDir,
      "Waiting to be Organized",
      "truncated.jpg",
    );
    fs.mkdirSync(path.join(archiveInputDir, "photos"), { recursive: true });
    fs.writeFileSync(
      path.join(archiveInputDir, "photos", "truncated.jpg"),
      "must not be partially moved",
    );
    execFileSync("tar", ["-czf", archivePath, "-C", archiveInputDir, "photos"]);
    fs.rmSync(archiveInputDir, { recursive: true, force: true });

    const createRes = await apiPost("/organize/jobs", {
      sourceType: "archive",
      sourcePath: archivePath,
      archiveDisposition: "waiting",
    });
    const created = await readJson<{ id: number }>(createRes);
    assert.strictEqual(
      created.status,
      201,
      `Truncated TAR job creation failed: ${created.text}`,
    );
    assert.strictEqual(
      (await apiPost(`/organize/jobs/${created.body.id}/analyze`, {})).status,
      200,
    );
    assert.strictEqual(
      (await apiPost(`/organize/jobs/${created.body.id}/preflight`, {})).status,
      200,
    );

    const originalSize = fs.statSync(archivePath).size;
    fs.truncateSync(archivePath, Math.max(1, Math.floor(originalSize / 2)));
    const executeRes = await apiOrganizeExecute(created.body.id);
    const executeText = await executeRes.text();
    assert.strictEqual(executeRes.status, 200);
    assert.match(
      executeText,
      /event: error/,
      "A truncated TAR must fail extraction",
    );
    assert.doesNotMatch(
      executeText,
      /event: complete/,
      "A failed TAR extraction must not complete",
    );
    assert.ok(
      fs.existsSync(archivePath),
      "A failed TAR extraction must preserve the source archive",
    );
    assert.ok(
      !fs.existsSync(destination),
      "A failed TAR extraction must not move partial files",
    );
  });

  // ── Test 9: traversal protection still applies ───────────────────────────

  test("archive traversal is rejected before extraction and the source remains intact", async () => {
    const archivePath = path.join(tempNasDir, "malicious-archive.zip");
    const escapedPath = path.join(tempNasDir, "escape.txt");
    const archiveInputDir = path.join(tempNasDir, "malicious-archive-input");
    fs.mkdirSync(archiveInputDir, { recursive: true });
    fs.writeFileSync(
      path.join(tempNasDir, "escape-source.txt"),
      "must not escape staging",
    );
    execFileSync("zip", ["-q", archivePath, "../escape-source.txt"], {
      cwd: archiveInputDir,
    });
    fs.rmSync(archiveInputDir, { recursive: true, force: true });
    fs.rmSync(path.join(tempNasDir, "escape-source.txt"), { force: true });
    assert.ok(!fs.existsSync(escapedPath));

    const createRes = await apiPost("/organize/jobs", {
      sourceType: "archive",
      sourcePath: archivePath,
      archiveDisposition: "waiting",
    });
    const created = await readJson<{ id: number }>(createRes);
    assert.strictEqual(
      created.status,
      201,
      `Traversal job creation failed: ${created.text}`,
    );

    const analyzeRes = await apiPost(
      `/organize/jobs/${created.body.id}/analyze`,
      {},
    );
    assert.strictEqual(
      analyzeRes.status,
      200,
      `Traversal analysis failed: ${await analyzeRes.text()}`,
    );
    const preflightRes = await apiPost(
      `/organize/jobs/${created.body.id}/preflight`,
      {},
    );
    assert.strictEqual(
      preflightRes.status,
      200,
      `Traversal preflight failed: ${await preflightRes.text()}`,
    );

    const executeRes = await apiOrganizeExecute(created.body.id);
    const executeText = await executeRes.text();
    assert.strictEqual(executeRes.status, 200);
    assert.match(
      executeText,
      /event: error/,
      "Traversal must fail during safe extraction",
    );
    assert.match(executeText, /traversal rejected/i);
    assert.ok(
      fs.existsSync(archivePath),
      "A rejected archive must remain present",
    );
    assert.ok(
      !fs.existsSync(escapedPath),
      "Traversal must not write outside the staging area",
    );
  });

  // ── Test 10: missing NAS returns a retryable conflict ─────────────────────

  test("execute with an empty NAS path returns 409 without consuming the queue", async () => {
    const clearNas = await apiPut("/settings", { nasPath: "" });
    assert.strictEqual(clearNas.status, 200);
    try {
      const res = await apiPost("/cleanup/execute", {
        deleteFileIds: [deleteFileId],
      });
      const { status, body } = await readJson<{ error?: string }>(res);
      assert.strictEqual(status, 409);
      assert.match(body.error ?? "", /No library configured/i);
    } finally {
      const restoreNas = await apiPut("/settings", { nasPath: tempNasDir });
      assert.strictEqual(restoreNas.status, 200);
    }
  });

  // ── Test 11: execute with unknown ID returns graceful error ───────────────

  test("execute with a non-existent file ID returns error entry and recycled=0", async () => {
    const res = await apiPost("/cleanup/execute", {
      deleteFileIds: [999_999_999],
    });
    const { status, body } = await readJson<{
      recycled: number;
      errors: string[];
    }>(res);

    assert.strictEqual(status, 200);
    assert.strictEqual(body.recycled, 0);
    assert.ok(
      body.errors.length > 0,
      "errors array should have an entry for the unknown ID",
    );
  });

  // ── Test 12: execute with empty array returns 400 ─────────────────────────

  test("execute with an empty deleteFileIds array returns 400", async () => {
    const res = await apiPost("/cleanup/execute", { deleteFileIds: [] });
    assert.strictEqual(
      res.status,
      400,
      "Empty deleteFileIds should return 400",
    );
  });

  // ── Test 13: second execute on already-moved file reports missing-on-disk ─

  test("executing the same file ID again reports file-not-found error", async () => {
    const res = await apiPost("/cleanup/execute", {
      deleteFileIds: [deleteFileId],
    });
    const { status, body } = await readJson<{
      recycled: number;
      errors: string[];
    }>(res);

    assert.strictEqual(status, 200);
    assert.strictEqual(
      body.recycled,
      0,
      "recycled should be 0 for already-moved file",
    );
    assert.ok(
      body.errors.length > 0,
      "Should report an error for the already-moved file",
    );
  });
});
