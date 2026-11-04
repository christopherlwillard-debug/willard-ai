import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MediaRenameConflictError,
  renameFileWithPersistence,
} from "../lib/media-rename.ts";

function withTempFiles(run: (directory: string, source: string, destination: string) => Promise<void>) {
  return async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "willard-media-rename-"));
    const source = path.join(directory, "before.jpg");
    const destination = path.join(directory, "after.jpg");
    fs.writeFileSync(source, "media-bytes");
    try {
      await run(directory, source, destination);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

test("restores original file when catalog persistence fails", withTempFiles(async (_dir, source, destination) => {
  await assert.rejects(
    renameFileWithPersistence(
      source,
      destination,
      async () => { throw new Error("database unavailable"); },
      (from, to) => fs.renameSync(from, to),
    ),
    /database unavailable/,
  );
  assert.equal(fs.readFileSync(source, "utf8"), "media-bytes");
  assert.equal(fs.existsSync(destination), false);
}));

test("restores original file when the catalog row is no longer active", withTempFiles(async (_dir, source, destination) => {
  await assert.rejects(
    renameFileWithPersistence(
      source,
      destination,
      async () => undefined,
      (from, to) => fs.renameSync(from, to),
    ),
    MediaRenameConflictError,
  );
  assert.equal(fs.readFileSync(source, "utf8"), "media-bytes");
  assert.equal(fs.existsSync(destination), false);
}));

test("keeps the new path when catalog persistence succeeds", withTempFiles(async (_dir, source, destination) => {
  const result = await renameFileWithPersistence(
    source,
    destination,
    async () => ({ id: 7, relativePath: "after.jpg" }),
    (from, to) => fs.renameSync(from, to),
  );
  assert.deepEqual(result, { id: 7, relativePath: "after.jpg" });
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(destination, "utf8"), "media-bytes");
}));

test("does not overwrite a new file created at the original path during rollback", withTempFiles(async (_dir, source, destination) => {
  await assert.rejects(
    renameFileWithPersistence(
      source,
      destination,
      async () => {
        fs.writeFileSync(source, "new-independent-file");
        throw new Error("database unavailable");
      },
      (from, to) => fs.renameSync(from, to),
    ),
    (error: unknown) => error instanceof AggregateError,
  );
  assert.equal(fs.readFileSync(source, "utf8"), "new-independent-file");
  assert.equal(fs.readFileSync(destination, "utf8"), "media-bytes");
}));

test("preserves both failures if filesystem rollback also fails", withTempFiles(async (_dir, source, destination) => {
  let renameCalls = 0;
  await assert.rejects(
    renameFileWithPersistence(
      source,
      destination,
      async () => { throw new Error("database unavailable"); },
      (from, to) => {
        renameCalls += 1;
        if (renameCalls === 2) throw new Error("disk unavailable");
        fs.renameSync(from, to);
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      return true;
    },
  );
  assert.equal(fs.existsSync(destination), true);
}));
