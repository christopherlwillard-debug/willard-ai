import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { findExecutable } from "./find-executable.mjs";

test("Windows executable discovery finds PostgreSQL .exe files in PATH", () => {
  const binDirectory = "C:\\Program Files\\PostgreSQL\\16\\bin";
  const otherDirectory = "D:\\tools";
  const available = new Set([
    path.win32.join(binDirectory, "initdb.exe"),
    path.win32.join(binDirectory, "pg_ctl.exe"),
    path.win32.join(otherDirectory, "createdb.exe"),
    path.win32.join(otherDirectory, "psql.exe"),
  ]);

  for (const name of ["initdb", "pg_ctl", "createdb", "psql"]) {
    const expected = available.has(path.win32.join(binDirectory, `${name}.exe`))
      ? path.win32.join(binDirectory, `${name}.exe`)
      : path.win32.join(otherDirectory, `${name}.exe`);
    assert.equal(
      findExecutable(name, {
        platform: "win32",
        pathValue: `${binDirectory};${otherDirectory}`,
        fileExists: (candidate) => available.has(candidate),
      }),
      expected,
    );
  }
});

test("Windows executable discovery keeps the original name as its first choice", () => {
  const binDirectory = "C:\\tools";
  const available = new Set([
    path.win32.join(binDirectory, "initdb"),
    path.win32.join(binDirectory, "initdb.exe"),
  ]);

  assert.equal(
    findExecutable("initdb", {
      platform: "win32",
      pathValue: binDirectory,
      fileExists: (candidate) => available.has(candidate),
    }),
    path.win32.join(binDirectory, "initdb"),
  );
});

test("POSIX executable discovery keeps extensionless PATH lookup", () => {
  const binDirectory = "/usr/local/pgsql/bin";
  const candidate = path.join(binDirectory, "initdb");

  assert.equal(
    findExecutable("initdb", {
      platform: "linux",
      pathValue: `${binDirectory}:${path.join("/usr/bin", "unused")}`,
      fileExists: (pathName) => pathName === candidate,
    }),
    candidate,
  );
});

test("missing executable discovery preserves the existing error message", () => {
  assert.throws(
    () => findExecutable("initdb", {
      platform: "win32",
      pathValue: "C:\\tools",
      fileExists: () => false,
    }),
    {
      message: "Required local test executable was not found: initdb",
    },
  );
});
