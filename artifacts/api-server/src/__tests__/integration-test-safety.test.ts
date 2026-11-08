import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  removeOwnedTempDirectory,
  requireDisposableAuditApiUrl,
  requireDisposableTestRoot,
  runCleanupSteps,
} from "./integration-test-safety.ts";

const ENVIRONMENT_KEYS = [
  "WILLARD_API_URL",
  "WILLARD_AUDIT_API_URL",
  "WILLARD_AUDIT_DATABASE_IS_DISPOSABLE",
  "WILLARD_AUDIT_DATABASE_URL",
  "WILLARD_TEST_ROOT",
  "DATABASE_URL",
];

function withAuditEnvironment(callback: () => void): void {
  const previous = new Map(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENVIRONMENT_KEYS) delete process.env[key];
    callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("integration tests require explicit local URLs for one disposable database and API", () => {
  withAuditEnvironment(() => {
    assert.throws(
      () => requireDisposableAuditApiUrl(),
      /WILLARD_API_URL is required/,
    );

    process.env["WILLARD_API_URL"] = "https://willard.example";
    process.env["WILLARD_AUDIT_DATABASE_IS_DISPOSABLE"] = "1";
    process.env["WILLARD_AUDIT_API_URL"] = "http://127.0.0.1:3000";
    process.env["DATABASE_URL"] = "postgresql://audit@127.0.0.1:5432/audit";
    process.env["WILLARD_AUDIT_DATABASE_URL"] = process.env["DATABASE_URL"];
    assert.throws(
      () => requireDisposableAuditApiUrl(),
      /WILLARD_API_URL must target a local service/,
    );

    process.env["WILLARD_API_URL"] = "http://127.0.0.1:3000";
    assert.equal(requireDisposableAuditApiUrl(), "http://127.0.0.1:3000");

    process.env["WILLARD_AUDIT_DATABASE_URL"] = "postgresql://audit@127.0.0.1:5433/audit";
    assert.throws(
      () => requireDisposableAuditApiUrl(),
      /same disposable PostgreSQL database/,
    );
  });
});

test("temporary directory cleanup removes only an owned child directory", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "willard-safety-parent-"));
  const owned = fs.mkdtempSync(path.join(parent, "willard-safety-owned-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "willard-safety-outside-"));
  const link = path.join(parent, "willard-safety-owned-link");
  try {
    assert.throws(
      () => removeOwnedTempDirectory("", parent, "willard-safety-owned-"),
      /requires a path/,
    );
    assert.throws(
      () => removeOwnedTempDirectory(outside, parent, "willard-safety-owned-"),
      /outside its approved parent/,
    );
    fs.symlinkSync(outside, link, "dir");
    assert.throws(
      () => removeOwnedTempDirectory(link, parent, "willard-safety-owned"),
      /not an owned real directory/,
    );
    assert.ok(fs.existsSync(outside), "an external directory must remain untouched");

    removeOwnedTempDirectory(owned, parent, "willard-safety-owned-");
    assert.ok(!fs.existsSync(owned), "the owned temporary directory should be removed");
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("disposable test roots must be real audit-owned children of the OS temp directory", () => {
  withAuditEnvironment(() => {
    assert.throws(
      () => requireDisposableTestRoot(),
      /WILLARD_TEST_ROOT is required/,
    );

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "willard-safety-outside-root-"));
    const auditRoot = fs.mkdtempSync(path.join(os.tmpdir(), "willard-backend-audit-safety-"));
    try {
      process.env["WILLARD_TEST_ROOT"] = outside;
      assert.throws(
        () => requireDisposableTestRoot(),
        /owned backend-audit temporary directory/,
      );

      process.env["WILLARD_TEST_ROOT"] = auditRoot;
      assert.equal(requireDisposableTestRoot(), fs.realpathSync(auditRoot));
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(auditRoot, { recursive: true, force: true });
    }
  });
});

test("cleanup attempts every step and reports failures together", async () => {
  const completed: string[] = [];
  await assert.rejects(
    runCleanupSteps("test fixture", [
      {
        name: "first",
        run: () => {
          completed.push("first");
          throw new Error("expected cleanup failure");
        },
      },
      {
        name: "second",
        run: () => {
          completed.push("second");
        },
      },
    ]),
    AggregateError,
  );
  assert.deepEqual(completed, ["first", "second"]);
});
