import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isPortableMediaFileName,
  MediaRenameConflictError,
  renameFileWithPersistence,
} from "../lib/media-rename.ts";
import { moveFileNoReplace } from "../lib/organize-helpers.ts";

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


test("media rename refuses to overwrite a destination created after the route preflight", withTempFiles(async (_dir, source, destination) => {
  fs.writeFileSync(destination, "independent destination");
  await assert.rejects(
    renameFileWithPersistence(
      source,
      destination,
      async () => ({ id: 7 }),
      moveFileNoReplace,
    ),
    /EEXIST/,
  );
  assert.equal(fs.readFileSync(source, "utf8"), "media-bytes");
  assert.equal(fs.readFileSync(destination, "utf8"), "independent destination");
}));

test("portable media filenames reject Windows device names and invalid components", () => {
  for (const name of [
    "CON", "con.txt", "PRN.jpg", "AUX", "NUL.tar", "CONIN$", "CONOUT$.log",
    "COM1", "com9.mp4", "COM¹.txt", "LPT1", "lpt³.zip",
    "trailing.", "trailing ", "bad:name", "bad/name", "bad\\\\name",
    "bad?name", "bad*name", "line\\nbreak", ".", "..",
  ]) {
    assert.equal(isPortableMediaFileName(name), false, name);
  }
  assert.equal(isPortableMediaFileName("x".repeat(256)), false);
});

test("portable media filename validation accepts ordinary cross-platform names", () => {
  for (const name of [
    "family photo 2026.jpg",
    "résumé (final).pdf",
    ".hidden-file",
    "holiday_100%.mp4",
    "COM10.txt",
  ]) {
    assert.equal(isPortableMediaFileName(name), true, name);
  }
  for (const value of [undefined, null, 42, true, {}, ["photo.jpg"], ""]) {
    assert.equal(isPortableMediaFileName(value), false);
  }
});

test("media rename route validates JSON name type and uses no-replace moves", () => {
  const route = fs.readFileSync("artifacts/api-server/src/routes/media.ts", "utf8");
  assert.match(route, /const requestedName = req\\.body\\?\\.name;/);
  assert.match(route, /typeof requestedName === "string"/);
  assert.match(route, /isPortableMediaFileName\\(newName\\)/);
  assert.match(route, /\\(from, to\\) => moveFileNoReplace\\(from, to\\)/);
  assert.match(route, /if \\(newRelPath === file\\.relativePath\\)/);
});
