import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveApiProxyTarget, resolveStaticFile } from "./web-server-safety.mjs";
test("API proxy accepts only same-origin API paths", () => {
  assert.equal(resolveApiProxyTarget("/api/healthz?x=1", "http://127.0.0.1:8080").href, "http://127.0.0.1:8080/api/healthz?x=1");
  for (const value of ["//attacker.example/api/x", "http://attacker.example/api/x", "/other/path"]) assert.throws(() => resolveApiProxyTarget(value, "http://127.0.0.1:8080"));
});
test("static resolver blocks traversal and symlinks outside the web root", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "willard-web-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "willard-web-outside-"));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, "index.html"), "app");
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "secret.txt"));
  assert.equal(fs.readFileSync(resolveStaticFile(root, "/"), "utf8"), "app");
  assert.equal(resolveStaticFile(root, "/../secret.txt"), null);
  assert.equal(resolveStaticFile(root, "/secret.txt"), null);
});
