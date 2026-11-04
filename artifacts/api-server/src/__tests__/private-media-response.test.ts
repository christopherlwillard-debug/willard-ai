import assert from "node:assert/strict";
import test from "node:test";
import {
  setMediaStreamContentHeaders,
  setPrivateMediaResponseHeaders,
} from "../lib/private-media-response.ts";

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

test("active document media is downloaded instead of rendered inline", () => {
  for (const mimeType of ["image/svg+xml", "text/html", "application/xhtml+xml", "text/xml"]) {
    const headers = new Map<string, string>();
    const contentType = setMediaStreamContentHeaders({
      setHeader(name, value) {
        headers.set(name.toLowerCase(), value);
      },
    }, mimeType);
    assert.equal(contentType, "application/octet-stream", mimeType);
    assert.equal(headers.get("content-disposition"), "attachment", mimeType);
  }
});

test("viewer-safe image, video, audio, and PDF formats remain inline", () => {
  for (const mimeType of ["image/jpeg", "image/png", "image/webp", "video/mp4", "audio/mpeg", "application/pdf"]) {
    const headers = new Map<string, string>();
    const contentType = setMediaStreamContentHeaders({
      setHeader(name, value) {
        headers.set(name.toLowerCase(), value);
      },
    }, mimeType);
    assert.equal(contentType, mimeType);
    assert.equal(headers.has("content-disposition"), false, mimeType);
  }
});
