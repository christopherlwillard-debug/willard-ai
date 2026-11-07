import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import AdmZip from "adm-zip";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:5432/willard";

const [, { cleanTempDir, getTempDir }, { pool }] = await Promise.all([
  import("../routes/organize.ts"),
  import("../lib/nas-storage.ts"),
  import("@workspace/db"),
]);
const [{ db, appSettingsTable }, { issueActionToken }, { setCapacityProbeForTests }] = await Promise.all([
  import("@workspace/db"),
  import("../lib/action-tokens.ts"),
  import("../lib/capacity-service.ts"),
]);
const organizeRouter = (await import("../routes/organize.ts")).default;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-archive-links-"));
const nasPath = path.join(root, "library");
fs.mkdirSync(nasPath, { recursive: true });
const originalSelect = db.select;
const originalUpdate = db.update;
const restoreCapacityProbe = setCapacityProbeForTests(async (target, targetPath) => ({
  target,
  path: targetPath,
  totalBytes: 1_000_000_000_000,
  freeBytes: 1_000_000_000_000,
  known: true,
  checkedAt: new Date().toISOString(),
}));
process.env.WILLARD_LOCAL_CAPACITY_FLOOR_BYTES = "0";
process.env.WILLARD_NAS_SAFETY_MARGIN_BYTES = "0";

after(async () => {
  db.select = originalSelect;
  db.update = originalUpdate;
  restoreCapacityProbe();
  fs.rmSync(root, { recursive: true, force: true });
  await pool.end();
});

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function rejectWithoutChanges(archivePath, jobId) {
  const jobIdNumber = Number(jobId.replace(/\D/g, "").slice(-8)) || 393;
  const job = {
    id: jobIdNumber,
    status: "verified",
    sourceType: "archive",
    sourcePath: archivePath,
    archiveDisposition: "keep",
    conflictPolicy: "keep_existing",
    nasPath,
    planJson: {
      routes: [{
        relativePath: "would-have-been-extracted.txt",
        destination: path.join(nasPath, "destination"),
        sizeBytes: 100,
        fileType: "other",
      }],
    },
  };
  const updates = [];
  db.select = () => {
    let selectedTable;
    const query = {
      from(table) { selectedTable = table; return query; },
      where() { return query; },
      orderBy() { return query; },
      async limit() { return selectedTable === appSettingsTable ? [{ nasPath }] : [job]; },
    };
    return query;
  };
  db.update = () => ({
    set(values) {
      updates.push(values);
      const result = Promise.resolve({});
      result.returning = async () => [{ id: job.id }];
      return { where() { return result; } };
    },
  });

  const tempDir = getTempDir(nasPath, `org-${job.id}`);
  const outsideTarget = path.join(path.dirname(tempDir), "outside-target.txt");
  const outsideContents = "outside marker must remain unchanged";
  fs.writeFileSync(outsideTarget, outsideContents);
  const archiveHash = sha256(archivePath);
  const token = await issueActionToken({ session: {} }, "organize-execute", String(job.id));
  const responseChunks = [];
  const response = {
    writeHead() {},
    write(chunk) { responseChunks.push(chunk); return true; },
    end() {},
  };
  const routeLayer = organizeRouter.stack.find(layer =>
    layer.route?.path === "/organize/jobs/:id/execute" && layer.route.methods.get,
  );
  assert.ok(routeLayer, "the actual organization execute route is registered");

  try {
    await routeLayer.route.stack[0].handle({
      id: "archive-link-conformance",
      params: { id: String(job.id) },
      query: { token },
    }, response);
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.equal(sha256(archivePath), archiveHash, "the source archive must be preserved");
    assert.equal(fs.readFileSync(outsideTarget, "utf8"), outsideContents);
    assert.equal(fs.existsSync(tempDir), false, "failed route staging must be removed");
    assert.ok(
      responseChunks.join("").includes("Archive traversal rejected:"),
      "the execute route must report archive link rejection",
    );
    assert.ok(
      updates.some(update => update.status === "rolled_back"),
      "the route must record the rejected job as rolled back",
    );
  } finally {
    cleanTempDir(tempDir, nasPath);
  }
}

test("organization execute route rejects ZIP links aimed outside staging", async () => {
  const archivePath = path.join(nasPath, "unsafe-link.zip");
  const zip = new AdmZip();
  zip.addFile("would-have-been-extracted.txt", Buffer.from("must not be partially extracted"));
  zip.addFile("linked.txt", Buffer.from("../outside-target.txt"));
  const linkEntry = zip.getEntry("linked.txt");
  assert.ok(linkEntry, "ZIP link fixture entry was created");
  linkEntry.attr = 0xa1ff0000;
  zip.writeZip(archivePath);

  const parsed = new AdmZip(archivePath).getEntry("linked.txt");
  assert.ok(parsed);
  assert.equal((parsed.attr >>> 16) & 0xf000, 0xa000, "fixture must carry Unix symlink metadata");
  await rejectWithoutChanges(archivePath, "org-393-zip-link");
});

test("organization execute route rejects 7z links aimed outside staging", {
  skip: !process.env.WILLARD_7ZIP_LINK_ARCHIVE || !process.env.WILLARD_7ZIP_PATH
    ? "Windows validation must provide the verified 7-Zip binary and link fixture"
    : false,
}, async () => {
  const archivePath = process.env.WILLARD_7ZIP_LINK_ARCHIVE;
  assert.ok(fs.statSync(archivePath).isFile(), "cross-platform 7z link fixture is present");
  const localArchivePath = path.join(nasPath, "unsafe-link.7z");
  fs.copyFileSync(archivePath, localArchivePath);
  await rejectWithoutChanges(localArchivePath, "org-393-7z-link");
});
