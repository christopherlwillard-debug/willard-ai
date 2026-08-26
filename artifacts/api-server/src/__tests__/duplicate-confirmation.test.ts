import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DUPLICATE_CONFIRMATION_LIMIT_BYTES,
  hashFileBounded,
} from "../lib/library-engine/indexer.ts";

function fixturePath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "willard-duplicate-confirmation-"));
  return path.join(dir, name);
}

function cleanup(filePath: string): void {
  fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
}

test("duplicate confirmation hashes a file at the 500 MiB limit", async () => {
  const filePath = fixturePath("at-limit.bin");
  try {
    const content = Buffer.from("confirmed");
    fs.writeFileSync(filePath, content);
    const expected = createHash("sha256").update(content).digest("hex");

    const result = await hashFileBounded(filePath, content.length, content.length);

    assert.deepEqual(result, { status: "CONFIRMED", hash: expected });
    assert.equal(DUPLICATE_CONFIRMATION_LIMIT_BYTES, 500 * 1024 * 1024);
  } finally {
    cleanup(filePath);
  }
});

test("multi-gigabyte sparse files are rejected before opening the stream", async () => {
  const filePath = fixturePath("multi-gigabyte-sparse.bin");
  try {
    fs.closeSync(fs.openSync(filePath, "w"));
    fs.truncateSync(filePath, 5 * 1024 * 1024 * 1024);

    const result = await hashFileBounded(
      filePath,
      5 * 1024 * 1024 * 1024,
      DUPLICATE_CONFIRMATION_LIMIT_BYTES,
    );

    assert.deepEqual(result, { status: "UNCONFIRMED_LARGE", hash: null });
  } finally {
    cleanup(filePath);
  }
});

test("confirmation stops as unconfirmed-large if a file grows after indexing", async () => {
  const filePath = fixturePath("grew-after-index.bin");
  try {
    const content = Buffer.alloc(128 * 1024, 3);
    fs.writeFileSync(filePath, content);

    const result = await hashFileBounded(filePath, 1, 64 * 1024);

    assert.deepEqual(result, { status: "UNCONFIRMED_LARGE", hash: null });
  } finally {
    cleanup(filePath);
  }
});

test("cancellation destroys a slow confirmation stream before it hashes the full file", async () => {
  const filePath = fixturePath("cancelled-slow-read.bin");
  try {
    fs.writeFileSync(filePath, Buffer.alloc(8 * 1024 * 1024, 5));
    let chunks = 0;
    const result = await hashFileBounded(
      filePath,
      8 * 1024 * 1024,
      8 * 1024 * 1024,
      () => chunks++ > 0,
    );

    assert.equal(result.status, "UNCONFIRMED_CANCELLED");
    assert.equal(result.hash, null);
    assert.ok(chunks < 10, `cancellation should stop promptly, observed ${chunks} chunks`);
  } finally {
    cleanup(filePath);
  }
});