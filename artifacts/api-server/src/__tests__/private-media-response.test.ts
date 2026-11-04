import assert from "node:assert/strict";
import test from "node:test";
import { setPrivateMediaResponseHeaders } from "../lib/private-media-response.ts";

test("private library media cannot be retained by shared caches", () => {
  const headers = new Map<string, string>();
  setPrivateMediaResponseHeaders({
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
  });
  assert.equal(headers.get("cache-control"), "private, no-store");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
});
