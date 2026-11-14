/**
 * API integration coverage for library-scoped user tags.
 *
 * Runs only through the disposable local backend audit:
 *   pnpm run audit:backend
 */
import { describe, test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, pool, appSettingsTable, mediaFilesTable, mediaTagsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { requireDisposableAuditApiUrl, runCleanupSteps } from "./integration-test-safety.ts";

const API_BASE = requireDisposableAuditApiUrl();
const PASSWORD = "willard123";
let cookie = "";
let nasPath = "";
let fixtureIds: number[] = [];
let tagNames: { trip: string; summer: string } | undefined;

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
    const [settings] = await db.select({ nasPath: appSettingsTable.nasPath })
      .from(appSettingsTable).limit(1);
    assert.ok(settings?.nasPath, "A configured library is required");
    nasPath = settings.nasPath!;
    const suffix = Date.now();
    const tagPrefix = `audit-${randomUUID().slice(0, 8)}`;
    tagNames = { trip: `${tagPrefix}-trip`, summer: `${tagPrefix}-summer` };
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
    const cleanup: Array<{ name: string; run: () => void | Promise<void> }> = [];
    if (fixtureIds.length) {
      cleanup.push({
        name: "media-file fixtures",
        run: async () => {
          await db.delete(mediaFilesTable).where(inArray(mediaFilesTable.id, fixtureIds));
        },
      });
    }
    if (tagNames) {
      cleanup.push({
        name: "unique media-tag fixtures",
        run: async () => {
          await db.delete(mediaTagsTable).where(and(
            eq(mediaTagsTable.nasPath, nasPath),
            inArray(mediaTagsTable.name, [tagNames!.trip, tagNames!.summer]),
          ));
        },
      });
    }
    cleanup.push({ name: "database connection pool", run: () => pool.end() });
    await runCleanupSteps("Media-tags integration test", cleanup);
  });

  test("creates, lists, replaces, and filters tags while excluding recycled and foreign files", async () => {
    const [one, two, recycled, foreign] = fixtureIds;
    assert.ok(tagNames, "unique test tag names must be initialized");
    const { trip, summer } = tagNames;
    const update = await request(`/media/files/${one}/tags`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: [` ${trip.toUpperCase()} `, trip.toUpperCase(), summer] }),
    });
    assert.equal(update.status, 200, await update.clone().text());
    const updateBody = await update.json() as { tags: string[] };
    assert.deepEqual(updateBody.tags, [trip, summer]);

    const second = await request(`/media/files/${two}/tags`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: [summer] }),
    });
    assert.equal(second.status, 200);

    const tagsResponse = await request("/media/tags");
    assert.equal(tagsResponse.status, 200);
    const tagsBody = await tagsResponse.json() as { tags: Array<{ name: string }> };
    assert.deepEqual(
      tagsBody.tags.map((tag) => tag.name).filter((name) => [trip, summer].includes(name)),
      [trip, summer].sort(),
    );

    const filtered = await request(`/media/files?limit=100&tags=${encodeURIComponent(`${trip},${summer}`)}`);
    const filteredBody = await filtered.json() as { files: Array<{ id: number; tags: string[] }>; total: number };
    assert.equal(filteredBody.total, 1);
    assert.equal(filteredBody.files[0]?.id, one);
    assert.deepEqual(filteredBody.files[0]?.tags, [trip, summer]);

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