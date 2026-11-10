import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const mobileRequire = createRequire(
  new URL("../artifacts/willard-mobile/package.json", import.meta.url),
);
const expoCliEntry = mobileRequire.resolve("@expo/cli");
const expoCliRoot = path.resolve(path.dirname(expoCliEntry), "../..");
const {
  observeAnyFileChanges,
  observeFileChanges,
  waitForMetroToObserveTypeScriptFile,
} = mobileRequire(
  path.join(
    expoCliRoot,
    "build/src/start/server/metro/waitForMetroToObserveTypeScriptFile.js",
  ),
);
const { metroWatchTypeScriptFiles } = mobileRequire(
  path.join(
    expoCliRoot,
    "build/src/start/server/metro/metroWatchTypeScriptFiles.js",
  ),
);

function createRunner() {
  const watcher = new EventEmitter();
  const server = new EventEmitter();
  return {
    watcher,
    runner: {
      metro: {
        getBundler: () => ({
          getBundler: () => ({
            getWatcher: () => watcher,
          }),
        }),
      },
      server,
    },
  };
}

function createMetroChangeEvent() {
  return {
    rootDir: "/project",
    changes: {
      addedDirectories: new Set(["app/routes"]),
      removedDirectories: new Set(["old"]),
      addedFiles: new Map([
        ["app/routes/index.tsx", { isSymlink: false, modifiedTime: 1 }],
      ]),
      modifiedFiles: new Map([
        ["app.config.js", { isSymlink: false, modifiedTime: 2 }],
      ]),
      removedFiles: new Map([
        ["old.ts", { isSymlink: true, modifiedTime: 3 }],
      ]),
    },
  };
}

test("Expo watcher adapts Metro 0.83.8 change aggregates", () => {
  const { runner, watcher } = createRunner();
  let received;
  const off = observeAnyFileChanges(runner, (events) => {
    received = events;
  });

  watcher.emit("change", createMetroChangeEvent());
  off();

  assert.deepEqual(
    received.map(({ type }) => type),
    ["add", "add", "change", "delete", "delete"],
  );
  assert.deepEqual(
    received.map(({ filePath }) => filePath),
    [
      "/project/app/routes",
      "/project/app/routes/index.tsx",
      "/project/app.config.js",
      "/project/old.ts",
      "/project/old",
    ],
  );
  assert.equal(received[0].metadata.type, "d");
  assert.equal(received[1].metadata.type, "f");
  assert.equal(received[3].metadata.type, "l");
});

test("Expo TypeScript detection accepts Metro 0.83.8 added-file changes", () => {
  const { runner, watcher } = createRunner();
  let detected = false;
  const off = waitForMetroToObserveTypeScriptFile(
    "/project",
    runner,
    () => {
      detected = true;
      return Promise.resolve();
    },
  );

  watcher.emit("change", createMetroChangeEvent());
  off();

  assert.equal(detected, true);
});

test("Expo startup TypeScript watcher accepts Metro 0.83.8 change aggregates", () => {
  const { runner, watcher } = createRunner();
  const observed = [];
  const off = metroWatchTypeScriptFiles({
    metro: runner.metro,
    server: runner.server,
    projectRoot: "/project",
    callback: (event) => observed.push(event),
  });

  watcher.emit("change", createMetroChangeEvent());
  off();

  assert.deepEqual(
    observed.map(({ filePath, type }) => [filePath, type]),
    [
      ["/project/app/routes/index.tsx", "add"],
      ["/project/old.ts", "delete"],
    ],
  );
});

test("Expo file-change observation accepts Metro 0.83.8 modifications", () => {
  const { runner, watcher } = createRunner();
  let observed = false;
  const off = observeFileChanges(
    runner,
    ["/project/app.config.js"],
    () => {
      observed = true;
    },
  );

  watcher.emit("change", createMetroChangeEvent());
  off();

  assert.equal(observed, true);
});

test("Expo watcher preserves the Metro 0.83.3 eventsQueue format", () => {
  const { runner, watcher } = createRunner();
  let received;
  const off = observeAnyFileChanges(runner, (events) => {
    received = events;
  });
  const eventsQueue = [
    {
      type: "add",
      filePath: "/project/legacy.ts",
      metadata: { type: "f" },
    },
  ];

  watcher.emit("change", { eventsQueue });
  off();

  assert.equal(received, eventsQueue);
});
