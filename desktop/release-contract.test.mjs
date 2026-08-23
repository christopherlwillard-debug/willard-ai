import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, getUpdateDecision, validateReleaseManifest } from "./release-contract.mjs";

const release = {
  version: "1.2.0",
  artifactUrl: "https://example.test/willard.zip",
  sha256: "a".repeat(64),
};

test("compares stable releases and prereleases safely", () => {
  assert.equal(compareVersions("1.2.0", "1.1.9"), 1);
  assert.equal(compareVersions("1.2.0-beta.1", "1.2.0"), -1);
  assert.equal(compareVersions("1.2.0", "1.2.0"), 0);
});

test("rejects incomplete or unsafe release descriptions", () => {
  assert.throws(() => validateReleaseManifest({ ...release, sha256: "bad" }), /checksum/);
  assert.throws(() => validateReleaseManifest({ ...release, artifactUrl: "file:///tmp/app.zip" }), /download address/);
});

test("only offers a newer verified release", () => {
  assert.equal(getUpdateDecision("1.1.0", release).available, true);
  assert.equal(getUpdateDecision("1.2.0", release).available, false);
});