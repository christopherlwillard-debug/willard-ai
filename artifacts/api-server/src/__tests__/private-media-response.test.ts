import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  setMediaStreamContentHeaders,
  setPrivateMediaResponseHeaders,
  handlePrivateMediaStreamError,
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

test("face crop responses use private no-store headers and handle stream failures", () => {
  const routePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../routes/faces.ts",
  );
  const routeSource = fs.readFileSync(routePath, "utf8");
  assert.match(routeSource, /setPrivateMediaResponseHeaders\(res\)/);
  assert.match(routeSource, /stream\.on\("error"/);
  assert.match(routeSource, /handlePrivateMediaStreamError\(res, streamError\)/);
});

test("branding logo stream failures are handled without an unhandled error", () => {
  const routePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../routes/settings.ts",
  );
  const routeSource = fs.readFileSync(routePath, "utf8");
  assert.match(routeSource, /const stream = fs\.createReadStream\(settings\.logoPath\)/);
  assert.match(routeSource, /stream\.on\("error", \(streamError\) =>/);
  assert.match(routeSource, /handlePrivateMediaStreamError\(res, streamError, "Logo file not found"\)/);
});

test("private media stream failures return 404 before headers and destroy after headers", () => {
  let statusCode = 0;
  let body: unknown;
  let destroyedWith: Error | undefined;
  const response = {
    headersSent: false,
    status(code: number) {
      statusCode = code;
      return { json(value: unknown) { body = value; } };
    },
    destroy(error?: Error) { destroyedWith = error; },
  };
  const missing = Object.assign(new Error("file disappeared"), { code: "ENOENT" });
  handlePrivateMediaStreamError(response, missing);
  assert.equal(statusCode, 404);
  assert.deepEqual(body, { error: "Media file not found" });
  assert.equal(destroyedWith, undefined);

  response.headersSent = false;
  handlePrivateMediaStreamError(response, missing, "Logo file not found");
  assert.equal(statusCode, 404);
  assert.deepEqual(body, { error: "Logo file not found" });

  response.headersSent = false;
  const unreadable = Object.assign(new Error("permission denied"), { code: "EACCES" });
  handlePrivateMediaStreamError(response, unreadable);
  assert.equal(statusCode, 500);
  assert.deepEqual(body, { error: "File stream failed" });

  response.headersSent = true;
  handlePrivateMediaStreamError(response, missing);
  assert.equal(destroyedWith, missing);
});
