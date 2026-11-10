/**
 * Standalone production server for Expo static builds.
 *
 * Serves the output of build.js (static-build/) with two special routes:
 * - GET / or /manifest with expo-platform header → platform manifest JSON
 * - GET / without expo-platform → landing page HTML
 * Everything else falls through to static file serving from ./static-build/.
 *
 * Zero external dependencies — uses only Node.js built-ins (http, fs, path).
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const STATIC_ROOT = path.resolve(__dirname, "..", "static-build");
const TEMPLATE_PATH = path.resolve(__dirname, "templates", "landing-page.html");
const basePath = (process.env.BASE_PATH || "/").replace(/\/+$/, "");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".map": "application/json",
};

function isPathWithinRoot(root, target) {
  const relativePath = path.relative(root, target);
  return relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath));
}

/**
 * Read only regular files whose canonical target remains under the static
 * build root. Open the canonical path with O_NOFOLLOW where the platform
 * supports it, then read through the descriptor so the final path component
 * cannot be swapped to a symlink after validation.
 */
function readStaticFileWithinRoot(rootPath, relativePath) {
  let canonicalRoot;
  try {
    canonicalRoot = fs.realpathSync(rootPath);
  } catch {
    return { status: "missing" };
  }

  const candidatePath = path.resolve(canonicalRoot, relativePath);
  if (!isPathWithinRoot(canonicalRoot, candidatePath)) {
    return { status: "forbidden" };
  }

  let canonicalTarget;
  try {
    canonicalTarget = fs.realpathSync(candidatePath);
  } catch {
    return { status: "missing" };
  }
  if (!isPathWithinRoot(canonicalRoot, canonicalTarget)) {
    return { status: "forbidden" };
  }

  let fileDescriptor;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    fileDescriptor = fs.openSync(canonicalTarget, flags);
    if (!fs.fstatSync(fileDescriptor).isFile()) {
      return { status: "missing" };
    }
    return { status: "ok", content: fs.readFileSync(fileDescriptor) };
  } catch (error) {
    if (error && error.code === "ELOOP") return { status: "forbidden" };
    return { status: "missing" };
  } finally {
    if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
  }
}

function getAppName() {
  try {
    const appJsonPath = path.resolve(__dirname, "..", "app.json");
    const appJson = JSON.parse(fs.readFileSync(appJsonPath, "utf-8"));
    return appJson.expo?.name || "App Landing Page";
  } catch {
    return "App Landing Page";
  }
}

function serveManifest(platform, res) {
  const manifest = readStaticFileWithinRoot(STATIC_ROOT, path.join(platform, "manifest.json"));
  if (manifest.status === "forbidden") {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }
  if (manifest.status !== "ok") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ error: `Manifest not found for platform: ${platform}` }),
    );
    return;
  }

  res.writeHead(200, {
    "content-type": "application/json",
    "expo-protocol-version": "1",
    "expo-sfv-version": "0",
  });
  res.end(manifest.content);
}

function serveLandingPage(req, res, landingPageTemplate, appName) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const protocol = forwardedProto || "https";
  const host = req.headers["x-forwarded-host"] || req.headers["host"];
  const baseUrl = `${protocol}://${host}`;
  // Include basePath so Expo Go resolves the manifest under the correct path.
  // e.g. exps://hostname/willard-mobile/ rather than exps://hostname
  const expsUrl = basePath ? `${host}${basePath}/` : `${host}/`;

  const html = landingPageTemplate
    .replace(/BASE_URL_PLACEHOLDER/g, baseUrl)
    .replace(/EXPS_URL_PLACEHOLDER/g, expsUrl)
    .replace(/APP_NAME_PLACEHOLDER/g, appName);

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function serveStaticFile(urlPath, res) {
  const safePath = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const file = readStaticFileWithinRoot(STATIC_ROOT, safePath);
  if (file.status === "forbidden") {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (file.status !== "ok") {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  const ext = path.extname(safePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  res.writeHead(200, { "content-type": contentType });
  res.end(file.content);
}

const landingPageTemplate = fs.readFileSync(TEMPLATE_PATH, "utf-8");
const appName = getAppName();

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  let pathname = url.pathname;

  if (basePath && pathname.startsWith(basePath)) {
    pathname = pathname.slice(basePath.length) || "/";
  }

  if (pathname === "/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (pathname === "/" || pathname === "/manifest") {
    const platform = req.headers["expo-platform"];
    if (platform === "ios" || platform === "android") {
      return serveManifest(platform, res);
    }

    if (pathname === "/") {
      return serveLandingPage(req, res, landingPageTemplate, appName);
    }
  }

  serveStaticFile(pathname, res);
});

const port = parseInt(process.env.PORT || "3000", 10);
if (require.main === module) {
  server.listen(port, "0.0.0.0", () => {
    console.log(`Serving static Expo build on port ${port}`);
  });
}

module.exports = { readStaticFileWithinRoot };
