/**
 * E2E integration test: Cleanup execute endpoint moves files and records history.
 *
 * Covers the three "done looks like" criteria from Task #182:
 *   1. POST /cleanup/execute with a real file ID moves the file to
 *      WillardAI/.Trash and returns recycled=1 with no errors.
 *   2. GET /cleanup/history returns the session recorded during execute.
 *   3. The file is physically present in .Trash with the fileId-prefixed
 *      name that prevents basename collisions.
 *
 * Setup strategy
 * ──────────────
 *   • Creates a private temp NAS directory under the workspace root (same
 *     filesystem as the app's working directory) to avoid cross-device rename
 *     failures (EXDEV) that occur when /tmp and the workspace are on separate
 *     btrfs volumes.
 *   • Writes two text files with identical content so the scanner indexes
 *     them as a duplicate group.
 *   • Temporarily points the app's NAS path to the temp dir, runs a FULL
 *     scan, then exercises the cleanup flow.
 *   • After filtering duplicate groups to only those inside the temp NAS dir,
 *     executes cleanup and verifies the .Trash move and history recording.
 *   • Restores the original NAS path and removes the temp dir in `after()`.
 *
 * Run with:
 *   node --experimental-strip-types --test e2e/cleanup-execute.test.ts
 */

import { describe, test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Configuration ─────────────────────────────────────────────────────────

const REPLIT_BASE = process.env["REPLIT_DEV_DOMAIN"]
  ? `https://${process.env["REPLIT_DEV_DOMAIN"]}`
  : undefined;

const API_BASE =
  process.env["WILLARD_API_URL"] ?? REPLIT_BASE ?? "http://localhost:8080";

const TEST_PASSWORD = "willard123";

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
  { timeoutMs = 60_000, intervalMs = 2_000, description = "condition" } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await getter();
    if (condition(v)) return v;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

// ─── State shared across tests ──────────────────────────────────────────────

/** Temp NAS dir lives under the workspace so it shares the filesystem with the app. */
const TEMP_NAS_BASE = path.join(process.cwd(), ".tmp-cleanup-test");

let tempNasDir = "";
let originalNasPath = "";
let deleteFileId = -1;

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

    // ── 3. Create temp NAS with duplicate files (same filesystem as app) ──
    //
    // Use a subdirectory of process.cwd() (workspace root), NOT /tmp, so that
    // `fs.renameSync` stays on the same btrfs volume as the API server process.
    // A cross-device rename (EXDEV) would silently drop the recycled count to 0.
    const ts = Date.now();
    tempNasDir = path.join(TEMP_NAS_BASE, `run-${ts}`);
    const photosDir = path.join(tempNasDir, "Photos");
    fs.mkdirSync(photosDir, { recursive: true });

    // Identical content → same SHA-256 hash → one duplicate group
    const CONTENT = Buffer.from("willard-cleanup-e2e-test-identical-content-for-dup-detection");
    fs.writeFileSync(path.join(photosDir, "dup_original.txt"), CONTENT);
    fs.writeFileSync(path.join(photosDir, "dup_copy.txt"), CONTENT);

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

    // ── 7. Find a duplicate group from the temp NAS (not from other runs) ─
    //
    // The duplicates endpoint returns ALL groups from indexed_files.  We must
    // filter to groups whose files live inside tempNasDir to avoid picking up
    // files from other indexed NAS directories — those are on a different
    // btrfs volume and would cause an EXDEV error during `fs.renameSync`.
    const dupRes = await apiGet("/cleanup/duplicates?limit=100");
    assert.strictEqual(dupRes.status, 200, `GET /cleanup/duplicates returned ${dupRes.status}`);
    const dupData = (await dupRes.json()) as {
      groups: Array<{
        hash: string;
        files: Array<{ id: number; path: string; filename: string }>;
      }>;
    };

    // Filter to groups where ALL files are inside tempNasDir
    const tempGroups = dupData.groups.filter((g) =>
      g.files.every((f) => typeof f.path === "string" && f.path.startsWith(tempNasDir)),
    );

    assert.ok(
      tempGroups.length > 0,
      `Expected at least 1 duplicate group in the temp NAS (${tempNasDir}). ` +
      `Total groups found: ${dupData.groups.length}. ` +
      "Check that the scan completed and indexed the two identical test files.",
    );

    const group = tempGroups[0];
    assert.ok(group.files.length >= 2, `Expected >= 2 files in group, got ${group.files.length}`);

    // Keep the first, delete the second
    deleteFileId = group.files[1].id;
    assert.ok(deleteFileId > 0, "deleteFileId must be a positive integer");
  });

  after(async () => {
    // Restore original NAS path (best-effort)
    if (originalNasPath) {
      await apiPut("/settings", { nasPath: originalNasPath }).catch(() => {});
    }
    // Remove the entire temp NAS dir (includes .Trash)
    try { fs.rmSync(tempNasDir, { recursive: true, force: true }); } catch { /* ignore */ }
    // Clean up base dir if empty
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
    assert.strictEqual(body.recycled, 1, `Expected recycled=1, got ${body.recycled}. Errors: ${JSON.stringify(body.errors)}`);
    assert.deepEqual(body.errors, [], `Expected no errors, got: ${JSON.stringify(body.errors)}`);
    assert.ok(body.recoveredBytes >= 0, "recoveredBytes should be non-negative");
  });

  // ── Test 2: file is physically in .Trash with collision-safe name ─────────

  test("file is moved to .Trash with fileId-prefixed basename (no collision)", () => {
    const trashRoot = path.join(tempNasDir, "WillardAI", ".Trash");

    assert.ok(
      fs.existsSync(trashRoot),
      `Expected .Trash directory to exist at ${trashRoot}`,
    );

    const trashSessionDirs = fs.readdirSync(trashRoot);
    assert.ok(trashSessionDirs.length > 0, "Expected at least one timestamped session dir inside .Trash");

    let found = false;
    for (const sessionDir of trashSessionDirs) {
      const sessionPath = path.join(trashRoot, sessionDir);
      if (!fs.statSync(sessionPath).isDirectory()) continue;
      const entries = fs.readdirSync(sessionPath);
      // File must be named "${deleteFileId}_<filename>" to prevent collision
      if (entries.some((e) => e.startsWith(`${deleteFileId}_`))) {
        found = true;
        break;
      }
    }

    assert.ok(
      found,
      `Expected file with prefix "${deleteFileId}_" inside a .Trash session dir. ` +
      `Session dirs found: ${JSON.stringify(trashSessionDirs)}`,
    );
  });

  // ── Test 3: history records the session ───────────────────────────────────

  test("GET /cleanup/history returns the session from the execute call", async () => {
    const res = await apiGet("/cleanup/history");
    const { status, body } = await readJson<{
      sessions: Array<{
        ts: string;
        recycled: number;
        recoveredBytes: number;
        platform: string;
        files: Array<{ path: string; sizeBytes: number }>;
        errors: string[];
      }>;
    }>(res);

    assert.strictEqual(status, 200, `Expected 200 from /cleanup/history, got ${status}`);
    assert.ok(body.sessions.length > 0, "Expected at least 1 session in cleanup history");

    // Find the session that deleted our temp file (most recent first)
    const ourSession = body.sessions.find(
      (s) => s.files.some((f) => f.path.startsWith(tempNasDir)),
    );

    assert.ok(
      ourSession !== undefined,
      `Expected a history session referencing a file in ${tempNasDir}. ` +
      `Sessions: ${JSON.stringify(body.sessions.map((s) => ({ recycled: s.recycled, files: s.files.map((f) => f.path) })))}`,
    );

    assert.strictEqual(ourSession.recycled, 1, `Session should have recycled=1, got ${ourSession.recycled}`);
    assert.deepEqual(ourSession.errors, [], "Session should have no errors");
    assert.ok(typeof ourSession.ts === "string" && ourSession.ts.length > 0, "Session must have a timestamp");
    assert.ok(typeof ourSession.platform === "string" && ourSession.platform.length > 0, "Session must record the platform");
    assert.strictEqual(ourSession.files.length, 1, "Session should record exactly 1 deleted file");
  });

  // ── Test 4: execute with unknown ID returns graceful error ────────────────

  test("execute with a non-existent file ID returns error entry and recycled=0", async () => {
    const res = await apiPost("/cleanup/execute", { deleteFileIds: [999_999_999] });
    const { status, body } = await readJson<{ recycled: number; errors: string[] }>(res);

    assert.strictEqual(status, 200, "Should return 200 even for unknown IDs");
    assert.strictEqual(body.recycled, 0, "recycled should be 0 for an unknown ID");
    assert.ok(body.errors.length > 0, "errors array should have an entry for the unknown ID");
  });

  // ── Test 5: execute with empty array returns 400 ──────────────────────────

  test("execute with an empty deleteFileIds array returns 400", async () => {
    const res = await apiPost("/cleanup/execute", { deleteFileIds: [] });
    assert.strictEqual(res.status, 400, "Empty deleteFileIds should return 400");
  });

  // ── Test 6: second execute on already-moved file reports file-not-found ───

  test("executing the same file ID again reports file-not-found error", async () => {
    const res = await apiPost("/cleanup/execute", { deleteFileIds: [deleteFileId] });
    const { status, body } = await readJson<{ recycled: number; errors: string[] }>(res);

    assert.strictEqual(status, 200, "Second execute should still return 200");
    assert.strictEqual(body.recycled, 0, "recycled should be 0 for already-moved file");
    assert.ok(body.errors.length > 0, "Should report an error for the already-moved file");
  });
});
