import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkService } from "./run-routed-workflows.mjs";

async function failingServer() {
  const server = createServer((_request, response) => {
    response.writeHead(503);
    response.end("not ready");
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}/healthz` };
}

test("includes the configured service log tail in readiness failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "routed-workflows-"));
  const logPath = join(directory, "api.log");
  await writeFile(logPath, "old detail\nlatest startup failure\n");

  const { server, url } = await failingServer();
  try {
    await assert.rejects(
      checkService("API server", url, 10, { logPaths: [logPath] }),
      (error) => {
        assert.match(error.message, /^API server readiness failed at /);
        assert.match(error.message, /\(HTTP 503\)\./);
        assert.match(
          error.message,
          /Startup output:\nold detail\nlatest startup failure/,
        );
        return true;
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("keeps readiness failures concise when logs are missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "routed-workflows-"));
  const missingLog = join(directory, "missing.log");
  const { server, url } = await failingServer();
  try {
    await assert.rejects(
      checkService("Web app", url, 10, { logPaths: [missingLog] }),
      (error) => {
        assert.equal(
          error.message,
          `Web app readiness failed at ${url} (HTTP 503).`,
        );
        return true;
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("keeps readiness failures concise when logs are empty", async () => {
  const directory = await mkdtemp(join(tmpdir(), "routed-workflows-"));
  const emptyLog = join(directory, "empty.log");
  await writeFile(emptyLog, "\n  \n");

  const { server, url } = await failingServer();
  try {
    await assert.rejects(
      checkService("API server", url, 10, { logPaths: [emptyLog] }),
      (error) => {
        assert.equal(
          error.message,
          `API server readiness failed at ${url} (HTTP 503).`,
        );
        return true;
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});