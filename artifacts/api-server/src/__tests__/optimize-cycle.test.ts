/**
 * Full optimize-cycle integration coverage.
 *
 * The test uses a temporary library and the real API server:
 * scan -> approve PNG -> execute -> verify staged output -> recycle originals.
 * A tiny PNG intentionally exercises the "output is not smaller" skip guard.
 */
import { describe, test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { db, pool, appSettingsTable, conversionJobsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const API_BASE = process.env["WILLARD_API_URL"]
  ?? (process.env["REPLIT_DEV_DOMAIN"] ? `https://${process.env["REPLIT_DEV_DOMAIN"]}` : "http://localhost:8080");
const PASSWORD = "willard123";

let cookie = "";
let root = "";
let jobId = 0;
let originalSettings: { id: number; nasPath: string; optimizeProfile: string; rawConversionEnabled: boolean } | undefined;

async function request(route: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("Cookie", cookie);
  const response = await fetch(`${API_BASE}/api${route}`, { ...init, headers });
  const setCookie = response.headers.get("set-cookie")?.match(/willard\.sid=[^;]+/);
  if (setCookie) cookie = setCookie[0];
  return response;
}

function pngBuffer(width: number, height: number): Buffer {
  // Sharp is used by the application for the conversion itself. Keeping fixture
  // creation in the test avoids checked-in binary assets.
  return Buffer.from(crypto.randomBytes(width * height * 3));
}

async function createPng(filePath: string, width: number, height: number): Promise<void> {
  const sharp = (await import("sharp")).default;
  await sharp(pngBuffer(width, height), {
    raw: { width, height, channels: 3 },
  }).png({ compressionLevel: 0 }).toFile(filePath);
}

function createAvi(filePath: string): void {
  const result = spawnSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=12",
    "-t", "2", "-c:v", "mpeg4", "-q:v", "3", filePath,
  ], { encoding: "utf8", stdio: "pipe", timeout: 120_000 });
  assert.equal(result.status, 0, `Could not create video fixture: ${result.stderr ?? ""}`);
}

