import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function source(relativeUrl: string): string {
  return readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), "utf8");
}

test("NAS media and private file routes stream from no-follow descriptors on Linux", () => {
  const media = source("../routes/media.ts");
  const faces = source("../routes/faces.ts");
  const settings = source("../routes/settings.ts");

  assert.match(media, /openRegularFileWithoutSymlinkTraversal\(nasPath, file\.relativePath\)/);
  assert.match(media, /stat = openedFile\.stat/);
  assert.match(media, /fd: openedFile\.fd/);
  assert.match(media, /openRegularFileWithoutSymlinkTraversal\(getWillardAIDir\(nasPath\), thumbPath\)/);
  assert.match(faces, /openRegularFileWithoutSymlinkTraversal\(getWillardAIDir\(nasPath\), safeCropPath\)/);
  assert.match(settings, /openRegularFileWithoutSymlinkTraversal\(getBrandingDir\(\), settings\.logoPath\)/);
});

test("private media, face, and branding file endpoints remain behind the session guard", () => {
  const app = source("../app.ts");
  const publicStart = app.indexOf("const PUBLIC_PATHS = new Set([");
  const publicEnd = app.indexOf("]);", publicStart);
  const guardStart = app.indexOf('app.use("/api", async');
  const protectedRouterMount = app.indexOf('app.use("/api", router)');
  const authCheck = app.indexOf("if (!sess?.authenticated)", guardStart);

  assert.ok(publicStart >= 0 && publicEnd > publicStart);
  const publicPaths = app.slice(publicStart, publicEnd);
  for (const privatePath of ["/media/file", "/media/thumbnail", "/faces/", "/settings/logo"]) {
    assert.ok(!publicPaths.includes(privatePath), `${privatePath} must not be public`);
  }
  assert.ok(guardStart >= 0 && authCheck > guardStart && protectedRouterMount > authCheck);
  assert.match(app.slice(authCheck, protectedRouterMount), /res\.status\(401\)\.json/);
});
