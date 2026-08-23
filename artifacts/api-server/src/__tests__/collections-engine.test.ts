/**
 * Regression tests for the auto-album engine and smart-folder rule handling.
 *
 * Run with:
 *   node --experimental-strip-types --test src/__tests__/collections-engine.test.ts
 */

import { after, before, beforeEach, describe, test } from "node:test";
import * as assert from "node:assert/strict";
import {
  db,
  pool,
  collectionItemsTable,
  collectionsTable,
  geoPlaceCacheTable,
  mediaFilesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  parseSmartRule,
  rebuildAutoCollections,
  validateSmartRule,
} from "../lib/collections-engine.ts";

const nasPath = `/tmp/willard-collections-engine-${process.pid}-${Date.now()}`;
const placeCells = [
  { lat10: 891, lon10: 1791, name: "Test City, North Pole" },
  { lat10: 881, lon10: 1781, name: "Other City, North Pole" },
];
let mediaIds: number[] = [];

async function addMedia(values: Partial<typeof mediaFilesTable.$inferInsert> = {}) {
  const [row] = await db.insert(mediaFilesTable).values({
    nasPath,
    relativePath: values.relativePath ?? `file-${mediaIds.length + 1}.dat`,
    name: values.name ?? `file-${mediaIds.length + 1}.dat`,
    extension: values.extension ?? "dat",
    mimeType: values.mimeType ?? "application/octet-stream",
    mediaType: values.mediaType ?? "other",
    ...values,
  }).returning({ id: mediaFilesTable.id });
  assert.ok(row);
  mediaIds.push(row.id);
  return row.id;
}

async function autoCollections() {
  return db.select().from(collectionsTable).where(eq(collectionsTable.nasPath, nasPath));
}

async function clearFixtures() {
  await db.delete(collectionsTable).where(eq(collectionsTable.nasPath, nasPath));
  await db.delete(mediaFilesTable).where(eq(mediaFilesTable.nasPath, nasPath));
  mediaIds = [];
}

before(async () => {
  await clearFixtures();
  await db.insert(geoPlaceCacheTable).values(placeCells).onConflictDoNothing();
});

beforeEach(async () => {
  await clearFixtures();
});

after(async () => {
  await db.delete(collectionsTable).where(eq(collectionsTable.nasPath, nasPath));
  if (mediaIds.length > 0) {
    await db.delete(mediaFilesTable).where(inArray(mediaFilesTable.id, mediaIds));
  }
  await db.delete(geoPlaceCacheTable).where(
    and(
      eq(geoPlaceCacheTable.lat10, placeCells[0]!.lat10),
      eq(geoPlaceCacheTable.lon10, placeCells[0]!.lon10),
    ),
  );
  await db.delete(geoPlaceCacheTable).where(
    and(
      eq(geoPlaceCacheTable.lat10, placeCells[1]!.lat10),
      eq(geoPlaceCacheTable.lon10, placeCells[1]!.lon10),
    ),
  );
  await pool.end();
});