describe("optimize scan and conversion cycle", { concurrency: false }, () => {
  before(async () => {
    const [settings] = await db.select({
      id: appSettingsTable.id,
      nasPath: appSettingsTable.nasPath,
      optimizeProfile: appSettingsTable.optimizeProfile,
      rawConversionEnabled: appSettingsTable.rawConversionEnabled,
    }).from(appSettingsTable).limit(1);
    assert.ok(settings?.nasPath, "A configured library is required");
    originalSettings = settings;

    root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-optimize-cycle-"));
    fs.mkdirSync(path.join(root, "WillardAI"), { recursive: true });
    await createPng(path.join(root, "large.png"), 900, 700);
    await createPng(path.join(root, "tiny.png"), 1, 1);
    createAvi(path.join(root, "sample.avi"));

    await db.update(appSettingsTable)
      .set({ nasPath: root, optimizeProfile: "BALANCED", rawConversionEnabled: false })
      .where(eq(appSettingsTable.id, settings.id));

    const login = await request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(login.status, 200, await login.text());
  });

  after(async () => {
    if (jobId) await db.delete(conversionJobsTable).where(eq(conversionJobsTable.id, jobId));
    if (originalSettings) {
      await db.update(appSettingsTable)
        .set({
          nasPath: originalSettings.nasPath,
          optimizeProfile: originalSettings.optimizeProfile,
          rawConversionEnabled: originalSettings.rawConversionEnabled,
        })
        .where(eq(appSettingsTable.id, originalSettings.id));
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    await pool.end();
  });

  test("scans PNGs and reports the expected convertible group", async () => {
    const response = await request("/optimize/scan?force=true");
    const body = await response.json() as {
      groups: Array<{ extension: string; fileCount: number; status: string }>;
    };
    assert.equal(response.status, 200, JSON.stringify(body));
    const png = body.groups.find((group) => group.extension === "png");
    assert.equal(png?.extension, "png");
    assert.equal(png?.fileCount, 2);
    assert.equal(png?.status, "convert");
    const avi = body.groups.find((group) => group.extension === "avi");
    assert.equal(avi?.fileCount, 1);
    assert.equal(avi?.status, "convert");
  });

  test("converts, skips size regression, recycles original, and cleans staging", async () => {
    const run = await request("/optimize/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvedExts: ["png", "avi"] }),
    });
    const created = await run.json() as { id: number };
    assert.equal(run.status, 201);
    jobId = created.id;

    const missingToken = await request(`/optimize/jobs/${jobId}/execute`);
    assert.equal(missingToken.status, 403);
    await missingToken.text();

    const tokenResponse = await request(`/optimize/jobs/${jobId}/execute-token`, { method: "POST" });
    const tokenBody = await tokenResponse.json() as { token?: string; error?: string };
    assert.equal(tokenResponse.status, 200, tokenBody.error ?? "Execution token request failed");
    assert.ok(tokenBody.token, "Execution token should be returned");

    const authorizedUrl = `/optimize/jobs/${jobId}/execute?token=${encodeURIComponent(tokenBody.token)}`;
    const stream = await request(authorizedUrl);
    const sse = await stream.text();
    assert.equal(stream.status, 200, sse);
    assert.match(sse, /event: summary/);
    assert.match(sse, /"succeeded":2/);
    assert.match(sse, /"skipped":1/);
    assert.match(sse, /"stage":"awaiting_action"/);

    const jobBeforeAction = await (await request(`/optimize/jobs/${jobId}`)).json() as {
      status: string;
      resultJson: {
        stagingDir: string;
        files: Array<{ filePath: string; stagedPath?: string; status: string; error?: string; verification?: { passed: boolean; checks: unknown[] } }>;
      };
    };
    assert.equal(jobBeforeAction.status, "awaiting_action");
    const success = jobBeforeAction.resultJson.files.find((file) => file.filePath.endsWith("large.png"));
    const skipped = jobBeforeAction.resultJson.files.find((file) => file.filePath.endsWith("tiny.png"));
    assert.equal(success?.status, "success");
    assert.equal(success?.verification?.passed, true);
    assert.ok(success?.stagedPath && fs.existsSync(success.stagedPath));
    assert.equal(skipped?.status, "skipped");
    assert.match(skipped?.error ?? "", /not smaller|optimized/i);
    assert.ok(fs.existsSync(path.join(root, "large.png")), "original must remain before action");

    const action = await request(`/optimize/conversion/${jobId}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "recycle" }),
    });
    const actionBody = await action.json() as { outcomes: Array<{ originalPath: string; outputPath: string; error?: string }> };
    assert.equal(action.status, 200, JSON.stringify(actionBody));
    assert.equal(actionBody.outcomes.length, 2);
    assert.ok(actionBody.outcomes.every((outcome) => outcome.error === undefined));
    assert.ok(fs.existsSync(path.join(root, "large.jpg")), "converted output must be placed at the original location");
    assert.ok(fs.existsSync(path.join(root, "sample.mp4")), "video conversion output must be placed at the original location");
    assert.ok(!fs.existsSync(path.join(root, "large.png")), "recycled original must leave the library");
    assert.ok(!fs.existsSync(path.join(root, "sample.avi")), "recycled video original must leave the library");
    assert.ok(fs.existsSync(path.join(root, "WillardAI", ".Trash")), "recycle location must exist");
    assert.ok(!fs.existsSync(jobBeforeAction.resultJson.stagingDir), "staging directory must be cleaned");

    const logPath = path.join(root, "WillardAI", "logs", "conversions.jsonl");
    assert.match(fs.readFileSync(logPath, "utf8"), /"action":"recycle"/);

    const replay = await request(authorizedUrl);
    assert.equal(replay.status, 403);
    await replay.text();
  });
});