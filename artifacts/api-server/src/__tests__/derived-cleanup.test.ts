import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { mock } from "node:test";

const queries: string[] = [];
const cropRoot = fs.mkdtempSync(path.join(os.tmpdir(), "willard-derived-cleanup-"));
const faceDir = path.join(cropRoot, "WillardAI", "cache", "faces");
const safeCrop = path.join(faceDir, "42-1.webp");
const outsideCrop = path.join(cropRoot, "outside.webp");
fs.mkdirSync(faceDir, { recursive: true });
fs.writeFileSync(safeCrop, "safe");
fs.writeFileSync(outsideCrop, "outside");

const client = {
  async query(text: string): Promise<{ rows: any[]; rowCount: number }> {
    queries.push(text);
    if (text.includes("SELECT fc.crop_path")) {
      return {
        rows: [
          { crop_path: safeCrop, person_id: 7, media_file_id: 42 },
          { crop_path: outsideCrop, person_id: 7, media_file_id: 42 },
        ],
        rowCount: 2,
      };
    }
    if (text.includes("SELECT id FROM people")) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  },
  release() {},
};

mock.module("@workspace/db", {
  namedExports: { pool: { connect: async () => client } },
});

const { purgeDerivedDataForMedia } = await import("../lib/derived-cleanup.ts");

test("derived purge is transactional and only removes crops under WillardAI", async () => {
  const report = await purgeDerivedDataForMedia(cropRoot, [42]);

  assert.equal(queries[0], "BEGIN");
  assert.equal(queries.at(-1), "COMMIT");
  assert.equal(report.mediaAiRows, 0);
  assert.equal(report.faceRows, 0);
  assert.equal(report.cropsRemoved, 1);
  assert.equal(report.cropErrors.length, 0);
  assert.equal(fs.existsSync(safeCrop), false);
  assert.equal(fs.existsSync(outsideCrop), true);
});

test.after(() => {
  fs.rmSync(cropRoot, { recursive: true, force: true });
  mock.restoreAll();
});