describe("auto-album rebuilds", { concurrency: false }, () => {
  test("rebuild is idempotent and replaces membership without duplicating albums", async () => {
    const ids = await Promise.all(
      [0, 1, 2].map((i) => addMedia({
        relativePath: `events/${i}.jpg`,
        name: `events-${i}.jpg`,
        extension: "jpg",
        mimeType: "image/jpeg",
        mediaType: "photo",
        dateTaken: new Date("2024-06-01T12:00:00Z"),
      })),
    );

    const first = await rebuildAutoCollections(nasPath);
    const second = await rebuildAutoCollections(nasPath);
    assert.equal(first.collections, 1);
    assert.equal(first.items, 3);
    assert.deepEqual(second, first);

    const albums = await autoCollections();
    assert.equal(albums.length, 1);
    assert.equal(albums[0]!.autoKey, "event:2024-06");
    const items = await db.select().from(collectionItemsTable)
      .where(eq(collectionItemsTable.collectionId, albums[0]!.id));
    assert.deepEqual(items.map((item) => item.mediaFileId).sort(), ids.sort());
  });

  test("tombstoned auto albums stay deleted and are not recreated", async () => {
    await addMedia({
      relativePath: "receipt.pdf",
      name: "receipt.pdf",
      extension: "pdf",
      mimeType: "application/pdf",
      mediaType: "document",
    });
    const removedAt = new Date();
    const [tombstone] = await db.insert(collectionsTable).values({
      nasPath,
      kind: "auto",
      autoKey: "doc:receipts",
      name: "Receipts & Invoices",
      removedAt,
    }).returning({ id: collectionsTable.id });
    assert.ok(tombstone);

    await rebuildAutoCollections(nasPath);
    const albums = await autoCollections();
    assert.equal(albums.length, 1);
    assert.equal(albums[0]!.id, tombstone.id);
    assert.ok(albums[0]!.removedAt);
    assert.equal(
      (await db.select().from(collectionItemsTable)
        .where(eq(collectionItemsTable.collectionId, tombstone.id))).length,
      0,
    );
  });

  test("preserves a user's renamed auto album across rebuilds", async () => {
    await addMedia({
      relativePath: "manual-1.jpg",
      name: "manual-1.jpg",
      extension: "jpg",
      mimeType: "image/jpeg",
      mediaType: "photo",
      dateTaken: new Date("2025-01-01T12:00:00Z"),
    });
    await addMedia({
      relativePath: "manual-2.jpg",
      name: "manual-2.jpg",
      extension: "jpg",
      mimeType: "image/jpeg",
      mediaType: "photo",
      dateTaken: new Date("2025-01-01T12:00:00Z"),
    });
    await addMedia({
      relativePath: "manual-3.jpg",
      name: "manual-3.jpg",
      extension: "jpg",
      mimeType: "image/jpeg",
      mediaType: "photo",
      dateTaken: new Date("2025-01-01T12:00:00Z"),
    });
    await rebuildAutoCollections(nasPath);
    const [album] = await autoCollections();
    assert.ok(album);
    await db.update(collectionsTable)
      .set({ name: "Our winter trip", description: "A personal title" })
      .where(eq(collectionsTable.id, album.id));

    await rebuildAutoCollections(nasPath);
    const [rebuilt] = await autoCollections();
    assert.equal(rebuilt!.name, "Our winter trip");
    assert.equal(rebuilt!.description, "A personal title");
  });

  test("applies minimum thresholds to event and place groups", async () => {
    await addMedia({
      relativePath: "two-a.jpg", name: "two-a.jpg", extension: "jpg",
      mimeType: "image/jpeg", mediaType: "photo",
      dateTaken: new Date("2026-02-01T12:00:00Z"), gpsLatitude: 89.1, gpsLongitude: 179.1,
    });
    await addMedia({
      relativePath: "two-b.jpg", name: "two-b.jpg", extension: "jpg",
      mimeType: "image/jpeg", mediaType: "photo",
      dateTaken: new Date("2026-02-01T12:00:00Z"), gpsLatitude: 89.12, gpsLongitude: 179.12,
    });
    const result = await rebuildAutoCollections(nasPath);
    assert.equal(result.collections, 0, "two items must not create event or place albums");
  });

  test("groups documents using category keywords before extension fallback", async () => {
    await addMedia({
      relativePath: "tax.pdf", name: "tax.pdf", extension: "pdf",
      mimeType: "application/pdf", mediaType: "document", pdfTitle: "Annual tax statement",
    });
    await addMedia({
      relativePath: "guide.pdf", name: "guide.pdf", extension: "pdf",
      mimeType: "application/pdf", mediaType: "document", pdfKeywords: "installation guide",
    });
    await addMedia({
      relativePath: "table.pdf", name: "table.pdf", extension: "pdf",
      mimeType: "application/pdf", mediaType: "document",
    });
    await rebuildAutoCollections(nasPath);
    const albums = await autoCollections();
    assert.deepEqual(
      albums.map((album) => [album.autoKey, album.name]).sort(),
      [
        ["doc:finance", "Financial Documents"],
        ["doc:manuals", "Manuals & Guides"],
        ["doc:pdf", "PDFs"],
      ],
    );
  });
});

describe("smart folder rules", { concurrency: false }, () => {
  test("salvages valid persisted fields from a malformed rule", () => {
    const rule = parseSmartRule({
      mediaTypes: ["photo", "not-a-type"],
      extensions: ["jpg"],
      nameContains: 42,
      favoritesOnly: true,
      unknown: "ignored",
    });
    assert.deepEqual(rule, {
      extensions: ["jpg"],
      favoritesOnly: true,
    });
  });

  test("validates accepted rules and rejects bad payloads", () => {
    const valid = validateSmartRule({
      mediaTypes: ["photo"],
      dateFrom: "2024-01-01T00:00:00Z",
      minSizeBytes: 10,
    });
    assert.deepEqual(valid, {
      rule: {
        mediaTypes: ["photo"],
        dateFrom: "2024-01-01T00:00:00Z",
        minSizeBytes: 10,
      },
    });

    const invalid = validateSmartRule({
      mediaTypes: ["photo"],
      minSizeBytes: -1,
    });
    assert.ok("error" in invalid);
    assert.match(invalid.error, /minSizeBytes/);
  });
});