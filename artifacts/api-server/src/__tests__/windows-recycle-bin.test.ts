import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createWindowsRecycleBinMover,
  WINDOWS_RECYCLE_BIN_TIMEOUT_MS,
  type WindowsRecycleBinInvocation,
} from "../lib/windows-recycle-bin.ts";

test("Recycle Bin invocation passes the path as environment data with bounded noninteractive execution", async () => {
  const targetPath = "C:\\Users\\Public\\O'Brien & family\\旅行.jpg";
  let captured: WindowsRecycleBinInvocation | undefined;
  const move = createWindowsRecycleBinMover(async (invocation) => {
    captured = invocation;
  });

  await move(targetPath);

  assert.ok(captured);
  assert.equal(captured.command, "powershell.exe");
  assert.ok(captured.args.includes("-NonInteractive"));
  assert.equal(captured.options.timeout, WINDOWS_RECYCLE_BIN_TIMEOUT_MS);
  assert.equal(captured.options.maxBuffer, 64 * 1024);
  assert.equal(captured.options.windowsHide, true);
  assert.equal(captured.options.env.WILLARD_CLEANUP_TARGET, targetPath);
  assert.doesNotMatch(captured.args.join(" "), /O'Brien|family|旅行/);
  assert.match(captured.args.at(-1) ?? "", /\$env:WILLARD_CLEANUP_TARGET/);
});

test("Recycle Bin failures preserve bounded actionable stderr", async () => {
  const move = createWindowsRecycleBinMover(async () => {
    throw Object.assign(new Error("PowerShell exited with code 1"), {
      stderr: "Access denied by the Recycle Bin provider",
    });
  });

  await assert.rejects(
    move("C:\\media\\photo.jpg"),
    /Access denied by the Recycle Bin provider/,
  );
});

test("Recycle Bin timeout is reported explicitly", async () => {
  const move = createWindowsRecycleBinMover(async () => {
    throw Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT" });
  });

  await assert.rejects(
    move("C:\\media\\photo.jpg"),
    new RegExp(`did not finish within ${WINDOWS_RECYCLE_BIN_TIMEOUT_MS} ms`),
  );
});

test("cleanup route awaits the asynchronous Recycle Bin helper and journals failures", () => {
  const routePath = fileURLToPath(new URL("../routes/cleanup.ts", import.meta.url));
  const source = readFileSync(routePath, "utf8");
  const branchStart = source.indexOf('if (process.platform === "win32")');
  const branchEnd = source.indexOf("} else {", branchStart);
  const windowsBranch = source.slice(branchStart, branchEnd);

  assert.ok(branchStart >= 0 && branchEnd > branchStart);
  assert.match(source, /import \{ sendToWindowsRecycleBin \} from "\.\.\/lib\/windows-recycle-bin\.ts"/);
  assert.match(windowsBranch, /await sendToWindowsRecycleBin\(filePath\)/);
  assert.match(windowsBranch, /status = 'FAILED'/);
  assert.match(windowsBranch, /status = 'FILESYSTEM_MOVED'/);
  assert.doesNotMatch(windowsBranch, /spawnSync/);
});
