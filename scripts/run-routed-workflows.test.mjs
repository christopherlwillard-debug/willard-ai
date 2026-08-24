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
  const rotatedLogPath = join(directory, "api.log.1");
  const activeLogPath = join(directory, "api.log");
  await writeFile(
    rotatedLogPath,
    `${Array.from(
      { length: 12 },
      (_, index) => `old detail ${index} ${"x".repeat(300)}`,
    ).join("\n")}\n`,
  );
  await writeFile(activeLogPath, "active detail\nlatest startup failure\n");

  const { server, url } = await failingServer();
  try {
    await assert.rejects(
      checkService("API server", url, 10, {
        logPaths: [rotatedLogPath, activeLogPath],
      }),
      (error) => {
        assert.match(error.message, /^API server readiness failed at /);
        assert.match(error.message, /\(HTTP 503\)\./);
        assert.match(error.message, /old detail 6 /);
        assert.match(error.message, /old detail 11 /);
        assert.match(error.message, /active detail\nlatest startup failure/);
        assert.ok(error.message.length <= 2_200);
        return true;
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("includes both files from the default service log pair", async () => {
  const directory = await mkdtemp(join(tmpdir(), "routed-workflows-"));
  const outputLog = join(directory, "web.log");
  const errorLog = join(directory, "web-error.log");
  await writeFile(outputLog, "web startup\n");
  await writeFile(errorLog, "web bind failure\n");

  const { server, url } = await failingServer();
  try {
    await assert.rejects(
      checkService("Web app", url, 10, {
        logPaths: [outputLog, errorLog],
      }),
      (error) => {
        assert.match(error.message, /^Web app readiness failed at /);
        assert.match(error.message, /\(HTTP 503\)\./);
        assert.match(
          error.message,
          /Startup output:\nweb startup\nweb bind failure/,
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
