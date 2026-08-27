import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendPrivateJsonl,
  ensurePrivateDir,
  pruneOperationalFiles,
} from "../lib/nas-storage.ts";
import {
  REDACTED,
  redactOperationalData,
  redactText,
} from "../lib/log-redaction.ts";

test("redacts paths, filenames, hashes, queries, and reports while preserving safe metrics", () => {
  const sourcePath = "/home/alice/Photos/private.jpg";
  const sourceHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const input = {
    operation: "scan",
    processedFiles: 12,
    nasPath: sourcePath,
    nested: {
      filename: "private.jpg",
      sourceHash,
      query: "birthday photos",
      report: { destination: "/mnt/archive/private.jpg" },
    },
    diagnostics: {
      totalFiles: 12,
      thumbnailPath: "/home/alice/WillardAI/cache/private.webp",
      finishedAt: new Date("2026-08-27T12:00:00.000Z"),
    },
    error: new Error(`Could not open ${sourcePath}; checksum=${sourceHash}`),
  };

  const output = redactOperationalData(input) as Record<string, any>;
  const serialized = JSON.stringify(output);

  assert.equal(output.processedFiles, 12);
  assert.equal(output.nasPath, REDACTED);
  assert.equal(output.nested.filename, REDACTED);
  assert.equal(output.nested.sourceHash, REDACTED);
  assert.equal(output.nested.query, REDACTED);
  assert.equal(output.nested.report, REDACTED);
  assert.equal(output.diagnostics.totalFiles, 12);
  assert.equal(output.diagnostics.thumbnailPath, REDACTED);
  assert.equal(output.diagnostics.finishedAt, "2026-08-27T12:00:00.000Z");
  assert.ok(!serialized.includes(sourcePath));
  assert.ok(!serialized.includes(sourceHash));
  assert.ok(!serialized.includes("birthday photos"));
  assert.match(output.error.message, /Could not open/);
  assert.ok(!output.error.message.includes(sourcePath));
});

test("redacts path and hash material embedded in free-form text", () => {
  const hash = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const value = redactText(`failed /tmp/WillardAI/private.jpg hash=${hash} folder/photo.jpg`);
  assert.ok(!value.includes("/tmp/WillardAI/private.jpg"));
  assert.ok(!value.includes(hash));
  assert.ok(!value.includes("folder/photo.jpg"));
  assert.match(value, /failed/);
});

test("private JSONL logs are redacted, bounded, and private on POSIX", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-log-redaction-"));
  const logDir = path.join(root, "logs");
  const logPath = path.join(logDir, "operations.jsonl");
  try {
    ensurePrivateDir(logDir);
    appendPrivateJsonl(logPath, { sequence: 1, path: "/private/one.jpg" }, 2);
    appendPrivateJsonl(logPath, { sequence: 2, path: "/private/two.jpg" }, 2);
    appendPrivateJsonl(logPath, { sequence: 3, path: "/private/three.jpg" }, 2);

    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((line) => JSON.parse(line).sequence), [2, 3]);
    assert.ok(lines.every((line) => !line.includes("/private/")));

    if (process.platform !== "win32") {
      assert.equal(fs.statSync(logDir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("operational artifact retention removes only old matching files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-log-retention-"));
  try {
    for (const name of ["org-old.log", "org-middle.log", "org-new.log", "keep.txt"]) {
      fs.writeFileSync(path.join(root, name), name);
    }
    const now = Date.now();
    fs.utimesSync(path.join(root, "org-old.log"), now / 1000 - 30, now / 1000 - 30);
    fs.utimesSync(path.join(root, "org-middle.log"), now / 1000 - 20, now / 1000 - 20);
    fs.utimesSync(path.join(root, "org-new.log"), now / 1000 - 10, now / 1000 - 10);

    pruneOperationalFiles(root, "org-", 2);

    assert.equal(fs.existsSync(path.join(root, "org-old.log")), false);
    assert.equal(fs.existsSync(path.join(root, "org-middle.log")), true);
    assert.equal(fs.existsSync(path.join(root, "org-new.log")), true);
    assert.equal(fs.existsSync(path.join(root, "keep.txt")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});