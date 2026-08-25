/**
 * API integration coverage for library-scoped user tags.
 *
 * Requires the API workflow and a configured development database:
 *   node --experimental-strip-types --test src/__tests__/media-tags.test.ts
 */
import { describe, test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import { db, pool, appSettingsTable, mediaFilesTable, mediaTagsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

const API_BASE = process.env["WILLARD_API_URL"]
  ?? (process.env["REPLIT_DEV_DOMAIN"] ? `https://${process.env["REPLIT_DEV_DOMAIN"]}` : "http://localhost:8080");
const PASSWORD = "willard123";
let cookie = "";
let nasPath = "";
let originalSettings: { id: number; nasPath: string } | undefined;
let fixtureIds: number[] = [];

async function request(route: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("Cookie", cookie);
  const response = await fetch(`${API_BASE}/api${route}`, { ...init, headers });
  const setCookie = response.headers.get("set-cookie")?.match(/willard\.sid=[^;]+/);
  if (setCookie) cookie = setCookie[0];
  return response;
}

describe("media tags API", { concurrency: false }, () => {
  before(async () => {
    const [settings] = await db.select({ id: appSettingsTable.id, nasPath: appSettingsTable.nasPath })
      .from(appSettingsTable).limit(1);
    assert.ok(settings?.nasPath, "A configured library is required");
    originalSettings = { id: settings.id, nasPath: settings.nasPath! };
    nasPath = settings.nasPath!;
    const suffix = Date.now();
    const rows = await db.insert(mediaFilesTable).values([
      { nasPath, relativePath: `.tag-test-${suffix}/one.jpg`, name: `tag-test-${suffix}-one.jpg`, extension: "jpg", mimeType: "image/jpeg", mediaType: "photo" },
      { nasPath, relativePath: `.tag-test-${suffix}/two.jpg`, name: `tag-test-${suffix}-two.jpg`, extension: "jpg", mimeType: "image/jpeg", mediaType: "photo" },
      { nasPath, relativePath: `.tag-test-${suffix}/recycled.jpg`, name: `tag-test-${suffix}-recycled.jpg`, extension: "jpg", mimeType: "image/jpeg", mediaType: "photo", lastScanAction: "RECYCLED" },
      { nasPath: `/other-library-${suffix}`, relativePath: "foreign.jpg", name: "foreign.jpg", extension: "jpg", mimeType: "image/jpeg", mediaType: "photo" },
    ]).returning({ id: mediaFilesTable.id });
    fixtureIds = rows.map((row) => row.id);
    const login = await request("/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(login.status, 200, await login.text());
  });

  after(async () => {
    if (fixtureIds.length) await db.delete(mediaFilesTable).where(inArray(mediaFilesTable.id, fixtureIds));
    if (originalSettings) await db.update(appSettingsTable).set({ nasPath: originalSettings.nasPath }).where(eq(appSettingsTable.id, originalSettings.id));
    await db.delete(mediaTagsTable).where(eq(mediaTagsTable.nasPath, nasPath));
    await pool.end();
  });

  test("creates, lists, replaces, and filters tags while excluding recycled and foreign files", async () => {
    const [one, two, recycled, foreign] = fixtureIds;
    const update = await request(`/media/files/${one}/tags`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: [" Trip ", "TRIP", "Summer"] }),
    });
    assert.equal(update.status, 200);
    const updateBody = await update.json() as { tags: string[] };
    assert.deepEqual(updateBody.tags, ["trip", "summer"]);

    const second = await request(`/media/files/${two}/tags`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: ["summer"] }),
    });
    assert.equal(second.status, 200);

    const tagsResponse = await request("/media/tags");
    assert.equal(tagsResponse.status, 200);
    const tagsBody = await tagsResponse.json() as { tags: Array<{ name: string }> };
    assert.deepEqual(tagsBody.tags.map((tag) => tag.name).filter((name) => ["trip", "summer"].includes(name)), ["summer", "trip"]);

    const filtered = await request("/media/files?limit=100&tags=trip,summer");
    const filteredBody = await filtered.json() as { files: Array<{ id: number; tags: string[] }>; total: number };
    assert.equal(filteredBody.total, 1);
    assert.equal(filteredBody.files[0]?.id, one);
    assert.deepEqual(filteredBody.files[0]?.tags, ["trip", "summer"]);

    const all = await request("/media/files?limit=100&search=tag-test");
    const allBody = await all.json() as { files: Array<{ id: number; tags: string[] }> };
    assert.ok(allBody.files.some((file) => file.id === one));
    assert.ok(!allBody.files.some((file) => file.id === recycled));
    assert.ok(!allBody.files.some((file) => file.id === foreign));

    const clear = await request(`/media/files/${one}/tags`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: [] }),
    });
    const clearBody = await clear.json() as { tags: string[] };
    assert.deepEqual(clearBody.tags, []);
  });
});