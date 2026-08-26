import { after, before, describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { archivesTable, db, pool } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  archiveByIdScope,
  archiveScope,
  resolveActiveArchivePath,
} from "../lib/archive-scope.ts";

describe("archive active-library isolation", { concurrency: false }, () => {
  let libraryA: string;
  let libraryB: string;
  let archiveIds: number[] = [];

  before(async () => {
    libraryA = fs.mkdtempSync(path.join(os.tmpdir(), "willard-archive-a-"));
    libraryB = fs.mkdtempSync(path.join(os.tmpdir(), "willard-archive-b-"));
    fs.writeFileSync(path.join(libraryA, "a.zip"), "archive-a");
    fs.writeFileSync(path.join(libraryB, "b.zip"), "archive-b");

    const inserted = await db.insert(archivesTable).values([
      {
        nasPath: libraryA,
        path: path.join(libraryA, "a.zip"),
        filename: "a.zip",
        sizeBytes: 9,
        folder: libraryA,
        category: "general",
        peekStatus: "peeked",
      },
      {
        nasPath: libraryB,
        path: path.join(libraryB, "b.zip"),
        filename: "b.zip",
        sizeBytes: 9,
        folder: libraryB,
        category: "general",
        peekStatus: "peeked",
      },
    ]).returning({ id: archivesTable.id });
    archiveIds = inserted.map(row => row.id);
  });

  after(async () => {
    if (archiveIds.length > 0) {
      await db.delete(archivesTable).where(inArray(archivesTable.id, archiveIds));
    }
    fs.rmSync(libraryA, { recursive: true, force: true });
    fs.rmSync(libraryB, { recursive: true, force: true });
    await pool.end();
  });

  test("lists only rows owned by the active library", async () => {
    const rowsA = await db.select({ id: archivesTable.id, nasPath: archivesTable.nasPath })
      .from(archivesTable)
      .where(archiveScope(libraryA));
    const rowsB = await db.select({ id: archivesTable.id, nasPath: archivesTable.nasPath })
      .from(archivesTable)
      .where(archiveScope(libraryB));

    assert.deepEqual(rowsA.map(row => row.id), [archiveIds[0]]);
    assert.deepEqual(rowsB.map(row => row.id), [archiveIds[1]]);
  });

  test("a stale or foreign ID cannot be read or updated through the active scope", async () => {
    const foreignId = archiveIds[1];
    const hidden = await db.select({ id: archivesTable.id })
      .from(archivesTable)
      .where(archiveByIdScope(foreignId, libraryA));
    assert.deepEqual(hidden, []);

    await db.update(archivesTable)
      .set({ peekStatus: "unsupported" })
      .where(archiveByIdScope(foreignId, libraryA));

    const [foreign] = await db.select({ peekStatus: archivesTable.peekStatus })
      .from(archivesTable)
      .where(and(eq(archivesTable.id, foreignId), eq(archivesTable.nasPath, libraryB)));
    assert.equal(foreign?.peekStatus, "peeked");
  });

  test("binds archive filesystem reads to the active root", () => {
    const archiveA = path.join(libraryA, "a.zip");
    assert.equal(resolveActiveArchivePath(archiveA, libraryA), archiveA);
    assert.throws(
      () => resolveActiveArchivePath(path.join(libraryB, "b.zip"), libraryA),
      /outside the allowed root/,
    );
    assert.throws(
      () => resolveActiveArchivePath(path.join(libraryA, "..", "outside.zip"), libraryA),
      /outside the allowed root/,
    );

    if (process.platform !== "win32") {
      assert.throws(
        () => resolveActiveArchivePath("Z:\\Media\\a.zip", libraryA),
        /outside the allowed root/,
      );
      assert.throws(
        () => resolveActiveArchivePath("\\\\nas\\media\\a.zip", libraryA),
        /outside the allowed root/,
      );
    }
  });
});