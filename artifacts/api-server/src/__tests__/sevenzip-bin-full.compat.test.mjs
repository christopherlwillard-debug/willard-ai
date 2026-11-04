import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSevenZipEntryInfo } from "../lib/archive-safety.ts";
import Seven from "node-7z";

const configuredBinaryPath = process.env.WILLARD_7ZIP_PATH;

test("official 7-Zip binary works with node-7z and archive safety metadata", {
  skip: !configuredBinaryPath ? "WILLARD_7ZIP_PATH must point to the verified official 7-Zip binary" : false,
}, async () => {
  const binaryPath = configuredBinaryPath;
  assert.equal(typeof binaryPath, "string");
  assert.ok(fs.existsSync(binaryPath), `7-Zip binary is missing: ${binaryPath}`);

  const versionResult = spawnSync(binaryPath, ["i"], { encoding: "utf8", timeout: 15_000 });
  assert.equal(versionResult.status, 0, versionResult.stderr || versionResult.error?.message);
  const versionText = `${versionResult.stdout}\n${versionResult.stderr}`;
  const version = versionText.match(/7-Zip(?: \(z\))? (\d+)\.(\d+)/);
  assert.ok(version, `Unable to read 7-Zip version from: ${versionText.slice(0, 500)}`);
  assert.ok(
    Number(version[1]) > 26 || (Number(version[1]) === 26 && Number(version[2]) >= 1),
    `7-Zip must be 26.01 or newer, found ${version[0]}`,
  );

  const routePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../routes/organize.ts",
  );
  const routeSource = fs.readFileSync(routePath, "utf8");
  assert.match(routeSource, /overwrite:\s*"a"/);
  assert.doesNotMatch(routeSource, /overwrite:\s*"qs"/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-7zip-official-"));
  try {
    fs.writeFileSync(path.join(root, "payload.txt"), "verified archive payload\n");
    const archive = path.join(root, "regular.7z");
    const create = spawnSync(binaryPath, ["a", archive, "payload.txt"], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(create.status, 0, create.stderr || create.stdout || create.error?.message);

    const listed = await new Promise((resolve, reject) => {
      const entries = [];
      const stream = Seven.list(archive, {
        $bin: binaryPath,
        $progress: false,
        techInfo: true,
      });
      stream.on("data", (entry) => {
        if (entry.file !== undefined) entries.push(entry);
      });
      stream.once("error", reject);
      stream.once("end", () => resolve(entries));
    });
    const payloadEntry = listed.find((entry) => entry.file === "payload.txt");
    assert.ok(payloadEntry, "node-7z did not report the regular archive entry");
    const payloadInfo = getSevenZipEntryInfo(payloadEntry);
    assert.equal(payloadInfo.isDirectory, false);
    assert.equal(payloadInfo.isLink, false);
    assert.equal(Number(payloadInfo.sizeBytes), Buffer.byteLength("verified archive payload\n"));
    assert.ok(payloadInfo.crc !== undefined, "node-7z did not expose technical CRC metadata");

    if (process.platform !== "win32") {
      fs.symlinkSync("payload.txt", path.join(root, "linked.txt"));
      const linkArchive = path.join(root, "link.7z");
      const linkCreate = spawnSync(binaryPath, ["a", "-snl", linkArchive, "linked.txt"], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(linkCreate.status, 0, linkCreate.stderr || linkCreate.stdout || linkCreate.error?.message);

      const linkEntries = await new Promise((resolve, reject) => {
        const entries = [];
        const stream = Seven.list(linkArchive, {
          $bin: binaryPath,
          $progress: false,
          techInfo: true,
        });
        stream.on("data", (entry) => {
          if (entry.file !== undefined) entries.push(entry);
        });
        stream.once("error", reject);
        stream.once("end", () => resolve(entries));
      });
      const linkEntry = linkEntries.find((entry) => entry.file === "linked.txt");
      assert.ok(linkEntry, "node-7z did not report the symlink archive entry");
      assert.equal(getSevenZipEntryInfo(linkEntry).isLink, true);
    }

    const destination = path.join(root, "extracted");
    await new Promise((resolve, reject) => {
      const stream = Seven.extractFull(archive, destination, {
        $bin: binaryPath,
        $progress: false,
        overwrite: "a",
      });
      stream.once("error", reject);
      stream.once("end", resolve);
    });
    assert.equal(
      fs.readFileSync(path.join(destination, "payload.txt"), "utf8"),
      "verified archive payload\n",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
