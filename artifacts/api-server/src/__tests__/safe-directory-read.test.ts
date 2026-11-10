import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readDirectoryWithoutSymlinkTraversal } from "../lib/safe-directory-read.ts";

function makeTempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeDirLink(target: string, link: string): void {
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

test("descriptor-relative directory reads list only regular children within the library", (t) => {
  if (process.platform !== "linux") {
    t.skip("Descriptor-relative directory reads use Linux procfs handles.");
    return;
  }
  const root = makeTempRoot("willard-safe-directory-");
  const child = path.join(root, "photos");
  fs.mkdirSync(child);
  fs.writeFileSync(path.join(child, "inside.jpg"), "image");
  const outside = makeTempRoot("willard-safe-directory-outside-");
  fs.writeFileSync(path.join(outside, "secret.jpg"), "secret");
  try {
    makeDirLink(outside, path.join(child, "escape"));
  } catch (error) {
    if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("The runner does not permit directory symlink creation.");
      return;
    }
    throw error;
  }
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const result = readDirectoryWithoutSymlinkTraversal(root, child);
  assert.ok(result);
  assert.deepEqual(result.entries.map((entry) => entry.name), ["inside.jpg"]);
  assert.equal(result.entries[0]?.sizeBytes, 5);
});

test("rejects traversal and a symlink installed before the target directory is opened", (t) => {
  if (process.platform !== "linux") {
    t.skip("Descriptor-relative directory reads use Linux procfs handles.");
    return;
  }
  const root = makeTempRoot("willard-safe-directory-race-");
  const outside = makeTempRoot("willard-safe-directory-race-outside-");
  const victim = path.join(root, "victim");
  fs.mkdirSync(victim);
  fs.writeFileSync(path.join(outside, "secret.jpg"), "secret");
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  assert.throws(() => readDirectoryWithoutSymlinkTraversal(root, path.join(root, "..", "outside")));
  assert.throws(() => readDirectoryWithoutSymlinkTraversal(root, victim, {
    afterRootOpened: () => {
      fs.renameSync(victim, path.join(root, "victim-original"));
      makeDirLink(outside, victim);
    },
  }));
});

test("a path swap after opening the target keeps enumeration on the opened directory handle", (t) => {
  if (process.platform !== "linux") {
    t.skip("Descriptor-relative directory reads use Linux procfs handles.");
    return;
  }
  const root = makeTempRoot("willard-safe-directory-bound-");
  const outside = makeTempRoot("willard-safe-directory-bound-outside-");
  const victim = path.join(root, "victim");
  fs.mkdirSync(victim);
  fs.writeFileSync(path.join(victim, "inside.jpg"), "inside");
  fs.writeFileSync(path.join(outside, "secret.jpg"), "secret");
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const result = readDirectoryWithoutSymlinkTraversal(root, victim, {
    afterTargetOpened: () => {
      fs.renameSync(victim, path.join(root, "victim-original"));
      makeDirLink(outside, victim);
    },
  });
  assert.ok(result);
  assert.deepEqual(result.entries.map((entry) => entry.name), ["inside.jpg"]);
});
