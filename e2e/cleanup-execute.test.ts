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
 *   node --experimental-strip-types --test e2e/cleanup-execute.test.ts
 */

import { describe, test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

// ─── Configuration ─────────────────────────────────────────────────────────

const REPLIT_BASE = process.env["REPLIT_DEV_DOMAIN"]
  ? `https://${process.env["REPLIT_DEV_DOMAIN"]}`
  : undefined;

const API_BASE =
  process.env["WILLARD_API_URL"] ?? REPLIT_BASE ?? "http://localhost:8080";

const TEST_PASSWORD = "willard123";

/** Path to a real JPEG that we copy twice to create identical duplicate files. */
const SOURCE_JPEG = path.join(process.cwd(), "test-media", "Photos", "city.jpg");

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

async function apiPost(p: string, body: Record<string, unknown>): Promise<Response> {
  const res = await fetch(`${API_BASE}/api${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  captureSessionCookie(res);
  return res;
}

async function apiPut(p: string, body: Record<string, unknown>): Promise<Response> {
  const res = await fetch(`${API_BASE}/api${p}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  captureSessionCookie(res);
  return res;
}

/** Read the full response body once and return both status and parsed JSON. */
async function readJson<T>(res: Response): Promise<{ status: number; body: T; text: string }> {
  const text = await res.text();
  let body: T;
  try { body = JSON.parse(text) as T; } catch { body = text as unknown as T; }
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
  return execSync(`psql "${dbUrl}" --no-psqlrc -t -c ${JSON.stringify(sql)}`, {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  }).trim();
}

// ─── State shared across tests ──────────────────────────────────────────────

/** Temp NAS dir lives under the workspace so it shares the btrfs volume with the app. */
const TEMP_NAS_BASE = path.join(process.cwd(), ".tmp-cleanup-test");

let tempNasDir = "";
let originalNasPath = "";
let deleteFileId = -1;
let deletedFilePath = "";

// ─── Suite ──────────────────────────────────────────────────────────────────

describe("Cleanup execute API", { concurrency: false }, () => {
  before(async () => {
    // ── 1. Authenticate ────────────────────────────────────────────────────
    const statusRes = await fetch(`${API_BASE}/api/auth/status`);
    assert.strictEqual(statusRes.status, 200, "Auth status should be 200");
    const status = (await statusRes.json()) as { setup: boolean; authenticated: boolean };

    if (status.setup) {
      const r = await apiPost("/auth/setup", { password: TEST_PASSWORD });
      assert.ok(r.ok, `Auth setup failed: ${await r.text()}`);
    } else {
      const r = await apiPost("/auth/login", { password: TEST_PASSWORD });
      assert.ok(r.ok, `Login failed (password must be "${TEST_PASSWORD}"): ${await r.text()}`);
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
    assert.ok(fs.existsSync(SOURCE_JPEG), `Source JPEG not found at ${SOURCE_JPEG}`);

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
    const scanRes = await apiPost("/scan", {});
    assert.ok(
      scanRes.status === 202 || scanRes.status === 200,
      `Scan trigger returned ${scanRes.status}: ${await scanRes.text()}`,
    );

    // ── 6. Wait for scan to complete ───────────────────────────────────────
    await pollUntil(
      async () => (await (await apiGet("/scan/status")).json()) as { isRunning: boolean },
      (s) => !s.isRunning,
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
      groups: Array<{ hash: string; files: Array<{ id: number; path: string; filename: string }> }>;
    };

    // Filter to groups that have at least one file inside tempNasDir.
    // We do NOT require every file to be in tempNasDir because city.jpg may
    // already be indexed from previous scans (test-media NAS), which would
    // make the group contain files from both NAS roots.  We only need to find
    // a file in tempNasDir to delete — its rename stays on the same volume.
    const groupsWithTempFiles = dupData.groups.filter((g) =>
      g.files.some((f) => typeof f.path === "string" && f.path.startsWith(tempNasDir)),
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
    assert.ok(targetFile !== undefined, "Expected at least one file inside tempNasDir in the group");

    deleteFileId   = targetFile.id;
    deletedFilePath = targetFile.path;
    assert.ok(deleteFileId > 0,               "deleteFileId must be positive");
    assert.ok(fs.existsSync(deletedFilePath), `File to delete must exist on disk: ${deletedFilePath}`);

    // ── 8. Seed a media_files row for the delete target ───────────────────
    //
    // Media enrichment may run async or skip files it already knows by hash,
    // so photo_copy.jpg might not appear in media_files on its own.  We insert
    // a controlled row (pre-seeded as 'VERIFIED') so the execute UPDATE is
    // exercised against a real row and can flip it to 'RECYCLED'.
    const relPath = deletedFilePath
      .slice(tempNasDir.length + 1)   // strip leading "tempNasDir/"
      .replace(/\\/g, "/");           // normalise on Windows
    const fileName = path.basename(deletedFilePath);

    const escapedNasDir = tempNasDir.replace(/'/g, "''");
    const escapedRel    = relPath.replace(/'/g, "''");
    const escapedName   = fileName.replace(/'/g, "''");

    queryDb(
      `INSERT INTO media_files (nas_path, relative_path, name, size_bytes, last_scan_action) ` +
      `VALUES ('${escapedNasDir}', '${escapedRel}', '${escapedName}', 0, 'VERIFIED') ` +
      `ON CONFLICT DO NOTHING`,
    );
  });

  after(async () => {
    if (originalNasPath) {
      await apiPut("/settings", { nasPath: originalNasPath }).catch(() => {});
    }
    try { fs.rmSync(tempNasDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try {
      if (fs.existsSync(TEMP_NAS_BASE) && fs.readdirSync(TEMP_NAS_BASE).length === 0) {
        fs.rmdirSync(TEMP_NAS_BASE);
      }
    } catch { /* ignore */ }
  });

  // ── Test 1: execute returns recycled=1 with no errors ────────────────────

  test("execute returns recycled=1 and an empty errors array", async () => {
    const res = await apiPost("/cleanup/execute", { deleteFileIds: [deleteFileId] });
    const { status, body } = await readJson<{
      recycled: number;
      recoveredBytes: number;
      errors: string[];
    }>(res);

    assert.strictEqual(status, 200, `Expected 200, got ${status}`);
    assert.strictEqual(body.recycled, 1, `Expected recycled=1. Errors: ${JSON.stringify(body.errors)}`);
    assert.deepEqual(body.errors, [], `Expected no errors, got: ${JSON.stringify(body.errors)}`);
    assert.ok(body.recoveredBytes >= 0, "recoveredBytes should be non-negative");
  });

  // ── Test 2: file is physically in .Trash with collision-safe name ─────────

  test("file is moved to .Trash with fileId-prefixed basename (no collision)", () => {
    const trashRoot = path.join(tempNasDir, "WillardAI", ".Trash");

    assert.ok(fs.existsSync(trashRoot), `Expected .Trash at ${trashRoot}`);

    const trashSessionDirs = fs.readdirSync(trashRoot);
    assert.ok(trashSessionDirs.length > 0, "Expected at least one timestamped session dir in .Trash");

    let found = false;
    for (const sessionDir of trashSessionDirs) {
      const sessionPath = path.join(trashRoot, sessionDir);
      if (!fs.statSync(sessionPath).isDirectory()) continue;
      if (fs.readdirSync(sessionPath).some((e) => e.startsWith(`${deleteFileId}_`))) {
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

  // ── Test 3: history records the session ───────────────────────────────────

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
      s.files.some((f) => f.path.startsWith(tempNasDir)),
    );

    assert.ok(
      ourSession !== undefined,
      `Expected a history session for a file in ${tempNasDir}`,
    );
    assert.strictEqual(ourSession.recycled, 1, `Session recycled should be 1, got ${ourSession.recycled}`);
    assert.deepEqual(ourSession.errors, [], "Session should have no errors");
    assert.ok(!isNaN(new Date(ourSession.ts).getTime()), "Session ts must be a valid timestamp");
    assert.strictEqual(ourSession.files.length, 1, "Session should record exactly 1 file");
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

  // ── Test 5: execute with unknown ID returns graceful error ────────────────

  test("execute with a non-existent file ID returns error entry and recycled=0", async () => {
    const res = await apiPost("/cleanup/execute", { deleteFileIds: [999_999_999] });
    const { status, body } = await readJson<{ recycled: number; errors: string[] }>(res);

    assert.strictEqual(status, 200);
    assert.strictEqual(body.recycled, 0);
    assert.ok(body.errors.length > 0, "errors array should have an entry for the unknown ID");
  });

  // ── Test 6: execute with empty array returns 400 ──────────────────────────

  test("execute with an empty deleteFileIds array returns 400", async () => {
    const res = await apiPost("/cleanup/execute", { deleteFileIds: [] });
    assert.strictEqual(res.status, 400, "Empty deleteFileIds should return 400");
  });

  // ── Test 7: second execute on already-moved file reports missing-on-disk ──

  test("executing the same file ID again reports file-not-found error", async () => {
    const res = await apiPost("/cleanup/execute", { deleteFileIds: [deleteFileId] });
    const { status, body } = await readJson<{ recycled: number; errors: string[] }>(res);

    assert.strictEqual(status, 200);
    assert.strictEqual(body.recycled, 0, "recycled should be 0 for already-moved file");
    assert.ok(body.errors.length > 0, "Should report an error for the already-moved file");
  });
});
