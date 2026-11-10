import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  openRegularFileWithoutSymlinkTraversal,
  readDirectoryWithoutSymlinkTraversal,
  removeEmptyDirectoryWithoutSymlinkTraversal,
} from "../lib/safe-directory-read.ts";

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

test("symlink swaps after enumeration are omitted instead of following outside targets", (t) => {
  if (process.platform !== "linux") {
    t.skip("Descriptor-relative directory reads use Linux procfs handles.");
    return;
  }
  const root = makeTempRoot("willard-safe-directory-entry-race-");
  const target = path.join(root, "photos");
  const outside = makeTempRoot("willard-safe-directory-entry-race-outside-");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "stable.jpg"), "safe");
  fs.writeFileSync(path.join(target, "swapped.jpg"), "original");
  fs.mkdirSync(path.join(target, "album"));
  fs.writeFileSync(path.join(outside, "secret.jpg"), "secret");
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const result = readDirectoryWithoutSymlinkTraversal(root, target, {
    afterEntriesRead: () => {
      fs.renameSync(path.join(target, "swapped.jpg"), path.join(target, "swapped-original.jpg"));
      fs.symlinkSync(path.join(outside, "secret.jpg"), path.join(target, "swapped.jpg"));
      fs.renameSync(path.join(target, "album"), path.join(target, "album-original"));
      makeDirLink(outside, path.join(target, "album"));
    },
  });

  assert.ok(result);
  assert.deepEqual(result.entries.map((entry) => entry.name), ["stable.jpg"]);
});

test("empty-directory removal does not follow a final symlink swap", (t) => {
  if (process.platform !== "linux") {
    t.skip("Handle-relative directory removal uses Linux procfs handles.");
    return;
  }
  const root = makeTempRoot("willard-safe-rmdir-");
  const outside = makeTempRoot("willard-safe-rmdir-outside-");
  const target = path.join(root, "empty");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  assert.throws(() => removeEmptyDirectoryWithoutSymlinkTraversal(root, target, {
    afterParentOpened: () => {
      fs.renameSync(target, path.join(root, "original-empty"));
      makeDirLink(outside, target);
    },
  }));
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "keep");
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
  assert.equal(removeEmptyDirectoryWithoutSymlinkTraversal(root, path.join(root, "original-empty")), true);
});

test("regular files are opened beneath the root without following swapped parent or final symlinks", (t) => {
  if (process.platform !== "linux") {
    t.skip("Handle-relative file reads use Linux procfs handles.");
    return;
  }
  const root = makeTempRoot("willard-safe-file-");
  const outside = makeTempRoot("willard-safe-file-outside-");
  const parent = path.join(root, "assets");
  fs.mkdirSync(parent);
  fs.writeFileSync(path.join(parent, "bundle.js"), "inside");
  fs.writeFileSync(path.join(outside, "bundle.js"), "outside");
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  assert.throws(() => openRegularFileWithoutSymlinkTraversal(root, "../secret.txt"));

  const openedFromOriginalParent = openRegularFileWithoutSymlinkTraversal(root, "assets/bundle.js", {
    afterParentOpened: () => {
      fs.renameSync(parent, path.join(root, "assets-original"));
      makeDirLink(outside, parent);
    },
  });
  assert.ok(openedFromOriginalParent);
  try {
    assert.equal(fs.readFileSync(openedFromOriginalParent.fd, "utf8"), "inside");
  } finally {
    fs.closeSync(openedFromOriginalParent.fd);
  }

  fs.unlinkSync(path.join(parent, "bundle.js"));
  assert.throws(() => openRegularFileWithoutSymlinkTraversal(root, "assets/bundle.js", {
    afterParentOpened: () => {
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(parent, "bundle.js"));
    },
  }));
  assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "secret");
});
