import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAllowedDesktopRequestHost, resolveApiProxyTarget, resolveStaticFile } from "./web-server-safety.mjs";
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

import { parseDesktopRequestUrl, staticFileReadErrorStatus } from "./web-server-safety.mjs";

test("desktop request URL parsing rejects malformed URLs and path encodings", () => {
  assert.throws(() => parseDesktopRequestUrl("http://["));
  assert.throws(() => parseDesktopRequestUrl("/%E0%A4%A"));
  assert.equal(parseDesktopRequestUrl("/api/healthz?x=1").pathname, "/api/healthz");
});

test("static file errors distinguish missing assets from server-side read failures", () => {
  assert.equal(staticFileReadErrorStatus({ code: "ENOENT" }), 404);
  assert.equal(staticFileReadErrorStatus({ code: "ENOTDIR" }), 404);
  assert.equal(staticFileReadErrorStatus({ code: "EACCES" }), 500);
  assert.equal(staticFileReadErrorStatus({ code: "EIO" }), 500);
});


test("desktop service accepts only its loopback Host and same-origin browser requests", () => {
  assert.equal(isAllowedDesktopRequestHost("127.0.0.1:5000", undefined, 5000), true);
  assert.equal(isAllowedDesktopRequestHost("localhost:5000", "http://localhost:5000", 5000), true);
  assert.equal(isAllowedDesktopRequestHost("127.0.0.1:5000", "http://127.0.0.1:5000", 5000), true);
  assert.equal(isAllowedDesktopRequestHost("127.0.0.1:5000", undefined, 5000, "same-origin"), true);
  assert.equal(isAllowedDesktopRequestHost("127.0.0.1:5000", undefined, 5000, "cross-site"), false);
  for (const [host, origin] of [
    ["attacker.example:5000", "http://attacker.example:5000"],
    ["127.0.0.1:5000", "http://attacker.example"],
    ["localhost:5000", "https://localhost:5000"],
    ["127.0.0.1:5001", "http://127.0.0.1:5001"],
    ["127.0.0.1:5000", "null"],
    ["127.0.0.1:5000", "not-a-url"],
  ]) {
    assert.equal(isAllowedDesktopRequestHost(host, origin, 5000), false, `${host} / ${origin}`);
  }
});

test("desktop web server validates Host and Origin before routing or proxying", () => {
  const source = fs.readFileSync(new URL("./desktop-web-server.mjs", import.meta.url), "utf8");
  const guard = source.indexOf("isAllowedDesktopRequestHost(request.headers.host, request.headers.origin, port, request.headers[\"sec-fetch-site\"])");
  const apiRoute = source.indexOf('parsedRequest.pathname.startsWith("/api/")');
  assert.ok(guard >= 0 && apiRoute > guard, "untrusted hosts must be rejected before API proxy routing");
});
